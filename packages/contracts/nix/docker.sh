# Sourced by build.sh and update-lock.sh: runs in-container.sh in the pinned nixos/nix image with the repository
# read-only at /repo. The image's /nix is a named volume, so this machine's Nix store, and with it every build, outlives
# the container.

NIX_IMAGE="nixos/nix:2.35.4@sha256:f159a58f390677f41e8e900a74b6e2f9c7f27b364122ae6acf7a652ce6c551c0"
NIX_VOLUME="obsidion-nix-2.35.4"

nix_container() {
  local repo volume="$NIX_VOLUME"
  repo="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
  # An unsandboxed build gets its own store, so a later sandboxed run never finds it and pushes it.
  [ "${DISABLE_NIX_SANDBOX:-0}" != 1 ] || volume+="-unsandboxed"
  # Names without values pass the caller's settings through and keep the token off the command line.
  local args=(
    --rm --platform linux/amd64
    -v "$volume:/nix" -v "$repo:/repo:ro"
    -e DISABLE_NIX_SANDBOX -e DISABLE_NIMBUS_PUSH
  )
  [ -z "${NIMBUS_CACHE:-}" ] ||
    args+=(-e NIMBUS_ENDPOINT -e NIMBUS_CACHE -e NIMBUS_CACHE_PUBLIC_KEY -e NIMBUS_AUTH_TOKEN)
  # The Nix sandbox needs namespaces Docker grants only a privileged container.
  [ "${DISABLE_NIX_SANDBOX:-0}" = 1 ] || args+=(--privileged)
  docker run "${args[@]}" "$NIX_IMAGE" bash /repo/packages/contracts/nix/in-container.sh "$@"
}
