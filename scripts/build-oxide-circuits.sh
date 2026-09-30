#!/usr/bin/env bash
# Compiles the vendored Oxide circuits and checks them against their L1 verifiers.
# Invoked via `pnpm build:oxide-circuits`.
#
# For each circuit in vendor/oxide/noir-projects, the script does the same steps as Oxide's
# noir-projects/bootstrap.sh and l1-contracts/bootstrap.sh:
#   1. `aztec-nargo compile` writes target/<circuit>.json. @oxide/refund-proof imports the
#      refund circuits from there.
#   2. `aztec-bb write_vk` writes the EVM-targeted Honk vk to target/keys/vk.
#   3. The @aztec/bb.js `bb` in vendor/oxide/l1-contracts writes a Solidity verifier from the vk.
#      The script compares it with the verifier in vendor/oxide/l1-contracts/src/ that the L1
#      contracts use: OxidePortal for the refund proofs, the Resolver module for the resolver
#      proofs. A difference fails the build.
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
NOIR_PROJECTS="$REPO_ROOT/vendor/oxide/noir-projects"
L1_CONTRACTS="$REPO_ROOT/vendor/oxide/l1-contracts"
BB="$L1_CONTRACTS/node_modules/.bin/bb"

# circuit package : verifier path under vendor/oxide/l1-contracts : extra `write_solidity_verifier` flags.
# The refund verifiers use --disable_zk. The resolver verifier keeps zk on. Oxide's
# l1-contracts/bootstrap.sh uses the same flags.
CIRCUITS=(
  "frozen_notes_refund:src/generated/FrozenNotesRefundVerifier.sol:--disable_zk"
  "frozen_deposit_refund:src/generated/FrozenDepositRefundVerifier.sol:--disable_zk"
  "unprocessed_deposit_refund:src/generated/UnprocessedDepositRefundVerifier.sol:--disable_zk"
  "resolver_circuit:src/pinned/PinnedResolverVerifier.sol:"
)

for tool in aztec-nargo aztec-bb jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool not found on PATH. Install the Aztec toolchain 5.2.0." >&2; exit 1; }
done
[[ -x "$BB" ]] || { echo "ERROR: $BB not found. Run \`pnpm build-contracts\` first." >&2; exit 1; }

WORK_DIR=$(mktemp -d)
trap 'rm -r "$WORK_DIR"' EXIT

for entry in "${CIRCUITS[@]}"; do
  IFS=: read -r name verifier extra_flags <<<"$entry"
  dir="$NOIR_PROJECTS/$name"

  echo "==> aztec-nargo compile $name"
  (cd "$dir" && aztec-nargo compile --silence-warnings --package "$name")

  json="$dir/target/$name.json"
  [[ -f "$json" ]] || { echo "ERROR: aztec-nargo did not write $json" >&2; exit 1; }

  mkdir -p "$dir/target/keys"
  jq -r '.bytecode' "$json" | base64 -d | gunzip \
    | aztec-bb write_vk --scheme ultra_honk --oracle_hash keccak -b - -o "$dir/target/keys"

  generated="$WORK_DIR/$(basename "$verifier")"
  # $extra_flags is empty or one flag, so it is not quoted.
  # shellcheck disable=SC2086
  "$BB" write_solidity_verifier --scheme ultra_honk $extra_flags -k "$dir/target/keys/vk" -o "$generated"
  if ! cmp -s "$generated" "$L1_CONTRACTS/$verifier"; then
    echo "ERROR: the $name vk does not match vendor/oxide/l1-contracts/$verifier" >&2
    exit 1
  fi
  echo "$name matches $verifier"
done
