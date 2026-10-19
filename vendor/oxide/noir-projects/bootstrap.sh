#!/usr/bin/env bash
# Builds the noir projects in this directory with the aztec-up toolchain (../aztec-toolchain.sh holds the pinned
# release). `build` iterates over every `*/Nargo.toml` and dispatches on the package `type`:
#   - contract : `aztec compile` (nargo + bb aztec_process + version stamp) — an L2 Aztec contract;
#                its artifact JSON is consumed by yarn-project codegen.
#   - bin      : `aztec-nargo compile` + `aztec-bb write_vk` → `<pkg>/target/keys/vk`.
#   - lib      : skipped (compiled only as a dependency of the above).
#
# Usage:
#   ./bootstrap.sh                # build every noir package (default)
#   ./bootstrap.sh <package>      # build a single package by directory name (e.g. resolver_circuit)
#   ./bootstrap.sh format         # `aztec-nargo fmt` across every package
#   ./bootstrap.sh format --check # `aztec-nargo fmt --check` (CI mode, non-zero on diffs)
#   ./bootstrap.sh test           # `aztec-nargo test` across every package (launches a TXE oracle resolver)
#   ./bootstrap.sh clean          # remove every package's target/ dir
#   ./bootstrap.sh clean-lite     # same scoped artifact cleanup
set -euo pipefail

cd "$(dirname "$0")"

# shellcheck source=../aztec-toolchain.sh
source ../aztec-toolchain.sh

require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "$1 not found on PATH; $2" >&2; exit 1; }; }

# Reads the `type = "..."` field from a package's Nargo.toml (empty if absent).
pkg_type() { sed -n 's/^[[:space:]]*type[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$1/Nargo.toml" | head -1; }

# Compiles an Aztec contract.
build_contract() {
  local name="$1"
  require_aztec_toolchain
  echo "==> aztec compile $name (contract)"
  (cd "$name" && aztec compile --silence-warnings --inliner-aggressiveness 0 --package "$name")
}

# Compiles a pure Noir circuit and writes its EVM-targeted Honk vk.
build_circuit() {
  local name="$1"
  require_aztec_toolchain aztec-nargo aztec-bb
  echo "==> aztec-nargo compile $name (circuit)"
  (
    cd "$name"
    aztec-nargo compile --silence-warnings --package "$name"

    json="target/$name.json"
    [ -f "$json" ] || { echo "Error: expected '$name/$json' was not produced." >&2; exit 1; }

    local target=evm
    case "$name" in
      frozen_notes_refund|frozen_deposit_refund|unprocessed_deposit_refund) target=evm-no-zk ;;
    esac
    mkdir -p target/keys
    aztec-bb write_vk -b "$json" -o target/keys -t "$target"
    echo "Wrote $name/target/keys/vk"
  )
}

build_one() {
  local name="$1"
  [ -f "$name/Nargo.toml" ] || { echo "Unknown package: $name" >&2; exit 1; }
  case "$(pkg_type "$name")" in
    contract) build_contract "$name" ;;
    lib)      echo "==> skip $name (lib)" ;;
    *)        build_circuit "$name" ;;
  esac
}

require_parallel() {
  if command -v parallel >/dev/null && [[ "$(parallel --version 2>/dev/null)" == "GNU parallel "* ]]; then
    return
  fi
  echo "GNU Parallel not found; install it with 'apt install parallel' or 'brew install parallel'." >&2
  return 1
}

# Follow Aztec's cgroup-aware CPU detection for CI and local containers.
# https://github.com/AztecProtocol/aztec-packages/blob/next/ci3/source_stdlib
get_num_cpus() {
  if [ -f /sys/fs/cgroup/cpu.max ]; then
    read -r cpu_quota cpu_period < /sys/fs/cgroup/cpu.max
    if [[ "$cpu_quota" == "max" ]]; then
      nproc
    else
      echo $((cpu_quota / cpu_period))
    fi
  elif [[ "$(uname)" == "Darwin" ]]; then
    sysctl -n hw.ncpu
  else
    nproc
  fi
}

