#!/usr/bin/env bash
# Local L1 dependency, verifier, contract, format, lint, and test commands.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"

# shellcheck source=../aztec-toolchain.sh
source "$ROOT/aztec-toolchain.sh"

deps() {
  # The current branch pins nitro-validator and solidity-lib under .deps.
  # Its existing setup command also installs this package with Yarn.
  (cd "$ROOT" && corepack yarn install --immutable && corepack yarn deploy:build && corepack yarn deploy setup_l1_dependencies)
  (cd "$ROOT/yarn-project" && corepack yarn install --immutable)
}

ensure_deps() {
  if [ ! -f node_modules/@aztec/l1-artifacts/package.json ] ||
     [ ! -f .deps/nitro-validator/src/NitroValidator.sol ] ||
     [ ! -f .deps/solidity-lib/contracts/libs/crypto/ECDSA384.sol ]; then
    deps
  fi
}

build() {
  ensure_deps
  require_aztec_toolchain aztec-forge
  aztec-forge build --sizes
}

generate() {
  ensure_deps
  require_aztec_toolchain aztec-bb
  [ -d "$ROOT/yarn-project/node_modules/@aztec/foundation" ] ||
    (cd "$ROOT/yarn-project" && corepack yarn install --immutable)
  node "$ROOT/yarn-project/oxide-lib/scripts/gen_constants.mjs"

  # Current deployment tooling reproduces the committed refund verifiers under
  # dist/refund_verifiers and checks their bytes without changing tracked sources.
  (cd "$ROOT" && corepack yarn deploy:build && corepack yarn deploy build_refund_verifiers)

  # This build-local verifier is separate from the deployed pinned resolver verifier.
  local vk="$ROOT/noir-projects/resolver_circuit/target/keys/vk"
  [ -f "$vk" ] || { echo "Missing resolver vk; run noir-projects/bootstrap.sh first" >&2; return 1; }
  aztec-bb write_solidity_verifier -k "$vk" -o src/generated/ResolverVerifier.sol -t evm
}

format() {
  require_aztec_toolchain aztec-forge
  if [ "${1:-}" = --check ]; then
    aztec-forge fmt --check
  else
    aztec-forge fmt
  fi
}

lint() {
  ensure_deps
  node solhint-plugin-oxide/test.js
  ./node_modules/.bin/solhint --disc '{src,test}/**/*.sol'
}

test_cmd() {
  ensure_deps
  require_aztec_toolchain aztec-forge
  aztec-forge test "$@"
}

# Only remove ignored build artifacts; src/generated contains committed files.
clean_lite() {
  rm -rf .cache "$ROOT/dist/l1_contracts/artifacts" "$ROOT/dist/refund_verifiers"
  rm -f src/generated/ResolverVerifier.sol
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
  clean|clean-lite) clean_lite ;;
  *)
    echo "Usage: $0 [all|deps|build|generate|format [--check]|lint|test|clean|clean-lite]" >&2
    exit 1
    ;;
esac
