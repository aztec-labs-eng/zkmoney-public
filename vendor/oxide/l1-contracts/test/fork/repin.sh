#!/usr/bin/env bash
# Rebuilds the mainnet state the offline `test/fork/*` suites load. Run after bumping FORK_BLOCK in
# MainnetForkFixture.sol or adding a fork test that touches new mainnet accounts/slots.
#
# Forces a clean live fork run so foundry's RPC cache holds exactly the state the suites access at the pinned
# block, then converts that cache into the committed genesis-allocs + block-env fixtures under
# test/fixtures/fork/. The offline tests read only those fixtures; the raw foundry cache is never committed.
#
# Usage:
#   MAINNET_FORK_RPC_URL=<archive-endpoint> ./test/fork/repin.sh
set -euo pipefail
cd "$(dirname "$0")/../.."   # l1-contracts/

: "${MAINNET_FORK_RPC_URL:?set MAINNET_FORK_RPC_URL to a mainnet archive endpoint that serves the pinned block}"

FORK_BLOCK="$(grep -oP 'FORK_BLOCK\s*=\s*\K[0-9_]+' test/fork/MainnetForkFixture.sol | tr -d _)"
[ -n "$FORK_BLOCK" ] || { echo "could not read FORK_BLOCK from test/fork/MainnetForkFixture.sol" >&2; exit 1; }

CACHE="${FOUNDRY_CACHE_DIR:-$HOME/.foundry/cache}/rpc/mainnet/$FORK_BLOCK"
FIXTURES="test/fixtures/fork/mainnet_$FORK_BLOCK"

echo "==> Clearing foundry fork cache for block $FORK_BLOCK"
rm -f "$CACHE"

echo "==> Live fork run to repopulate the cache (aztec-forge test test/fork/*)"
./bootstrap.sh test --match-path 'test/fork/*'

[ -f "$CACHE" ] || { echo "cache not written at $CACHE — did the live run fork?" >&2; exit 1; }

echo "==> Converting cache -> allocs + env fixtures"
node test/fork/cache_to_allocs.mjs "$CACHE" "${FIXTURES}_allocs.json" "${FIXTURES}_env.json"

echo "==> Done. Review and commit test/fixtures/fork/. Re-run offline (unset MAINNET_FORK_RPC_URL) to confirm."
