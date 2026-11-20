#!/usr/bin/env bash
# Pins the resolver circuit's build artifacts. The deployed Resolver module holds an immutable verifier, so proof
# generation and deployment must keep using the exact circuit + vk + verifier that Resolver module was deployed with,
# independent of what the current toolchain builds. The committed pin:
#   pinned/resolver_circuit.json                         — compiled circuit (abi + bytecode; debug stub for noir-execute)
#   pinned/vk                                            — EVM-targeted UltraHonk keccak vk
#   l1-contracts/src/pinned/PinnedResolverVerifier.sol   — Solidity verifier emitted from that vk
#
# The regular build keeps producing fresh (untracked) artifacts under target/ and
# l1-contracts/src/generated/ResolverVerifier.sol; consumers — @oxide/resolver-proof and the Resolver module deploy flow —
# read only the pin. Repinning copies the freshly built artifacts over the pin. A new Resolver module is needed only when
# pinned/vk (and so the verifier) changes: every circuit change does that, a compiler change can leave the vk as it is.
#
# Usage:
#   ./repin.sh          # replace the pin with the artifacts the current tree last built
#   ./repin.sh --check  # verify the pin reproduces with @oxide/resolver-proof's @aztec-foundation/bb.js (CI); writes nothing
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(cd ../.. && pwd)"
PKG=resolver_circuit
PINNED="$PWD/pinned"
BUILT_VERIFIER="$ROOT/l1-contracts/src/generated/ResolverVerifier.sol"
PINNED_VERIFIER="$ROOT/l1-contracts/src/pinned/PinnedResolverVerifier.sol"

# bb comes from @oxide/resolver-proof's @aztec-foundation/bb.js dependency — the version that proves at runtime — so a pin
# that passes `--check` is guaranteed to match the prover. bb.js's exports map hides package.json, so resolve the
# main entry and walk up to the package dir.
BB_DIR="${OXIDE_RESOLVER_BB_DIR:-$(node -e "
  const path = require('node:path');
  let dir = path.dirname(require.resolve('@aztec-foundation/bb.js', { paths: ['$ROOT/yarn-project/resolver-proof'] }));
  while (path.basename(path.dirname(dir)) + '/' + path.basename(dir) !== '@aztec-foundation/bb.js') {
    const up = path.dirname(dir);
    if (up === dir) throw new Error('no @aztec-foundation/bb.js package dir above resolved entry');
    dir = up;
  }
  console.log(dir);
" 2>/dev/null || true)}"
[ -n "$BB_DIR" ] || {
  echo "cannot resolve @aztec-foundation/bb.js from yarn-project/resolver-proof; run 'yarn install' in yarn-project/ first" >&2
  exit 1
}
BB_VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync('$BB_DIR/package.json', 'utf8')).version")"
EXPECTED_BB_VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync('$ROOT/yarn-project/resolver-proof/package.json', 'utf8')).dependencies['@aztec-foundation/bb.js']")"
[ "$BB_VERSION" = "$EXPECTED_BB_VERSION" ] || {
  echo "@aztec-foundation/bb.js $BB_VERSION does not match @oxide/resolver-proof's $EXPECTED_BB_VERSION pin" >&2
  exit 1
}
bb() { node --no-warnings "$BB_DIR/dest/node/bin/index.js" "$@"; }

# ultra_honk + keccak Fiat-Shamir, zk on — must match resolver-proof's EVM proof settings and the flags
# l1-contracts/bootstrap.sh generates the verifier with.
write_vk() { mkdir -p "$2" && jq -r '.bytecode' "$1" | base64 -d | gunzip | bb write_vk --scheme ultra_honk --oracle_hash keccak -b - -o "$2"; }
write_verifier() { bb write_solidity_verifier --scheme ultra_honk -k "$1" -o "$2"; }

# noir-execute (the resolver's native witness solver) reads a full program artifact, so the pin needs `debug_symbols`
# and `file_map`. The compiler's own are dropped: proving does not need them and the file map embeds
# environment-specific paths. The resolver circuit is a nargo `bin` program with a single ACIR circuit, so the stub
# holds the debug metadata of one circuit. Its location tree holds only a root entry, so a failed assertion reports
# `Failed assertion` without a source location. To see the message and the source location, run noir-execute against
# target/$PKG.json from `./noir-projects/bootstrap.sh resolver_circuit`: it carries the compiler's debug metadata over
# the same bytecode.
debug_stub() {
  node -e "
    const stub = { debug_infos: [{
      brillig_locations: {}, acir_locations: {}, variables: {}, functions: {}, types: {}, brillig_procedure_locs: {},
      location_tree: { locations: [{ parent: null, value: { span: { start: 0, end: 0 }, file: 0 } }] },
    }] };
    process.stdout.write(require('node:zlib').deflateRawSync(JSON.stringify(stub)).toString('base64'));
  "
}

require_built() {
  for f in "target/$PKG.json" target/keys/vk "$BUILT_VERIFIER"; do
    [ -f "$f" ] || {
      echo "missing $f — build first: ./noir-projects/bootstrap.sh $PKG && ./l1-contracts/bootstrap.sh generate" >&2
      exit 1
    }
  done
}

repin() {
  require_built
  mkdir -p "$PINNED"
  local vk_changed=0
  cmp -s target/keys/vk "$PINNED/vk" || vk_changed=1
  jq --arg stub "$(debug_stub)" '{noir_version, hash, abi, bytecode, debug_symbols: $stub, file_map: {}}' \
    "target/$PKG.json" >"$PINNED/$PKG.json"
  cp target/keys/vk "$PINNED/"
  cp "$BUILT_VERIFIER" "$PINNED_VERIFIER"
  echo "Repinned $PKG from the built artifacts (noirc $(jq -r '.noir_version' "$PINNED/$PKG.json"))."
  check
  if [ "$vk_changed" -eq 0 ]; then
    echo "vk unchanged: the deployed Resolver module keeps verifying. Roll out the resolver service to ship the new artifact."
  else
    echo "vk changed: the deployed Resolver module rejects new proofs until a new verifier + Resolver module ship."
  fi
}

check() {
  local fail=0
  # Not `local`: the EXIT trap fires at global scope after this function returns, where a function-scoped tmp
  # would be unbound under `set -u`.
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  write_vk "$PINNED/$PKG.json" "$tmp"
  cmp -s "$PINNED/vk" "$tmp/vk" || {
    echo "FAIL: pinned vk does not reproduce from the pinned bytecode with @aztec-foundation/bb.js $BB_VERSION" >&2
    echo "      (resolver-proof's dependency). The pin and the prover must move together: repin with a matching" >&2
    echo "      toolchain or fix resolver-proof's @aztec-foundation/bb.js version. Repinning implies a new Resolver module deployment." >&2
    fail=1
  }
  write_verifier "$PINNED/vk" "$tmp/PinnedResolverVerifier.sol"
  cmp -s "$PINNED_VERIFIER" "$tmp/PinnedResolverVerifier.sol" || {
    echo "FAIL: PinnedResolverVerifier.sol does not reproduce from the pinned vk with @aztec-foundation/bb.js $BB_VERSION." >&2
    echo "      Repin (implies a new Resolver module deployment) or revert the verifier/bb.js change." >&2
    fail=1
  }

  [ "$fail" -eq 0 ] || exit 1
  echo "Resolver pin OK (@aztec-foundation/bb.js $BB_VERSION)."
}

case "${1:-}" in
  "")      repin ;;
  --check) check ;;
  *)
    echo "Usage: $0 [--check]" >&2
    exit 1
    ;;
esac
