#!/usr/bin/env bash
# Builds the L1 contracts and (re)generates the Solidity verifiers under src/generated/
# (the three refund verifiers + the resolver verifier). ResolverVerifier.sol is untracked build output; what the
# Resolver module deploys is the committed src/pinned/PinnedResolverVerifier.sol, rewritten only by
# noir-projects/resolver_circuit/repin.sh.
#
# Usage:
#   ./bootstrap.sh                  # deps + generate + build (default)
#   ./bootstrap.sh build            # aztec-forge build only
#   ./bootstrap.sh deps             # submodule init + yarn install only
#   ./bootstrap.sh generate         # regenerate src/generated/*Verifier.sol only
#   ./bootstrap.sh format           # `aztec-forge fmt` — apply the [fmt] config in foundry.toml
#   ./bootstrap.sh format --check   # `aztec-forge fmt --check` — exits non-zero if anything is unformatted
#   ./bootstrap.sh lint             # solhint-plugin-oxide self-test, then `solhint` — the rules in .solhint.json
#   ./bootstrap.sh test             # `aztec-forge test` — runs every Solidity test under test/
#   ./bootstrap.sh clean            # `git clean -ffdx .` — nuke every untracked path under l1-contracts/
#   ./bootstrap.sh clean-lite       # remove forge artifacts + generated verifiers (no git, no submodules)
set -euo pipefail

cd "$(dirname "$0")"

ROOT="$(cd .. && pwd)"
NM="$PWD/node_modules"

# shellcheck source=../aztec-toolchain.sh
source "$ROOT/aztec-toolchain.sh"

# build / generate / test all resolve sources from node_modules (@aztec/l1-artifacts, @oz5)
# and shell out to bb (@aztec/bb.js). When a caller runs one of those directly (e.g. CI's
# per-toolchain jobs) without `deps` first, install on demand. Idempotent: a no-op once populated.
ensure_node_modules() {
  [ -d "$NM/@aztec/l1-artifacts" ] || { echo "==> yarn install (node_modules missing)"; yarn install; }
}

deps() {
  # The nitro-validator submodule provides the @nitro-validator/* primitives the forked CertManager /
  # NitroValidator import, and its nested solidity-lib provides @solarity/*. --recursive pulls the nest.
  echo "==> git submodule update --init --recursive lib/nitro-validator"
  git submodule update --init --recursive lib/nitro-validator

  # @aztec/l1-artifacts (Solidity sources + transitive OZ/forge-std), @openzeppelin/contracts (the
  # audited WebAuthn the registry uses), and @aztec/bb.js (provides ./node_modules/.bin/bb) are declared
  # in package.json. yarn short-circuits warm runs and re-resolves when package.json / yarn.lock drift. CI sets
  # NODE_MODULES_CACHE_HIT when it restored node_modules from a cache keyed on every manifest and lockfile.
  if [ "${NODE_MODULES_CACHE_HIT:-false}" = "true" ]; then
    echo "==> yarn install skipped (node_modules restored from an exact cache hit)"
    return
  fi
  echo "==> yarn install (populating node_modules for @aztec/l1-artifacts + bb + @oz5)"
  yarn install
}

build() {
  ensure_node_modules
  require_aztec_toolchain aztec-forge
  echo "==> aztec-forge build"
  # Verifier contracts are too close to the EIP-170 runtime cap so we use the `--sizes` arg here to make compilation
  # fail if we hit the limit.
  aztec-forge build --sizes
}

