#!/usr/bin/env bash
# Builds the web wallet with the desktop network target baked in and copies the
# result to web/ for the Electron launcher. Mirrors the deploy workflow
# (.github/workflows/deploy-web-wallet.yml): same build chain, same env keys,
# same presence guard on the baked values.
#
# Env compose: config/desktop.env supplies the committed defaults; values already
# set in the shell win. The keyed RPC URLs (VITE_NODE_URL, VITE_L1_RPC_URL) and the node
# API key (VITE_NODE_API_KEY, needed only for a gateway-fronted node) are secrets —
# export them, or keep them in a local uncommitted copy.
#
#   VITE_NODE_URL=… VITE_L1_RPC_URL=… ./scripts/build-web.sh
#   SKIP_MONOREPO_BUILD=1 …   # skip contracts/config-client/front-core; just bake + vite build + copy
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(git -C "$PKG_DIR" rev-parse --show-toplevel)"
WALLET_DIR="$REPO_ROOT/packages/web-wallet"
ENV_FILE="${ENV_FILE:-$PKG_DIR/config/desktop.env}"

if [[ -f "$ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
    key="${line%%=*}"; val="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ -z "$key" ]] && continue
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    if [[ -z "${!key:-}" ]]; then export "$key=$val"; fi
  done < "$ENV_FILE"
fi

# VITE_ACCOUNT_SERVICE_URL is optional: empty keeps the wallet's relative /svc/account
# default, which the local server proxies (config/default.json).
REQUIRED_KEYS=(VITE_NETWORK VITE_NODE_URL VITE_L1_RPC_URL VITE_CONFIG_PROFILE_URL
  VITE_CONFIG_EXPECTED_PROFILE_ID VITE_PASSKEY_ENVIRONMENT DESKTOP_PAGE_HOSTNAME)
for key in "${REQUIRED_KEYS[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    echo "ERROR: $key is unset or empty — export it or fill $ENV_FILE" >&2
    exit 1
  fi
done

export VITE_APP_VERSION="${VITE_APP_VERSION:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)-desktop}"

if [[ ! -f "$REPO_ROOT/vendor/oxide/yarn-project/oxide-lib/package.json" ]]; then
  echo "ERROR: vendor/oxide submodule is not initialized. Run:" >&2
  echo "  git -C $REPO_ROOT submodule update --init --recursive vendor/oxide" >&2
  exit 1
fi

if [[ -z "${SKIP_MONOREPO_BUILD:-}" ]]; then
  (cd "$REPO_ROOT" && pnpm install --frozen-lockfile)

  if compgen -G "$REPO_ROOT/packages/contracts/src/artifacts/target/*/*.json" > /dev/null; then
    echo "Contract artifacts present — skipping pnpm build-contracts"
  else
    (cd "$REPO_ROOT" && pnpm build-contracts)
  fi

  (cd "$REPO_ROOT" && pnpm build:web-deps)
fi

# Bake the network target. Written (and removed again below) rather than passed as
# shell env so the vite build reads exactly what the deploy workflow would.
BAKE_KEYS=("${REQUIRED_KEYS[@]}" VITE_APP_VERSION)
# Optional keys, baked only when set — mirrors deploy-web-wallet.yml's optional block.
for optional in VITE_ACCOUNT_SERVICE_URL VITE_ZKMONEY_API_URL VITE_GOOGLE_CLIENT_ID \
                VITE_NODE_API_KEY VITE_PASSKEY_RP_ID VITE_CAMPAIGN_URL \
                VITE_PREDICATE_VERIFICATION_HASH VITE_PREDICATE_CHAIN VITE_PREDICATE_DISABLED; do
  [[ -n "${!optional:-}" ]] && BAKE_KEYS+=("$optional")
done
: > "$WALLET_DIR/.env.production"
for key in "${BAKE_KEYS[@]}"; do
  printf '%s=%s\n' "$key" "${!key}" >> "$WALLET_DIR/.env.production"
done

cleanup() { rm -f "$WALLET_DIR/.env.production"; }
trap cleanup EXIT

(cd "$WALLET_DIR" && pnpm build)

for key in VITE_NODE_URL VITE_L1_RPC_URL VITE_NODE_API_KEY; do
  # An unset optional greps trivially (empty needle), so this only asserts provided values.
  if ! grep -rqF "${!key:-}" "$WALLET_DIR/dist"; then
    echo "ERROR: $key missing from the built bundle — the build never read .env.production" >&2
    exit 1
  fi
done
for asset in sqlite3.wasm sqlite3-opfs-async-proxy.js; do
  if [[ ! -f "$WALLET_DIR/dist/assets/$asset" ]]; then
    echo "ERROR: expected unhashed asset dist/assets/$asset is missing (sqliteRuntimeAssets plugin)" >&2
    exit 1
  fi
done
# The launcher injects runtime endpoint overrides right after <head> — a bundle
# without that literal tag would silently ship with injection disabled.
if ! grep -q "<head>" "$WALLET_DIR/dist/index.html"; then
  echo "ERROR: dist/index.html has no <head> tag — the desktop endpoint injection would not apply" >&2
  exit 1
fi

rsync -a --delete "$WALLET_DIR/dist/" "$PKG_DIR/web/"
echo "Wallet bundle copied to $PKG_DIR/web ($(du -sh "$PKG_DIR/web" | cut -f1))"

# Build provenance for the settings page, plus the baked endpoints so the launcher's
# startup probe knows what to check (both are already public inside the JS bundle).
node "$PKG_DIR/scripts/write-build-meta.mjs"
node "$PKG_DIR/scripts/compose-config.js"
