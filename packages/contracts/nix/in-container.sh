#!/usr/bin/env bash
# Runs in the container docker.sh starts. Logs go to stderr; stdout carries the result.
#   in-container.sh build SPEC   build default.nix's packages for SPEC; stdout is a tar of each <dir>/target/ file
#   in-container.sh lock DIRS    derive lock.json for the package directories DIRS (a JSON list); stdout is it
set -euo pipefail
nix_dir=/repo/packages/contracts/nix

sandbox=true
[ "${DISABLE_NIX_SANDBOX:-0}" != 1 ] || sandbox=false
NIX_CONFIG="extra-experimental-features = nix-command
sandbox = $sandbox
sandbox-fallback = false
max-jobs = auto"

nimbus=
if [ -n "${NIMBUS_CACHE:-}" ]; then
  for var in NIMBUS_ENDPOINT NIMBUS_CACHE_PUBLIC_KEY NIMBUS_AUTH_TOKEN; do
    [ -n "${!var:-}" ] || {
      echo "noir-nix: NIMBUS_CACHE=$NIMBUS_CACHE needs $var" >&2
      exit 1
    }
  done
  nimbus=1
  host="${NIMBUS_ENDPOINT#*://}"
  host="${host%%/*}"
  # curl matches a netrc entry on the host name alone.
  [[ ! "$host" =~ ^(.*):[0-9]+$ ]] || host="${BASH_REMATCH[1]}"
  (umask 077 && printf 'machine %s password %s\n' "$host" "$NIMBUS_AUTH_TOKEN" >/tmp/netrc)
  # A miss is asked again next time rather than remembered, since another machine may have pushed it since. A
  # download that fails after a hit is built here instead.
  NIX_CONFIG+="
extra-substituters = ${NIMBUS_ENDPOINT%/}/$NIMBUS_CACHE
extra-trusted-public-keys = $NIMBUS_CACHE_PUBLIC_KEY
netrc-file = /tmp/netrc
narinfo-cache-negative-ttl = 0
fallback = true"
  echo "noir-nix: using the Nimbus cache $NIMBUS_CACHE at $NIMBUS_ENDPOINT" >&2
fi
export NIX_CONFIG

build() {
  nix-build "$nix_dir" -A contracts --argstr spec "$1" --out-link /tmp/result >&2
  # Files only: a directory entry would reset the mode of the checkout's directory it lands on.
  (cd /tmp/result && find -L . -type f -print0 | tar --null -T - -ch --mode=u+w --owner=0 --group=0)

  [ -n "$nimbus" ] && [ "${DISABLE_NIMBUS_PUSH:-0}" != 1 ] || return 0
  # An unsandboxed build may have read inputs its key does not name, so it never reaches the shared cache.
  if [ "$sandbox" != true ]; then
    echo "noir-nix: not pushing an unsandboxed build to the Nimbus cache" >&2
    return 0
  fi
  # Only the packages built here: one fetched from a cache is already in one.
  local nimbus_bin path sigs paths=()
  while read -r path sigs; do
    [[ " $sigs " != *" ultimate "* ]] || paths+=("$path")
  done < <(nix path-info --sigs $(nix-store --query --references /tmp/result))
  [ "${#paths[@]}" -gt 0 ] || return 0
  nimbus_bin="$(nix-build "$nix_dir" -A nimbus --no-out-link)/bin/nimbus" || {
    echo "noir-nix: warning: the build succeeded but fetching the Nimbus client failed, so it was not pushed" >&2
    return 0
  }
  echo "noir-nix: pushing ${#paths[@]} store paths to $NIMBUS_CACHE" >&2
  "$nimbus_bin" push "$NIMBUS_CACHE" "${paths[@]}" >&2 ||
    echo "noir-nix: warning: the build succeeded but pushing it to the Nimbus cache failed" >&2
}

# The hash a fixed-output fetch got, from the mismatch error on stdin.
got_hash() { grep -oE 'got: +sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-.+'; }

# The npm dependencies' hash: lock.json's when the fetch still matches it, else the one the fetch gets.
npm_deps_hash() {
  local recorded log
  recorded="$(nix eval --raw -f "$nix_dir/common.nix" lock.aztecToolchainNpmDeps)"
  echo "noir-nix: checking the Aztec toolchain's npm dependencies" >&2
  if log="$(nix-build --no-out-link --argstr recorded "$recorded" -E "{ recorded }: let c = import $nix_dir/common.nix;
      in c.aztecNpmDeps (if recorded == \"\" then c.lib.fakeHash else recorded)" 2>&1)"; then
    echo "$recorded"
  else
    got_hash <<<"$log" || {
      echo "$log" >&2
      exit 1
    }
  fi
}

lock() {
  local dirs="$1" entries=() missing entry hash npm_hash
  # One clone a line, as JSON, which escapes any newline in its fields.
  local lines='ms: builtins.concatStringsSep "" (map (m: builtins.toJSON m + "\n") ms)'
  # A clone's fields come from third-party manifests, so they reach Nix as a string argument, never as source: this
  # evaluation runs outside the sandbox, where NIMBUS_AUTH_TOKEN is in the environment. The fake hash's mismatch names
  # the real one.
  local probe="{ entry }: let c = import $nix_dir/common.nix;
    in c.fetchGitDep (builtins.fromJSON entry // { hash = c.lib.fakeHash; })"
  found() {
    local IFS=,
    printf '[%s]' "${entries[*]}"
  }
  npm_hash="$(npm_deps_hash)"
  # Each round hashes the clones reached so far without one; their manifests may name more.
  while :; do
    missing="$(nix eval --raw -f "$nix_dir/lock.nix" missing --argstr dirs "$dirs" --argstr found "$(found)" \
      --apply "$lines")"
    [ -n "$missing" ] || break
    while read -r entry; do
      echo "noir-nix: hashing $entry" >&2
      hash="$(nix-build --no-out-link --argstr entry "$entry" -E "$probe" 2>&1 | got_hash)" || true
      [ -n "$hash" ] || {
        echo "noir-nix: could not fetch $entry" >&2
        exit 1
      }
      entries+=("${entry%\}},\"hash\":\"$hash\"}")
    done <<<"$missing"
  done
  printf '{"aztecToolchainNpmDeps":"%s","gitDeps":%s}\n' "$npm_hash" \
    "$(nix eval --json -f "$nix_dir/lock.nix" gitDeps --argstr dirs "$dirs" --argstr found "$(found)")"
}

# As the container's PID 1, bash ignores a signal it has no handler for, so Ctrl-C would leave the build running.
# PID 1 exiting ends every process in the container.
trap 'exit 130' INT TERM
"$@" &
wait "$!"
