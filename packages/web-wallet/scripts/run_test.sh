#!/usr/bin/env bash
# One of this package's tests, from anywhere, as CI3 runs it (scripts/test-cmds.sh at the repository root lists them):
#   scripts/run_test.sh <test file> [vitest args]    a test file, under the package's vitest
#   scripts/run_test.sh <package script> [args]     a package.json script, e.g. typecheck
#   The QR scanner card's test (*.browser.tsx) runs under its own vitest config, and test:reports beside a disposable
#   Postgres (scripts/postgres-suite.sh).
#   An E2E test (e2e/<spec>[:line]) runs in its own world on one worker, with its output in test-results/ under a
#   name of its own (each run clears its output directory at start) and no HTML report (every run writes the same).
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(git rev-parse --show-toplevel)
source "$root/scripts/stand-ins-only.sh"
case "$1" in
  e2e/*)
    spec=$1
    shift
    output=test-results/$(sed -E 's/[^A-Za-z0-9]+/-/g' <<< "${spec#e2e/}")
    exec scripts/e2e-light.sh "$spec" --workers=1 --output="$output" --reporter=list "$@"
    ;;
  # The report suite, on zkmoney-api's disposable Postgres: a CI3 compose project serves it.
  test:reports) exec "$root/scripts/postgres-suite.sh" packages/web-wallet test:reports zkmoney_api_test ;;
  *.browser.tsx) exec "$root/scripts/run_vitest.sh" --config vitest.scan-qr.config.ts "$@" ;;
  *.test.* | *.spec.*) exec "$root/scripts/run_vitest.sh" "$@" ;;
  *) exec pnpm run "$@" ;;
esac
