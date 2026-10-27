#!/usr/bin/env bash
# Compiles the vendored Oxide refund circuits and checks them against their L1 verifiers.
# Invoked via `pnpm build:oxide-circuits`.
#
# For each refund circuit in vendor/oxide/noir-projects, the script does the same steps as Oxide's
# refund verifier build (deployer/src/bridge/build_refund_verifiers.ts in Oxide):
#   1. `aztec-nargo compile` writes target/<circuit>.json. @oxide/refund-proof imports the
#      refund circuits from there.
#   2. `aztec-bb write_vk -t evm` writes the vk to target/keys/vk.
#   3. `aztec-bb write_solidity_verifier -t evm --optimized` writes a Solidity verifier from the vk.
#      The script compares it with the verifier in vendor/oxide/l1-contracts/src/generated/ that
#      OxidePortal uses. A difference fails the build.
#
# The script does not check resolver_circuit. Its verifier, l1-contracts/src/pinned/PinnedResolverVerifier.sol,
# is pinned to the circuit that the deployed Resolver module uses. The Aztec 6.0.0 toolchain compiles the
# vendored resolver source to a different vk.
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
NOIR_PROJECTS="$REPO_ROOT/vendor/oxide/noir-projects"
L1_CONTRACTS="$REPO_ROOT/vendor/oxide/l1-contracts"

# circuit package : verifier path under vendor/oxide/l1-contracts
CIRCUITS=(
  "frozen_notes_refund:src/generated/FrozenNotesRefundVerifier.sol"
  "frozen_deposits_refund:src/generated/FrozenDepositsRefundVerifier.sol"
  "unprocessed_deposit_refund:src/generated/UnprocessedDepositRefundVerifier.sol"
)

for tool in aztec-nargo aztec-bb; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool not found on PATH. Install the Aztec toolchain 6.0.0." >&2; exit 1; }
done

WORK_DIR=$(mktemp -d)
trap 'rm -r "$WORK_DIR"' EXIT

for entry in "${CIRCUITS[@]}"; do
  IFS=: read -r name verifier <<<"$entry"
  dir="$NOIR_PROJECTS/$name"

  echo "==> aztec-nargo compile $name"
  (cd "$dir" && aztec-nargo compile --silence-warnings --package "$name")

  json="$dir/target/$name.json"
  [[ -f "$json" ]] || { echo "ERROR: aztec-nargo did not write $json" >&2; exit 1; }

  mkdir -p "$dir/target/keys"
  aztec-bb write_vk -t evm -b "$json" -o "$dir/target/keys"

  generated="$WORK_DIR/$(basename "$verifier")"
  aztec-bb write_solidity_verifier -t evm --optimized -k "$dir/target/keys/vk" -o "$generated"
  if ! cmp -s "$generated" "$L1_CONTRACTS/$verifier"; then
    echo "ERROR: the $name vk does not match vendor/oxide/l1-contracts/$verifier" >&2
    exit 1
  fi
  echo "$name matches $verifier"
done
