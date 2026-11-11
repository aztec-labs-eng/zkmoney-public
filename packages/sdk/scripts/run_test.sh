#!/usr/bin/env bash
# One of this package's tests, from anywhere, as CI3 runs it (scripts/test-cmds.sh at the repository root lists them):
#   scripts/run_test.sh <test file> [vitest args]    a test file, under the package's vitest
#   scripts/run_test.sh <package script> [args]     a package.json script, e.g. typecheck
#   A chain suite (*.sandbox.test.ts) runs on its own light node, with 120s for each test and hook: its hooks
#   deploy contracts and take seconds even alone.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(git rev-parse --show-toplevel)
source "$root/scripts/stand-ins-only.sh"
case "$1" in
  *.sandbox.test.ts)
    TEST_TIMEOUT_MS=${TEST_TIMEOUT_MS:-120000} exec "$root/scripts/run_vitest.sh" -c vitest.lightnode.config.ts "$@"
    ;;
  *.test.* | *.spec.*) exec "$root/scripts/run_vitest.sh" "$@" ;;
  *) exec pnpm run "$@" ;;
esac
