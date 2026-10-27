#!/usr/bin/env bash
# Builds Noir packages with default.nix, in Docker, and writes each one's artifacts to <dir>/target.
#   build.sh SPEC   SPEC: default.nix's spec
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/docker.sh"

repo="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT
nix_container build "$1" >"$out"
# Files directly in target/ only: a circuit's target/ subdirectories hold tracked fixtures.
if tar -t -f "$out" | grep -v '/target/[^/]*$' >&2; then
  echo "noir-nix: not extracting the build: the files above are not directly in a package's target/" >&2
  exit 1
fi
tar -x -m -C "$repo" -f "$out"
