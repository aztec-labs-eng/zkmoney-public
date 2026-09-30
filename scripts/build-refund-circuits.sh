#!/usr/bin/env bash
# Compiles the vendored Oxide refund circuits and checks them against the L1 refund verifiers.
# Invoked via `pnpm build:refund-circuits`.
#
# For each circuit in vendor/oxide/noir-projects, the script does the same steps as Oxide's
# noir-projects/bootstrap.sh and l1-contracts/bootstrap.sh:
#   1. `aztec-nargo compile` writes target/<circuit>.json, which @oxide/refund-proof imports.
#   2. `aztec-bb write_vk` writes the EVM-targeted Honk vk to target/keys/vk.
#   3. The @aztec/bb.js `bb` in vendor/oxide/l1-contracts writes a Solidity verifier from the vk.
#      The script compares it with the verifier in vendor/oxide/l1-contracts/src/generated/,
#      which OxidePortal uses to verify refund proofs. A difference fails the build.
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
NOIR_PROJECTS="$REPO_ROOT/vendor/oxide/noir-projects"
L1_CONTRACTS="$REPO_ROOT/vendor/oxide/l1-contracts"
BB="$L1_CONTRACTS/node_modules/.bin/bb"

# circuit package name → verifier contract name in l1-contracts/src/generated/
CIRCUITS=(
  "frozen_notes_refund:FrozenNotesRefundVerifier"
  "frozen_deposit_refund:FrozenDepositRefundVerifier"
  "unprocessed_deposit_refund:UnprocessedDepositRefundVerifier"
)

for tool in aztec-nargo aztec-bb jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool not found on PATH. Install the Aztec toolchain 5.2.0." >&2; exit 1; }
done
[[ -x "$BB" ]] || { echo "ERROR: $BB not found. Run \`pnpm build-contracts\` first." >&2; exit 1; }

WORK_DIR=$(mktemp -d)
trap 'rm -r "$WORK_DIR"' EXIT

for entry in "${CIRCUITS[@]}"; do
  name="${entry%%:*}"
  verifier="${entry##*:}"
  dir="$NOIR_PROJECTS/$name"

  echo "==> aztec-nargo compile $name"
  (cd "$dir" && aztec-nargo compile --silence-warnings --package "$name")

  json="$dir/target/$name.json"
  [[ -f "$json" ]] || { echo "ERROR: aztec-nargo did not write $json" >&2; exit 1; }

  mkdir -p "$dir/target/keys"
  jq -r '.bytecode' "$json" | base64 -d | gunzip \
    | aztec-bb write_vk --scheme ultra_honk --oracle_hash keccak -b - -o "$dir/target/keys"

  # The refund verifiers are generated with --disable_zk, as in Oxide's l1-contracts/bootstrap.sh.
  "$BB" write_solidity_verifier --scheme ultra_honk --disable_zk -k "$dir/target/keys/vk" -o "$WORK_DIR/$verifier.sol"
  if ! cmp -s "$WORK_DIR/$verifier.sol" "$L1_CONTRACTS/src/generated/$verifier.sol"; then
    echo "ERROR: the $name vk does not match vendor/oxide/l1-contracts/src/generated/$verifier.sol" >&2
    exit 1
  fi
  echo "$name matches $verifier.sol"
done
