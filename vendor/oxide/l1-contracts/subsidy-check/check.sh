#!/usr/bin/env bash
# The subsidy check (README.md). CI runs it in ci-forge.yml on the results of the forge step there.
# Needs aztec-forge and python3. PYTHON and FORGE override the commands. Arguments after the options go to forge test.
#   --results FILE        keep the forge results in FILE
#   --forge-results FILE  do not run the tests: read the results of a `forge test --json-file FILE` run
# Each stage runs even when an earlier one fails, so one run shows every failure. The check fails at the end.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
L1=$(cd "$HERE/.." && pwd)
PYTHON=${PYTHON:-python3}
FORGE=${FORGE:-aztec-forge}
EVIDENCE=$("$PYTHON" -I -c "import sys; sys.path.insert(0, '$HERE'); import registry; print(registry.FORGE_MATCH)")

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
RESULTS=""
IMPORTED=""

while [ $# -gt 0 ]; do
  case "$1" in
    --results)
      RESULTS=$2
      shift 2
      ;;
    --forge-results)
      IMPORTED=$2
      shift 2
      ;;
    *) break ;;
  esac
done

if [ -n "$IMPORTED" ] && { [ -n "$RESULTS" ] || [ $# -gt 0 ]; }; then
  echo "check.sh: --forge-results reads the results of another forge run, so it takes no --results and no forge arguments" >&2
  exit 2
fi
RESULTS=${RESULTS:-$WORK/results.json}
INVENTORY=$WORK/inventory.json

FAILED=()
stage() {
  local name=$1
  shift
  echo "== $name"
  "$@" || FAILED+=("$name")
}

# forge prints only JSON with --json, so registry.py prints each failure with its reason and logs.
forge_stage() {
  (cd "$L1" && "$FORGE" test --json --match-path "$EVIDENCE" "$@") > "$RESULTS"
}

# Every test in the subsidy tests, so that the registry finds a test that no entry names.
inventory_stage() {
  (cd "$L1" && "$FORGE" test --list --json --match-path "$EVIDENCE") > "$INVENTORY"
}

stage "The generated tests are current, and every routed flow and gas row has its check" "$PYTHON" -I "$HERE/gen.py" --check
stage "The registry finds every shape of subsidy and refuses missing evidence" "$PYTHON" -I "$HERE/test_registry.py"
if [ -n "$IMPORTED" ]; then
  RESULTS=$IMPORTED
else
  stage "forge: every subsidy test ($EVIDENCE) passes" forge_stage "$@"
fi
stage "forge: list every subsidy test" inventory_stage
stage "Every subsidy has passing forge evidence or an exemption, and every subsidy test is in the registry" \
  "$PYTHON" -I "$HERE/registry.py" "$RESULTS" --inventory "$INVENTORY"

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "check.sh: ${#FAILED[@]} stage(s) failed:" >&2
  printf '  - %s\n' "${FAILED[@]}" >&2
  exit 1
fi
