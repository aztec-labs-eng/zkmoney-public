#!/usr/bin/env bash
set -euo pipefail

SOURCE=aztec-labs-eng/obsidion-wallet
root=$(cd "$(dirname "$0")/../../.." && pwd -P)
pkg=$root/packages/generation-v5
asset=$(cd "$pkg" && node -e 'import("./scripts/check.mjs").then((m) => console.log(m.assetName))')
tag=${asset%.tar.zst}

tags=$(gh release list --exclude-drafts --limit 1000 --json tagName,createdAt -q 'sort_by(.createdAt) | .[].tagName')
if grep -qxF "$tag" <<<"$tags"; then
  echo "This repository has the $tag release"
  exit 0
fi
old=$(grep '^generation-v5-' <<<"$tags" | tail -n 1) ||
  { echo "::error::This repository has no v5 bundle release to scan $asset against" >&2; exit 1; }

: "${SOURCE_TOKEN:?Set the OBSIDION_WALLET_READ_TOKEN secret to a token that can read the releases of $SOURCE}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
GH_TOKEN=$SOURCE_TOKEN gh release download source-generations -R "$SOURCE" -p "$asset" -D "$work" ||
  { echo "::error::$SOURCE has no $asset in its source-generations release, or the token cannot read it" >&2; exit 1; }

rm -rf "$pkg/dist"
mkdir -p "$pkg/dist" "$work/old"
tar --zstd -xf "$work/$asset" -C "$pkg/dist"
node "$pkg/scripts/check.mjs"
gh release download "$old" -p "$old.tar.zst" -D "$work"
tar --zstd -xf "$work/$old.tar.zst" -C "$work/old"
node "$root/.claude/skills/wallet-sync/scan.mjs" "$pkg/dist" "$work/old" >/dev/null ||
  { echo "::error::$asset has forbidden items. Read them on your computer with section 6 of the wallet-sync skill" >&2; exit 1; }

read -r commit protocol inputs < <(jq -r '[.walletCommit, .protocol, .inputs] | @tsv' "$pkg/dist/manifest.json")
gh release create "$tag" "$work/$asset" --target main --prerelease --latest=false \
  --title "v5 bundle $inputs" \
  --notes "The v5 source generation bundle for wallet commit ${commit:0:10}, protocol $protocol and inputs hash $inputs."
