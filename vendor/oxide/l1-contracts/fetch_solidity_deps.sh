#!/usr/bin/env bash
# Fetches the pinned Solidity repositories that foundry.toml maps from .deps. It needs only git, so a build that does
# not run the deployer can use it.
set -euo pipefail
cd "$(dirname "$0")"

deps=(
  "nitro-validator https://github.com/base/nitro-validator.git 55860bc2f7b934fa0337ca057ac18f0a53760c21"
  "solidity-lib https://github.com/dl-solarity/solidity-lib.git b94757194de6436062c2d68118c0352be84ac4be"
)

for dep in "${deps[@]}"; do
  read -r name url commit <<<"$dep"
  dir=".deps/$name"
  if [ ! -e "$dir/.git" ]; then
    mkdir -p "$dir"
    git -C "$dir" init -q
    git -C "$dir" remote add origin "$url"
  fi
  git -C "$dir" fetch --depth 1 origin "$commit"
  git -C "$dir" checkout --detach -q "$commit"
done
