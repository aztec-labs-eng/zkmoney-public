#!/usr/bin/env bash
# One of this package's tests, from anywhere, as CI3 runs it (scripts/test-cmds.sh at the repository root lists them):
#   scripts/run_test.sh <test file> [vitest args]    a test file, under the package's vitest
#   scripts/run_test.sh <package script> [args]     a package.json script, e.g. typecheck
#   An L1 test (*.l1.test.ts) runs on its own L1 sim, and a sandbox E2E suite (test/e2e/*.e2e.ts) on its own light
#   node and L1, with 120s for each test and hook. The metadata settlement suite's relayer is a child process, so its
#   light node and L1 also listen on local ports; METADATA_TWO_ROLLUP=1 runs its two-rollup modes.
#   scripts/run_test.sh v5-migration                 the suite's v5-frozen mode, which needs a local network: it starts
#   one (`aztec start --local-network`), so CI runs it in a container of its own (ISOLATE=1). It reads the v5 inputs
#   the Makefile's v5-deps fetches.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(git rev-parse --show-toplevel)
source "$root/scripts/stand-ins-only.sh"
case "$1" in
  *.l1.test.ts)
    TEST_TIMEOUT_MS=${TEST_TIMEOUT_MS:-120000} exec "$root/scripts/run_vitest.sh" -c vitest.l1.config.ts "$@"
    ;;
  test/e2e/metadataSettlement.e2e.ts)
    LIGHT_NODE_HTTP=1 TEST_TIMEOUT_MS=${TEST_TIMEOUT_MS:-120000} \
      exec "$root/scripts/run_vitest.sh" -c vitest.e2e.light.config.ts "$@"
    ;;
  test/e2e/*.e2e.ts)
    TEST_TIMEOUT_MS=${TEST_TIMEOUT_MS:-120000} exec "$root/scripts/run_vitest.sh" -c vitest.e2e.light.config.ts "$@"
    ;;
  v5-migration)
    # Its own container's real local network: the one test the stand-ins do not hold to.
    drop_stand_ins
    export PATH=$HOME/.aztec/current/bin:$PATH
    [ -d /opt/ms-playwright ] && export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
    log=$(mktemp)
    aztec start --local-network > "$log" 2>&1 &
    network=$!
    # No wait on it: a passing run takes the trap's status, and a killed network's is 143.
    trap 'kill $network 2>/dev/null || true' EXIT
    AZTEC_LOG_FILE=$log "$root/.github/scripts/wait-for-sandbox.sh" 300
    METADATA_V5_SOURCE=1 MIGRATION_SOURCE_ARTIFACTS=file://$root/.test-all/v5-runner/ \
      TEST_TIMEOUT_MS=${TEST_TIMEOUT_MS:-900000} "$root/scripts/run_vitest.sh" -c vitest.e2e.config.ts \
      test/e2e/metadataSettlement.e2e.ts "${@:2}"
    ;;
  *.test.* | *.spec.*) exec "$root/scripts/run_vitest.sh" "$@" ;;
  *) exec pnpm run "$@" ;;
esac