build() {
  local num_cpus jobs
  require_parallel
  # Preflight the whole build once: contracts need `aztec`, circuits need `aztec-nargo` and `aztec-bb`. The
  # children below inherit AZTEC_TOOLCHAIN_CHECKED and skip the version call.
  require_aztec_toolchain aztec-nargo aztec-bb
  num_cpus="$(get_num_cpus)"
  if [[ ! "$num_cpus" =~ ^[1-9][0-9]*$ ]]; then
    num_cpus=1
  fi

  # Follow Aztec's two-workstream build, capped by detected CPUs.
  # https://github.com/AztecProtocol/aztec-packages/blob/next/noir/bootstrap.sh
  jobs="${NOIR_BUILD_JOBS:-2}"
  if [[ ! "$jobs" =~ ^[1-9][0-9]*$ ]]; then
    echo "NOIR_BUILD_JOBS must be a positive integer" >&2
    return 1
  fi
  [ "$jobs" -le "$num_cpus" ] || jobs="$num_cpus"

  local projects=()
  for proj in */; do
    [ -f "$proj/Nargo.toml" ] || continue
    projects+=("${proj%/}")
  done

  # Package outputs are separate; shared tool caches provide their own locking.
  parallel --will-cite --tag --line-buffer --halt now,fail=1 -j "$jobs" "$PWD/bootstrap.sh" ::: "${projects[@]}"
}

format() {
  require_aztec_toolchain aztec-nargo
  local arg=""; [ "${1:-}" = "--check" ] && arg="--check"
  for proj in */; do
    [ -f "$proj/Nargo.toml" ] || continue
    (cd "$proj" && aztec-nargo fmt $arg)
  done
}

test_cmd() {
  require_cmd nc "install netcat (used to wait for the TXE port)"
  require_aztec_toolchain aztec-nargo aztec-txe

  # TXE `deploy` loads each contract's compiled artifact from its target/, produced by `aztec compile` (not by
  # `aztec-nargo test`). Build the contracts up front so a fresh clone (e.g. CI) has the artifacts before any test
  # deploys them. Doing full noir-project build here would be unnecessarily heavy so we compile just the contracts.
  for proj in */; do
    [ -f "$proj/Nargo.toml" ] || continue
    [ "$(pkg_type "${proj%/}")" = "contract" ] || continue
    build_contract "${proj%/}"
  done

  # Launch the toolchain's TXE as the oracle resolver. It binds 127.0.0.1 and reads its port from TXE_PORT.
  export LOG_LEVEL="${LOG_LEVEL:-error}"
  TXE_PORT=8081 aztec-txe &
  # Not `local`: the EXIT trap fires at global scope after this function returns, so a function-scoped
  # txe_pid would be unbound there under `set -u`.
  txe_pid=$!
  trap 'kill "${txe_pid:-}" &>/dev/null || true' EXIT
  # Wait until it listens. Fail fast if it exits, and give up after 120 s so a stalled TXE cannot hang the run.
  local polls=0
  while ! nc -z 127.0.0.1 8081 &>/dev/null; do
    kill -0 "$txe_pid" &>/dev/null || { echo "TXE exited before listening on 127.0.0.1:8081" >&2; return 1; }
    [ "$polls" -lt 600 ] || { echo "TXE did not listen on 127.0.0.1:8081 within 120 s" >&2; return 1; }
    sleep 0.2
    polls=$((polls + 1))
  done
  export NARGO_FOREIGN_CALL_TIMEOUT=300000

  local failed=()
  for proj in */; do
    [ -f "$proj/Nargo.toml" ] || continue
    echo "==> aztec-nargo test ($proj)"
    (cd "$proj" && aztec-nargo test --oracle-resolver http://127.0.0.1:8081 "$@") || failed+=("$proj")
  done
  [ "${#failed[@]}" -eq 0 ] || { echo "noir test failures in: ${failed[*]}" >&2; return 1; }
}

clean_lite() {
  echo "==> removing noir target/ dirs"
  rm -rf ./*/target
}

cmd="${1:-all}"
shift || true

case "$cmd" in
  all|build)  build ;;
  format)     format "$@" ;;
  test)       test_cmd "$@" ;;
  clean)      clean_lite ;;
  clean-lite) clean_lite ;;
  *)
    # Treat the args as package directory names — build each in turn.
    for pkg in "$cmd" "$@"; do
      if [ -f "$pkg/Nargo.toml" ]; then
        build_one "$pkg"
      else
        echo "Unknown target: $pkg" >&2
        echo "Usage: $0 [all|<package>...|format [--check]|test|clean|clean-lite]" >&2
        exit 1
      fi
    done
    ;;
esac
