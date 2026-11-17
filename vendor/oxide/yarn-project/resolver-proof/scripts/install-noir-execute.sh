#!/usr/bin/env bash
# Installs the `noir-execute` witness solver from a noir GitHub release.
#
#   bash install-noir-execute.sh <dest-path>
#
# NOIR_EXECUTE_VERSION below is the pin for the executor. It is independent of the compiler named by `noir_version`
# in noir-projects/resolver_circuit/pinned/resolver_circuit.json: resolver-proof's witness suite checks that this
# executor solves that artifact to the same witness as the wasm solver, so ci-jest validates a bump. The
# resolver-service image and .github/workflows/ci-jest.yml both run this script.
#
# Linux only.
set -euo pipefail

NOIR_EXECUTE_VERSION=1.0.0-rc.3

dest=${1:-}
[ -n "$dest" ] || {
  echo "usage: $0 <dest-path>" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || {
  echo "$0 installs the linux release only" >&2
  exit 1
}

case "$(uname -m)" in
  x86_64) target=x86_64-unknown-linux-gnu ;;
  aarch64) target=aarch64-unknown-linux-gnu ;;
  *)
    echo "no noir release for architecture '$(uname -m)'" >&2
    exit 1
    ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

url="https://github.com/noir-lang/noir/releases/download/v${NOIR_EXECUTE_VERSION}/noir-${target}.tar.gz"
echo "Installing noir-execute ${NOIR_EXECUTE_VERSION} (${target}) to ${dest}"
curl -fsSL --retry 3 -o "$tmp/noir.tar.gz" "$url"

# The archive holds every binary of the release, each under a ./ prefix in the linux archives.
tar xzf "$tmp/noir.tar.gz" -C "$tmp" ./noir-execute
install -m 755 "$tmp/noir-execute" "$dest"

got=$("$dest" --version)
[ "$got" = "noir-execute version = ${NOIR_EXECUTE_VERSION}" ] || {
  echo "installed binary reports '$got', expected ${NOIR_EXECUTE_VERSION}" >&2
  exit 1
}
