#!/usr/bin/env bash
# The web wallet E2E suite with every spec in its own in-process world (playwright.light.config.ts): no
# sandbox stack, no service process, no port.
#
#   scripts/e2e-light.sh [playwright args]     e.g. scripts/e2e-light.sh e2e/onboarding/smoke.spec.ts
#
# Runs Playwright only. What it runs against is built by the repository's Makefile (`make wallet-dist`, or
# ./bootstrap.sh): the world snapshot (E2E_WORLD_SNAPSHOT, default .test-all/e2e-world), the wallet built against its
# placeholder profile, and Playwright's browser.
set -euo pipefail
WALLET=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$WALLET/../.." && pwd)
export E2E_WORLD_SNAPSHOT=${E2E_WORLD_SNAPSHOT:-$ROOT/.test-all/e2e-world}
# Playwright's own Chromium: the checkout's, unless PLAYWRIGHT_BROWSERS_PATH names one (CI3's devbox image).
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$ROOT/.pw-browsers}

if [ ! -f "$E2E_WORLD_SNAPSHOT/profile-placeholder.json" ] || [ ! -f "$WALLET/dist/index.html" ]; then
  echo "No E2E world or wallet build: run \`make wallet-dist\` (or ./bootstrap.sh) from the repository root." >&2
  exit 1
fi

export CI=true VITE_PROVER_ENABLED=false
# The in-process services log through synchronous streams; at info that alone stalls a worker for seconds.
[ -n "${TEST_LOGS:-}" ] || export LOG_LEVEL="${LOG_LEVEL:-warn}"
cd "$WALLET" && exec npx playwright test -c playwright.light.config.ts "$@"
