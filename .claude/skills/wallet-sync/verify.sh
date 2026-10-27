#!/usr/bin/env bash
# Runs the release-desktop.yml build in a fresh clone of one local branch, then the checks that CI does not do:
# the v5 archive node in the bundle, the class IDs against the live profile, the refund circuits against their
# L1 verifiers, and a clean tree. It builds only the Linux installer.
#
# Usage: verify.sh BRANCH WORK_DIR
#
# Environment:
#   AZTEC_DIR                The Aztec installation to use. Default: ~/.aztec/current.
#   SOURCE_GENERATIONS_REPO  The repository whose releases fetch:bundle reads.
#                            Default: this repository's origin.
#   V5_ARCHIVE_NODE_URL      The v5 node with all historical state. Default: the mainnet v5 archive node.
#   TESTS                    1 also builds the relayer and runs the typecheck and the tests of each package.
#                            0 does not. Default: 1.
#
# Needs nvm with Node.js 24.15 or later and Node.js 22, Foundry, jq, and gh with a token that can read the release.
# The summary is in WORK_DIR/logs/summary.log. Each step writes WORK_DIR/logs/<step>.log.
set -uo pipefail

BRANCH=${1:?Usage: verify.sh BRANCH WORK_DIR}
OUT=$(mkdir -p "${2:?Usage: verify.sh BRANCH WORK_DIR}" && cd "$2" && pwd)
SKILL_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$SKILL_DIR" rev-parse --show-toplevel)
PROFILE_URL=https://cdn.zk.money/profiles/v6/current.json
AZTEC_DIR=${AZTEC_DIR:-$HOME/.aztec/current}
V5_ARCHIVE_NODE_URL=${V5_ARCHIVE_NODE_URL:-https://mainnet-v5-archive.rpc2.aztec-labs.com}
TESTS=${TESTS:-1}
SOURCE_GENERATIONS_REPO=${SOURCE_GENERATIONS_REPO:-$(cd "$REPO" && gh repo view --json nameWithOwner --jq .nameWithOwner)}
W=$OUT/clone
L=$OUT/logs
SUM=$L/summary.log
[[ ! -e "$W" ]] || { echo "ERROR: $W exists. Use a new WORK_DIR." >&2; exit 1; }
mkdir -p "$L" "$OUT/bin"
: >"$SUM"

step() {
  local name=$1 t0=$SECONDS rc
  shift
  "$@" >"$L/$name.log" 2>&1
  rc=$?
  echo "$name exit=$rc ($((SECONDS - t0))s)" | tee -a "$SUM"
  return $rc
}

# shellcheck disable=SC1091
source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null

# Job "bundle": Node.js 24, because the Aztec 6.0.0 installer needs 24.15 or later.
nvm use 24 >/dev/null || exit 1
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 24 || (a === 24 && b >= 15) ? 0 : 1)' ||
  { echo "ERROR: the bundle job needs Node.js 24.15 or later, found $(node --version)" >&2; exit 1; }
corepack enable --install-directory "$OUT/bin"
export PATH="$OUT/bin:$HOME/.aztec/bin:$AZTEC_DIR/bin:$AZTEC_DIR/node_modules/.bin:$AZTEC_DIR/internal-bin:$PATH"
WANT_AZTEC=$(git -C "$REPO" show "$BRANCH:.github/workflows/release-desktop.yml" | sed -n 's/^ *AZTEC_VERSION: *//p')
HAVE_AZTEC=$(aztec --version 2>&1 | tail -1)
[[ "$HAVE_AZTEC" == "$WANT_AZTEC" ]] ||
  { echo "ERROR: release-desktop.yml uses Aztec $WANT_AZTEC, AZTEC_DIR has $HAVE_AZTEC" >&2; exit 1; }
echo "node $(node --version), pnpm $(pnpm --version), aztec $HAVE_AZTEC" >>"$SUM"

