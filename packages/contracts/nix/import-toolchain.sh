#!/usr/bin/env bash
# Copies into aztec-toolchain/ the npm manifest and lock aztec-up installs an Aztec release from, adding the integrity
# hashes the release lock omits for its own packages: fetchNpmDeps needs one for every tarball. They come from the npm
# registry, for the same tarballs the lock names.
#   import-toolchain.sh VERSION   e.g. import-toolchain.sh 6.0.0
set -euo pipefail

[ "$#" -eq 1 ] || {
  echo "usage: $0 VERSION" >&2
  exit 1
}
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://install.aztec-labs.com/$1/packages.tar.gz" | tar -xz -C "$tmp" package.json package-lock.json
node --input-type=module - "$tmp/package-lock.json" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs"
const file = process.argv[2]
const lock = JSON.parse(readFileSync(file, "utf8"))
const missing = Object.entries(lock.packages).filter(([key, entry]) => key && entry.resolved && !entry.integrity)
await Promise.all(
  missing.map(async ([key, entry]) => {
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length)
    const response = await fetch(`https://registry.npmjs.org/${name}/${entry.version}`)
    if (!response.ok) throw new Error(`${name}@${entry.version}: registry answered ${response.status}`)
    const { dist } = await response.json()
    if (dist.tarball !== entry.resolved) throw new Error(`${name}@${entry.version}: registry tarball ${dist.tarball}`)
    if (!dist.integrity) throw new Error(`${name}@${entry.version}: registry gave no integrity`)
    // After `resolved`, where npm writes it.
    const fields = Object.entries(entry)
    fields.splice(fields.findIndex(([field]) => field === "resolved") + 1, 0, ["integrity", dist.integrity])
    lock.packages[key] = Object.fromEntries(fields)
  }),
)
writeFileSync(file, JSON.stringify(lock, null, 2) + "\n")
console.error(`added ${missing.length} integrity hashes`)
EOF
cp "$tmp/package.json" "$tmp/package-lock.json" "$here/aztec-toolchain/"
echo "wrote $here/aztec-toolchain/package.json and package-lock.json"
