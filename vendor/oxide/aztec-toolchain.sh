#!/usr/bin/env bash
# Shared Aztec toolchain pin and preflight for the bootstrap scripts. Source this file, do not run it.
#
# The repo builds with the aztec-up toolchain release below and calls only its prefixed binaries
# (`aztec`, `aztec-nargo`, `aztec-bb`, `aztec-txe`, `aztec-forge`, `aztec-cast`, `aztec-anvil`). Install or switch with:
#   aztec-up install <version> && aztec-up use <version>
# Docs: https://docs.aztec.network/developers/getting_started_on_local_network#install-the-aztec-toolchain

AZTEC_TOOLCHAIN_VERSION="6.0.0"

# `aztec compile` and bb.js read these to pick a different nargo / bb. The toolchain's own must win.
unset NARGO BB BB_BINARY_PATH
# The `aztec` npm shim re-execs through `aztec-up env` when it finds a .aztecrc. Stay on the checked release.
export AZTEC_VERSIONED=1

# require_aztec_toolchain <tool>... — node, `aztec`, and every named tool must be on PATH, and `aztec --version`
# must report the pinned release. Callers name only the tools they run (for example `aztec-nargo` for fmt). The
# prefixed names exist only in an aztec-up install and ship together, so one version check covers all of them.
# The compiled bytecode, and so every on-chain contract class id, follows the release, so a drifted toolchain
# must fail here and never produce artifacts. The version call costs ~1 s (node startup); a process that passed
# exports AZTEC_TOOLCHAIN_CHECKED so later calls, including children such as a `parallel` fan-out, only check
# that the tools exist.
require_aztec_toolchain() {
  local tool
  command -v node >/dev/null 2>&1 || { echo "node not found on PATH. The Aztec toolchain needs Node.js 24." >&2; return 1; }
  for tool in aztec "$@"; do
    command -v "$tool" >/dev/null 2>&1 || {
      echo "$tool not found on PATH. Install the Aztec toolchain:" >&2
      echo "  aztec-up install ${AZTEC_TOOLCHAIN_VERSION} && aztec-up use ${AZTEC_TOOLCHAIN_VERSION}" >&2
      return 1
    }
  done
  [ "${AZTEC_TOOLCHAIN_CHECKED:-}" = "$AZTEC_TOOLCHAIN_VERSION" ] && return 0
  local got
  got="$(aztec --version 2>/dev/null | tail -1 || true)"
  if [ "$got" != "$AZTEC_TOOLCHAIN_VERSION" ]; then
    echo "aztec toolchain mismatch: 'aztec --version' reports '${got:-nothing}'; this repo builds with ${AZTEC_TOOLCHAIN_VERSION}." >&2
    echo "Fix: aztec-up install ${AZTEC_TOOLCHAIN_VERSION} && aztec-up use ${AZTEC_TOOLCHAIN_VERSION}" >&2
    return 1
  fi
  export AZTEC_TOOLCHAIN_CHECKED="$AZTEC_TOOLCHAIN_VERSION"
}