step clone git clone --branch "$BRANCH" "$REPO" "$W" || exit 1
cd "$W" || exit 1
echo "HEAD $(git rev-parse --short HEAD)" >>"$SUM"
step install pnpm install --frozen-lockfile || exit 1
step contracts pnpm build-contracts || exit 1
OXIDE_REFUND_CIRCUITS=required step web-deps pnpm build:web-deps || exit 1
GH_TOKEN=$(gh auth token) GH_REPO=$SOURCE_GENERATIONS_REPO \
  step fetch-bundle pnpm --filter @obsidion/generation-v5 fetch:bundle || exit 1
step check-bundle pnpm --filter @obsidion/generation-v5 check:bundle || exit 1

PROFILE=$(curl -fsS -m 20 "$PROFILE_URL") || { echo "ERROR: cannot read $PROFILE_URL" >&2; exit 1; }
echo "profile $(jq -r '.current + " " + .versions[.current].gitSha' <<<"$PROFILE")" >>"$SUM"
VITE_NODE_URL=$(jq -r '.versions[.current].nodeUrl' <<<"$PROFILE") \
  VITE_L1_RPC_URL=$(jq -r '.versions[.current].l1RpcUrl' <<<"$PROFILE") \
  VITE_V5_ARCHIVE_NODE_URL=$V5_ARCHIVE_NODE_URL \
  ENV_FILE=$W/packages/web-wallet-desktop/config/mainnet.env.example \
  SKIP_MONOREPO_BUILD=1 REQUIRE_SOURCE_GENERATIONS=true \
  step bundle ./packages/web-wallet-desktop/scripts/build-web.sh || exit 1
step assert-target node scripts/passkeys/assert-target.mjs packages/web-wallet-desktop/web production --live || exit 1

# Checks that CI does not do.
step archive-node grep -rlF "$V5_ARCHIVE_NODE_URL" packages/web-wallet-desktop/web/assets
step classids node "$SKILL_DIR/classids.mjs" "$W" "$PROFILE_URL"
step circuits pnpm build:oxide-circuits
grep -E ' matches ' "$L/circuits.log" >>"$SUM"
if [[ "$TESTS" == 1 ]]; then
  step relayer pnpm build:relayer
  step relayer-help node vendor/oxide/yarn-project/oxide-relayer/dest/bin/oxide-relayer.js run --help
  # packages/web-wallet-desktop is not a workspace member. The installers row tests it.
  for dir in packages/*/; do
    grep -qxF "  - ${dir%/}" pnpm-workspace.yaml || continue
    name=$(jq -r .name "$dir/package.json")
    for script in typecheck test; do
      jq -e --arg s "$script" '.scripts[$s]' "$dir/package.json" >/dev/null 2>&1 &&
        TZ=UTC step "$script-$(basename "$dir")" pnpm --filter "$name" "$script"
    done
  done
  for dir in vendor/oxide/yarn-project/oxide-relayer vendor/oxide/yarn-project/experiments; do
    (cd "$dir" && NODE_NO_WARNINGS=1 step "test-$(basename "$dir")" node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand)
  done
fi
echo "untracked after the bundle job: $(git status --porcelain | wc -l)" >>"$SUM"
git status --porcelain | head -20 >>"$SUM"

# Job "installers", Linux row: Node.js 22.
nvm use 22 >/dev/null || exit 1
echo "installers: node $(node --version)" >>"$SUM"
cd packages/web-wallet-desktop || exit 1
step npm-ci npm ci || exit 1
step check-test bash -c 'npm run check && TZ=UTC npm test' || exit 1
step compose node scripts/compose-config.js || exit 1
VERSION="$(node -p "require('./package.json').version")-$(git rev-parse --short HEAD)"
step appimage npx electron-builder --linux AppImage --x64 --publish never -c.extraMetadata.version="$VERSION" || exit 1
ls -la dist/*.AppImage >>"$SUM" 2>&1
cd "$W" || exit 1
echo "untracked at the end: $(git status --porcelain | wc -l)" >>"$SUM"
echo "verify done" >>"$SUM"
