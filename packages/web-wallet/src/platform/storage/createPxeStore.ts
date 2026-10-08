import { AztecSQLiteOPFSStore } from "@aztec/kv-store/sqlite-opfs"
import { createLogger } from "@aztec/foundation/log"
import { openPooledStore } from "./openPooledStore"

/**
 * Safari Private Browsing rejects `navigator.storage.getDirectory()` (an ephemeral WebKit session
 * has no storage directory), so the OPFS SAH pool cannot open there. Fails closed.
 */
export async function opfsAvailable(): Promise<boolean> {
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
 * The store's OPFS names: `pxe_data_<rollup>` as upstream `@aztec/wallets`' BrowserEmbeddedWallet
 * names it, plus `_<digest>` of the node endpoint when the node is not the default, so a custom
 * node never writes into the default node's store. `digest` is required, `undefined` for the default
 * node, so a caller cannot drop it by omission.
 */
export function pxeStoreNames(rollupAddress: string, digest: string | undefined) {
  const scope = digest === undefined ? rollupAddress : `${rollupAddress}_${digest}`
  return { dbName: `pxe_data_${scope}`, directory: `.aztec-kv-pxe-${scope}` }
}

/**
 * The PXE data store: sqlite over OPFS (worker + SAH pool), scoped by rollup
 * address so a chain wipe opens a fresh DB instead of syncing stale state.
 * Replaces the lazy client's default IndexedDB store, whose cursor iteration
 * interleaves awaits and dies with TransactionInactiveError under WASM
 * main-thread load. Without OPFS (Safari Private Browsing) the DB lives in
 * memory for the page's lifetime instead.
 */
export async function createPxeStore(
  rollupAddress: string,
  digest: string | undefined,
): Promise<AztecSQLiteOPFSStore> {
  const log = createLogger("web-wallet:pxe:data")
  if (!(await opfsAvailable())) {
    log.warn("OPFS unavailable (private browsing?): PXE store runs in memory and is lost on reload")
    return AztecSQLiteOPFSStore.open(log, undefined, true)
  }
  const { dbName, directory } = pxeStoreNames(rollupAddress, digest)
  return openPooledStore(log, dbName, directory)
}
