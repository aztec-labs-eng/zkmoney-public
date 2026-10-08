#!/usr/bin/env bash
# Compiles all Noir contracts + circuits, generates TS artifacts, and copies
# them to packages/contracts/src/artifacts. Invoked via `pnpm build-contracts`.
#
# The shebang MUST stay on line 1 — pnpm spawns this script via /bin/sh, which
# on Ubuntu CI is dash. Dash doesn't accept the `arr=()` / `shopt` / `[[ ]]`
# bash syntax used below; without a line-1 shebang the kernel falls back to
# /bin/sh and the script fails with "Syntax error: '(' unexpected" on the
# first array declaration. macOS works because /bin/sh = bash there.
set -e

#make it usable
#  chmod +x scripts/build_contracts.sh

# Extract version from update-versions script in package.json if not already set
if [ -z "$VERSION" ]; then
  VERSION=$(grep -m 1 '"update-versions":' "$(git rev-parse --show-toplevel)/package.json" | grep -o -- "--newVersion [0-9a-zA-Z.-]*" | awk '{print $2}')
fi
echo "Using version: $VERSION"

# -----------------------------------------------
# Example usage:
#   ./scripts/build_contracts.sh                         # Build all contracts
#   ./scripts/build_contracts.sh -contract_name identity # Build only contract containing "identity"
#   ./scripts/build_contracts.sh -exclude identity       # Build all contracts except those containing "identity"
#   ./scripts/build_contracts.sh -exclude identity token # Build all except contracts containing "identity" or "token"
#   or from pnpm:
#   pnpm build-contracts                                 # Build all contracts
#   pnpm build-contracts -c identity                     # Short form with single parameter
#   pnpm build-contracts -contract identity              # Short parameter name (without _name)
#   pnpm build-contracts -e identity                     # Exclude contracts containing "identity"
#   pnpm build-contracts -exclude identity               # Exclude contracts containing "identity"
#   pnpm build-contracts -exclude identity token escrow  # Exclude multiple contracts
#
# It will:
#   1) Find each directory containing Nargo.toml under packages/contracts/contracts
#      and packages/contracts/circuits.
#   2) Read [package].type from Nargo.toml and dispatch:
#        - type = "contract"  → aztec compile + codegen + transform-artifact (existing path)
#        - any other type     → aztec-nargo compile (no codegen, no transform)
#   3) For contracts: remove codegenCache.json, run aztec codegen into .../src/artifacts,
#      and run transform-artifact.js so the artifact is injectable.
#   4) For circuits: skip codegen / transform — circuits don't have multiple functions
#      to wrap in an injectable artifact format.
#   5) Copy each package's target/ output to the central target directory in the
#      artifacts folder (packages/contracts/src/artifacts/target/<name>/).
# -----------------------------------------------

# Parse command line arguments - more flexible parsing
TARGET_CONTRACT=""
EXCLUDE_CONTRACTS=()

