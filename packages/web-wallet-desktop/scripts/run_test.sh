#!/usr/bin/env bash
# One of the desktop app's checks, from anywhere, as CI3 runs it (scripts/test-cmds.sh at the repository root lists
# them). The app is its own npm project (the Makefile's desktop-deps installs it), so these are npm scripts:
#   scripts/run_test.sh check | test
set -euo pipefail
cd "$(dirname "$0")/.."
source "$(git rev-parse --show-toplevel)/scripts/stand-ins-only.sh"
exec npm run "$@"
