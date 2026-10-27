#!/usr/bin/env bash
# Brings lock.json up to date for the given packages: the hash of the npm dependencies aztec-toolchain/package-lock.json
# names, and every git dependency nargo clones for the packages, hashed, with the git dependencies its own manifests
# name. Git dependencies already there keep their hashes.
#   update-lock.sh DIR...   DIR: a package directory, relative to the repository root
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/docker.sh"

[ "$#" -gt 0 ] || {
  echo "usage: $0 DIR..." >&2
  exit 1
}
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dirs="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' "$@")"
lock="$(nix_container lock "$dirs")"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(JSON.parse(process.argv[2]), null, 2) + "\n")' \
  "$here/lock.json" "$lock"
echo "wrote $here/lock.json"