# Process all arguments
i=1
while [ $i -le $# ]; do
  arg="${!i}"

  # Look for any flag that might indicate a contract name
  if [[ "$arg" == "-contract_name" || "$arg" == "-contract" || "$arg" == "-c" ]]; then
    # Get the next argument as the contract name
    i=$((i+1))
    if [ $i -le $# ]; then
      TARGET_CONTRACT="${!i}"
    fi
  elif [[ "$arg" == "-exclude" || "$arg" == "-e" ]]; then
    # Get all following arguments until we hit another flag or end of args
    i=$((i+1))
    while [ $i -le $# ]; do
      next_arg="${!i}"
      # Stop if we hit another flag
      if [[ "$next_arg" == -* ]]; then
        i=$((i-1))  # Back up one to reprocess this flag
        break
      fi
      EXCLUDE_CONTRACTS+=("$next_arg")
      i=$((i+1))
    done
  elif [[ "$arg" == -* && "$arg" != "--" ]]; then
    # Handle case where flag and value are combined (e.g. -paylink_email)
    TARGET_CONTRACT="${arg#-}"
  fi

  i=$((i+1))
done

if [[ -n "$TARGET_CONTRACT" ]]; then
  echo "Building only contract containing: $TARGET_CONTRACT"
fi

if [[ ${#EXCLUDE_CONTRACTS[@]} -gt 0 ]]; then
  echo "Excluding contracts containing: ${EXCLUDE_CONTRACTS[*]}"
fi

# Clean up all codegenCache.json files first
echo "Cleaning up all codegenCache.json files..."
find packages/contracts -name "codegenCache.json" -type f -delete

# Define directories to skip codegen
SKIP_DIRS=("authenticators/interface")  # Replace with your specific paths

# Function to check if CONTRACT_DIR is in SKIP_DIRS
should_skip() {
  local dir="$1"
  for skip_dir in "${SKIP_DIRS[@]}"; do
    if [[ "$dir" == *"$skip_dir"* ]]; then
      return 0  # Skip
    fi
  done
  return 1  # Do not skip
}

# Read [package].type from a Nargo.toml. Empty string if not present.
get_nargo_type() {
  awk -F'=' '/^[[:space:]]*type[[:space:]]*=/ {gsub(/[[:space:]"]/, "", $2); print $2; exit}' "$1"
}

# Retry a command up to N times when it exits non-zero. Used to wrap
# `aztec compile` and `aztec-nargo compile`, both of which shell out to nargo,
# which fetches every git-based dependency listed in Nargo.toml at compile
# time (e.g. AztecProtocol/aztec-packages, zkpassport/noir-bignum,
# madztheo/noir-date.git). Any single transient github.com 5xx during that
# fetch aborts the build and — under `set -e` — kills the whole script.
# CI's contract-artifacts cache hides this on alpha; our branch invalidates
# the cache, so every push has to clone the full nargo dep graph fresh, and
# any 5xx flake breaks the run. Three attempts with 5s backoff covers the
# transient class without slowing the steady-state.
with_retry() {
  local attempts=3
  local delay=5
  local attempt=1
  while true; do
    if "$@"; then
      return 0
    fi
    if (( attempt >= attempts )); then
      echo "ERROR: command failed after ${attempts} attempts: $*"
      return 1
    fi
    echo "WARN: command failed (attempt ${attempt}/${attempts}); retrying in ${delay}s: $*"
    sleep "$delay"
    attempt=$((attempt+1))
  done
}

# Construct the paths
REPO_ROOT=$(git rev-parse --show-toplevel)
ARTIFACTS_DIR="$REPO_ROOT/packages/contracts/src/artifacts"
COMPILED_TARGET_DIR="$ARTIFACTS_DIR/target"
TRANSFORM_SCRIPT="$REPO_ROOT/scripts/transform-artifact.js"

# Check if transform script exists
if [[ ! -f "$TRANSFORM_SCRIPT" ]]; then
  echo "ERROR: Transform script not found at: $TRANSFORM_SCRIPT"
  exit 1
fi

# Create target directory in artifacts folder
mkdir -p "$COMPILED_TARGET_DIR"
echo "Compiled contract outputs will be copied to: $COMPILED_TARGET_DIR"

# 1) Find each folder that has Nargo.toml under contracts/ and circuits/.
# Also include the vendored oxide contracts the wallet bundles artifacts for:
# oxide_token_contract (the canonical L2 bridge) and broadcaster_contract
# (the L2 Broadcaster the wallet sends L1 operations through).
SEARCH_ROOTS=()
[[ -d "packages/contracts/contracts" ]] && SEARCH_ROOTS+=("packages/contracts/contracts")
[[ -d "packages/contracts/circuits" ]] && SEARCH_ROOTS+=("packages/contracts/circuits")
[[ -d "vendor/oxide/noir-projects/oxide_token_contract" ]] && SEARCH_ROOTS+=("vendor/oxide/noir-projects/oxide_token_contract")
[[ -d "vendor/oxide/noir-projects/broadcaster_contract" ]] && SEARCH_ROOTS+=("vendor/oxide/noir-projects/broadcaster_contract")

for NARGO_FILE in $(find "${SEARCH_ROOTS[@]}" -type f -name "Nargo.toml" -not -path '*/node_modules/*' -not -path '*/libs/*' -not -path '*/lib/*' -not -path '*/.git/*'); do
  CONTRACT_DIR=$(dirname "$NARGO_FILE")
  PKG_TYPE=$(get_nargo_type "$NARGO_FILE")

  # Skip if we're targeting a specific contract and this isn't it
  if [[ -n "$TARGET_CONTRACT" && ! "$CONTRACT_DIR" == *"$TARGET_CONTRACT"* ]]; then
    continue
  fi

  # Skip if we're excluding contracts and this matches any exclude pattern.
  # Patterns are matched against path *components* (slash-bounded) to avoid
  # accidental collisions (e.g. excluding "account" should not skip "alpha_account").
  should_exclude=false
  for exclude_pattern in "${EXCLUDE_CONTRACTS[@]}"; do
    # strip trailing slash for consistency
    pat="${exclude_pattern%/}"
    if [[ "/$CONTRACT_DIR/" == *"/$pat/"* ]]; then
      echo "Skipping excluded contract: $CONTRACT_DIR (matches pattern: $exclude_pattern)"
      should_exclude=true
      break
    fi
  done

  if [[ "$should_exclude" == true ]]; then
    continue
  fi

  echo "============================================================"
  if [[ "$PKG_TYPE" == "contract" ]]; then
    echo "Compiling contract in: $CONTRACT_DIR"
  else
    echo "Compiling circuit in: $CONTRACT_DIR (type: ${PKG_TYPE:-unknown})"
  fi
  echo "============================================================"

  # 2) Move into the package directory
  cd "$CONTRACT_DIR"

  # Get name from directory path for organizing outputs
  CONTRACT_NAME=$(basename "$CONTRACT_DIR")

  if [[ "$PKG_TYPE" == "contract" ]]; then
    # Calculate the depth from packages/contracts/contracts to this folder
    DEPTH=$(echo "$CONTRACT_DIR" | awk -F'/' '{print NF-5}')

    # Compile the Noir contract with VERSION environment variable.
    # Retry to absorb transient github.com 5xx during nargo's git fetch of
    # Aztec / Noir dependencies (see `with_retry` header above).
    #
    # The vendored oxide contracts must match oxide's deploy compile flags
    # exactly so the bytecode (and therefore the contract class id) matches the
    # on-chain instances deployed by oxide's pipeline. oxide compiles every
    # contract with `--inliner-aggressiveness 0` (`build_contract` in
    # vendor/oxide/noir-projects/bootstrap.sh, invoked by deploy/build.sh).
    if [[ "$CONTRACT_NAME" == "oxide_token_contract" || "$CONTRACT_NAME" == "broadcaster_contract" ]]; then
      with_retry env VERSION=$VERSION aztec compile --silence-warnings --inliner-aggressiveness 0
    else
      with_retry env VERSION=$VERSION aztec compile --silence-warnings
    fi

    # Postprocess the Noir contract, generates the VKEYS
    # VERSION=$VERSION aztec-postprocess-contract

    # 3) Remove codegenCache.json if it exists, MIGHT BE BUGGIN
    if [ -f codegenCache.json ]; then
      rm codegenCache.json
    fi

    # 4) Generate artifacts using aztec codegen and transform
    if should_skip "$CONTRACT_DIR"; then
      echo "Skipping aztec codegen for: $CONTRACT_DIR"
    else
      # Run codegen with error handling - if it fails, log the error but continue
      echo "Running codegen for: $CONTRACT_DIR"
      if aztec codegen ./ -o "$ARTIFACTS_DIR"; then
        # Find the generated TS file and transform it
        # Extract contract class name from JSON filename in target/
        # Pattern: package_name-ContractName.json -> ContractName.ts
        for JSON_FILE in ./target/*.json; do
          if [[ -f "$JSON_FILE" ]]; then
            JSON_BASENAME=$(basename "$JSON_FILE")
            # Extract ContractName from "package_name-ContractName.json"
            CONTRACT_CLASS_NAME="${JSON_BASENAME##*-}"
            CONTRACT_CLASS_NAME="${CONTRACT_CLASS_NAME%.json}"
            GENERATED_TS="$ARTIFACTS_DIR/${CONTRACT_CLASS_NAME}.ts"

            if [[ -f "$GENERATED_TS" ]]; then
              echo "Transforming artifact: ${CONTRACT_CLASS_NAME}.ts"
              if node "$TRANSFORM_SCRIPT" "$GENERATED_TS"; then
                echo "Successfully transformed: ${CONTRACT_CLASS_NAME}.ts"
              else
                echo "WARNING: Transform failed for ${CONTRACT_CLASS_NAME}.ts"
              fi
            fi
          fi
        done
      else
        echo "WARNING: Codegen failed for $CONTRACT_DIR but continuing with other contracts"
      fi
    fi
  else
    # Circuit path: aztec-nargo compile only; no codegen, no transform-artifact.
    # Circuits are single-entry-point, so the injectable-artifact wrapping
    # the contract codegen produces doesn't apply. Retry for the same
    # transient-fetch reason as the contract branch above.
    # Circuits whose VK is pinned in @obsidion/core/constants — a stale pin ships the proof/VK
    # mismatch class the SSoT generator below exists to prevent, so their compile and VK
    # derivation are both fatal rather than best-effort. Every generator takes the same CLI.
    VK_PINNED_CIRCUIT=false
    case "$CONTRACT_NAME" in
      golden_ticket)
        VK_PINNED_CIRCUIT=true
        VKEY_GENERATOR="$REPO_ROOT/packages/sdk/scripts/golden-ticket/generate-vk.mjs"
        ;;
    esac

    if ! with_retry aztec-nargo compile; then
      if [[ "$VK_PINNED_CIRCUIT" == true ]]; then
        echo "ERROR: aztec-nargo compile failed for $CONTRACT_DIR — required for $CONTRACT_NAME VK SSoT"
        exit 1
      fi
      echo "WARNING: aztec-nargo compile failed for $CONTRACT_DIR (continuing)"
    fi

    if [[ "$VK_PINNED_CIRCUIT" == true ]]; then
      if [[ ! -f "./target/${CONTRACT_NAME}.json" ]]; then
        echo "ERROR: ./target/${CONTRACT_NAME}.json missing after aztec-nargo compile — cannot derive VK"
        exit 1
      fi
      VKEY_OUTPUT="$REPO_ROOT/packages/core/src/constants/index.ts"
      echo "Updating the $CONTRACT_NAME vkey in $VKEY_OUTPUT from ./target/${CONTRACT_NAME}.json..."
      # Wall-clock cap: Barretenberg.new + getVerificationKey have hung in the
      # past on this circuit; bound to 15 minutes so a wedged helper fails the
      # build instead of running until the outer CI/job timeout. `gtimeout` is
      # the GNU coreutils name on macOS (via Homebrew); fall back to plain
      # `timeout` on Linux/CI.
      if command -v gtimeout >/dev/null 2>&1; then
        TIMEOUT_BIN="gtimeout"
      elif command -v timeout >/dev/null 2>&1; then
        TIMEOUT_BIN="timeout"
      else
        TIMEOUT_BIN=""
      fi
      if [[ -n "$TIMEOUT_BIN" ]]; then
        if ! "$TIMEOUT_BIN" 15m node "$VKEY_GENERATOR" --in "./target/${CONTRACT_NAME}.json" --out "$VKEY_OUTPUT" --circuit "$CONTRACT_NAME"; then
          echo "ERROR: $CONTRACT_NAME VK generation failed (or exceeded 15m timeout)"
          exit 1
        fi
      else
        echo "WARNING: no \`timeout\`/\`gtimeout\` binary found; running VK generator without wall-clock cap"
        if ! node "$VKEY_GENERATOR" --in "./target/${CONTRACT_NAME}.json" --out "$VKEY_OUTPUT" --circuit "$CONTRACT_NAME"; then
          echo "ERROR: $CONTRACT_NAME VK generation failed"
          exit 1
        fi
      fi
    fi
  fi

  # 6) Copy target folder contents to the central target directory
  if [ -d "./target" ]; then
    CONTRACT_OUTPUT_DIR="$COMPILED_TARGET_DIR/$CONTRACT_NAME"
    mkdir -p "$CONTRACT_OUTPUT_DIR"

    if [[ "$PKG_TYPE" == "contract" ]]; then
      # Contract target/ contains only fresh aztec-compile output — copy and wipe.
      echo "Copying compiled outputs from $CONTRACT_DIR/target to $CONTRACT_OUTPUT_DIR"
      cp -r ./target/* "$CONTRACT_OUTPUT_DIR/"
      echo "Cleaning up target folder in $CONTRACT_DIR"
      rm -rf ./target
    else
      # Circuit target/ also holds tracked fixtures (proof/, vk/) — only touch the regenerable
      # nargo outputs (.json / .gz at the top of target/) so the fixtures stay put.
      echo "Copying nargo outputs from $CONTRACT_DIR/target to $CONTRACT_OUTPUT_DIR"
      shopt -s nullglob
      for OUT_FILE in ./target/*.json ./target/*.gz; do
        cp "$OUT_FILE" "$CONTRACT_OUTPUT_DIR/"
      done
      echo "Cleaning up nargo outputs in $CONTRACT_DIR/target (preserving proof/, vk/)"
      rm -f ./target/*.json ./target/*.gz
      shopt -u nullglob
    fi
  else
    echo "WARNING: No target directory found for $CONTRACT_DIR"
  fi

  cd - > /dev/null
done

# # 6) Run aztec-postprocess-contract after all contracts are compiled
# echo "============================================================"
# echo "Running aztec-postprocess-contract..."
# echo "============================================================"
# cd "$ARTIFACTS_DIR"
# VERSION=$VERSION aztec-postprocess-contract
cd - > /dev/null

if [[ -n "$TARGET_CONTRACT" ]]; then
  echo "Finished building contracts containing: $TARGET_CONTRACT"
else
  echo "All contracts built successfully!"
fi

echo "Compiled contract outputs are available in: $COMPILED_TARGET_DIR"

# Stamp the source content key this artifact set was built from, so a later build can
# tell a current set from one left behind by earlier sources or another vendor/oxide
# pin. A filtered build leaves the set partial and writes no stamp.
if [[ -z "$TARGET_CONTRACT" && ${#EXCLUDE_CONTRACTS[@]} -eq 0 ]]; then
  NOIR_KEY="$(AZTEC_VERSION="${VERSION#v}" node "$REPO_ROOT/.github/scripts/noir-cache.mjs" store-key 2>/dev/null || true)"
  if [[ -n "$NOIR_KEY" ]]; then
    printf '%s\n' "$NOIR_KEY" > "$COMPILED_TARGET_DIR/.noir-store-key"
  fi
fi

# 7) Propagate the freshly-built artifacts (JSON + codegen .ts) into
# packages/contracts/dist/ so workspace consumers (backend, sdk) pick
# them up. `getHardcodedArtifact` in src/services/utils.ts imports the JSON
# via a relative path, and consumers resolve it through the package's compiled
# `dist/` output — without this rebuild, `src/artifacts/target/.../foo.json`
# stays fresh while `dist/artifacts/target/.../foo.json` stays stale, and the
# backend deploys whichever class id the stale `dist/` JSON describes.
# Opt out with SKIP_CONTRACTS_DIST_REBUILD=1 (e.g., when CI's outer pipeline
# runs `pnpm build` immediately after this script anyway).
if [[ "${SKIP_CONTRACTS_DIST_REBUILD:-0}" != "1" ]]; then
  echo "============================================================"
  echo "Rebuilding @obsidion/contracts to propagate artifacts to dist/"
  echo "============================================================"
  (cd "$REPO_ROOT" && pnpm build:contracts)
fi