# Generates a Solidity verifier for one circuit from the vk produced by `noir-projects/bootstrap.sh`. Args:
#   $1 - vk path (under noir-projects/<pkg>/target/keys/vk)
#   $2 - output Solidity path (under src/generated/)
#   $3 - human-readable label used in echoes
#   $4 - extra bb flags (the refund verifiers pass --disable_zk; the resolver verifier keeps zk on)
#
# Each generated file is fully self-contained (its own libraries + abstract BaseHonkVerifier + concrete
# `HonkVerifier` contract). The `HonkVerifier` exposes `verify(bytes proof, bytes32[] publicInputs) -> bool`
# — the @aztec IVerifier the portal (refund routes) and the registry (resolver) are wired against.
generate_verifier() {
  local VK="$1"
  local OUT="$2"
  local LABEL="$3"
  local EXTRA="${4:-}"
  local BB="${BB:-$NM/.bin/bb}"

  test -x "$BB" || { echo "bb not found at $BB; run 'yarn install' in l1-contracts/ first" >&2; exit 1; }

  if [ ! -f "$VK" ]; then
    echo "Error: vk not found at $VK." >&2
    echo "Run noir-projects/bootstrap.sh first to produce the $LABEL vk." >&2
    exit 1
  fi

  mkdir -p "$(dirname "$OUT")"

  # --scheme ultra_honk matches the scheme used to write the vk. The refund routes pass --disable_zk
  # (no need to hide the proof on-chain; dropping zk shrinks the proof and gas).
  echo "==> Generating $LABEL ($OUT)"
  "$BB" write_solidity_verifier --scheme ultra_honk $EXTRA -k "$VK" -o "$OUT"

  echo "Wrote $OUT"
}

generate() {
  ensure_node_modules
  # Regenerate the TS + Solidity mirrors of constants.nr
  echo "==> Generating shared constants (OxideConstants.gen.sol + oxide_constants.gen.ts)"
  node "$ROOT/yarn-project/oxide-lib/scripts/gen_constants.mjs"
  generate_verifier \
    "${FROZEN_NOTES_REFUND_VK:-$ROOT/noir-projects/frozen_notes_refund/target/keys/vk}" \
    src/generated/FrozenNotesRefundVerifier.sol \
    FrozenNotesRefundVerifier --disable_zk
  generate_verifier \
    "${FROZEN_DEPOSIT_REFUND_VK:-$ROOT/noir-projects/frozen_deposit_refund/target/keys/vk}" \
    src/generated/FrozenDepositRefundVerifier.sol \
    FrozenDepositRefundVerifier --disable_zk
  generate_verifier \
    "${UNPROCESSED_DEPOSIT_REFUND_VK:-$ROOT/noir-projects/unprocessed_deposit_refund/target/keys/vk}" \
    src/generated/UnprocessedDepositRefundVerifier.sol \
    UnprocessedDepositRefundVerifier --disable_zk
  generate_verifier \
    "${RESOLVER_VK:-$ROOT/noir-projects/resolver_circuit/target/keys/vk}" \
    src/generated/ResolverVerifier.sol \
    ResolverVerifier
}

# Runs `aztec-forge fmt` against this package. The `[fmt]` block in `foundry.toml` (2-space indent,
# 120-char wrap, ignore `**/generated/**/*.sol`) is what governs the output. Pass `--check` to
# fail without writing — the same shape `yarn-project/bootstrap.sh format` exposes for CI.
format() {
  require_aztec_toolchain aztec-forge
  if [ "${1:-}" = "--check" ]; then
    echo "==> aztec-forge fmt --check"
    aztec-forge fmt --check
  else
    echo "==> aztec-forge fmt"
    aztec-forge fmt
  fi
}

# The self-test detects rules that no longer reject violations.
lint() {
  ensure_node_modules
  echo "==> solhint-plugin-oxide self-test"
  node solhint-plugin-oxide/test.js
  echo "==> solhint"
  ./node_modules/.bin/solhint --disc '{src,script,test}/**/*.sol'
}

# Runs the full Solidity test suite. `aztec-forge test` resolves test paths via foundry.toml.
test_cmd() {
  ensure_node_modules
  require_aztec_toolchain aztec-forge
  echo "==> aztec-forge test"
  aztec-forge test "$@"
}

clean_lite() {
  echo "==> Cleaning forge artifacts + generated verifiers"
  rm -rf out cache src/generated
}

clean() {
  echo "==> git clean -ffdx . (untracked + ignored, scoped to l1-contracts/)"
  git clean -ffdx .
}

cmd="${1:-all}"
shift || true

case "$cmd" in
  all)        deps; generate; build ;;
  deps)       deps ;;
  build)      build ;;
  generate)   generate ;;
  format)     format "$@" ;;
  lint)       lint ;;
  test)       test_cmd "$@" ;;
  clean)      clean ;;
  clean-lite) clean_lite ;;
  *)
    echo "Unknown target: $cmd" >&2
    echo "Usage: $0 [all|deps|build|generate|format [--check]|lint|test|clean|clean-lite]" >&2
    exit 1
    ;;
esac
