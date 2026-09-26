import { AztecSQLiteOPFSStore } from "@aztec/kv-store/sqlite-opfs"
import { createLogger } from "@aztec/foundation/log"

/**
 * Safari Private Browsing rejects `navigator.storage.getDirectory()` (an ephemeral WebKit session
 * has no storage directory), so the OPFS SAH pool cannot open there. Fails closed.
 */
async function opfsAvailable(): Promise<boolean> {
  if (typeof navigator.storage?.getDirectory !== "function") return false
  if (typeof navigator.locks?.request !== "function") return false
  try {
    await navigator.storage.getDirectory()
    return true
  } catch {
    return false
  }
}

/**
 * The PXE data store: sqlite over OPFS (worker + SAH pool), scoped by rollup
 * address so a chain wipe opens a fresh DB instead of syncing stale state —
 * the same `pxe_data_<rollup>` convention as upstream `@aztec/wallets`'
 * BrowserEmbeddedWallet. Replaces the lazy client's default IndexedDB store,
 * whose cursor iteration interleaves awaits and dies with
 * TransactionInactiveError under WASM main-thread load. Without OPFS (Safari
 * Private Browsing) the DB lives in memory for the page's lifetime instead.
 */
export async function createPxeStore(rollupAddress: string): Promise<AztecSQLiteOPFSStore> {
  const log = createLogger("web-wallet:pxe:data")
  if (!(await opfsAvailable())) {
    log.warn("OPFS unavailable (private browsing?): PXE store runs in memory and is lost on reload")
    return AztecSQLiteOPFSStore.open(log, undefined, true)
  }
  return AztecSQLiteOPFSStore.open(
    log,
    `pxe_data_${rollupAddress}`,
    false,
    `.aztec-kv-pxe-${rollupAddress}`,
  )
}
