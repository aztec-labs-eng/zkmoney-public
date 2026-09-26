/**
 * Something the wipe could not clear: held by another tab or page, queued behind another tab's open
 * connection (a delete can't be cancelled, so it lands when that tab closes), or refused by the
 * browser. `item` is the entry's name, or `*` when the whole kind could not be reached.
 */
export type Leftover = {
  kind: "files" | "databases" | "localStorage" | "sessionStorage"
  item: string
  reason: "busy" | "pending" | "unavailable"
}

type Outcome = "cleared" | Leftover["reason"]

export interface ClearSiteDataDeps {
  opfsRoot(): Promise<FileSystemDirectoryHandle>
  loadPools(): Promise<{ prefix: string; deletePoolDirectory(dir: string): Promise<void> }>
  indexedDB(): IDBFactory
  localStorage(): Storage
  sessionStorage(): Storage
}

const browserDeps: ClearSiteDataDeps = {
  opfsRoot: () => navigator.storage.getDirectory(),
  loadPools: async () => {
    const { OPFS_POOL_DIR_PREFIX, deletePoolDirectory } = await import(
      "@aztec/kv-store/sqlite-opfs"
    )
    return { prefix: OPFS_POOL_DIR_PREFIX, deletePoolDirectory }
  },
  indexedDB: () => indexedDB,
  localStorage: () => localStorage,
  sessionStorage: () => sessionStorage,
}

// A page that just closed releases its OPFS handles and pool lock a moment later.
const TRANSIENT = new Set([
  "SqlitePoolBusyError",
  "NoModificationAllowedError",
  "InvalidModificationError",
])
const RETRIES = 8
const RETRY_MS = 250
export const DB_DELETE_DEADLINE_MS = 3_000
export const FILES_DEADLINE_MS = 15_000

const errorName = (e: unknown) => (e as { name?: unknown } | null)?.name

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(resolve, ms, "timeout")))
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function withRetry(remove: () => Promise<void>, stop: AbortSignal): Promise<Outcome> {
  for (let attempt = 0; ; attempt++) {
    if (stop.aborted) return "busy"
    try {
      await remove()
      return "cleared"
    } catch (e) {
      if (errorName(e) === "NotFoundError") return "cleared"
      if (!TRANSIENT.has(String(errorName(e)))) return "unavailable"
      if (attempt >= RETRIES) return "busy"
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
    }
  }
}

/**
 * The deadline runs from the request: a delete queued behind an open connection may never fire an
 * event.
 */
function deleteDatabase(idb: IDBFactory, name: string): Promise<Outcome> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest | undefined
    const settle = (outcome: Outcome) => {
      clearTimeout(timer)
      if (request) request.onsuccess = request.onerror = null
      resolve(outcome)
    }
    const timer = setTimeout(() => settle("pending"), DB_DELETE_DEADLINE_MS)
    try {
      request = idb.deleteDatabase(name)
    } catch {
      settle("unavailable")
      return
    }
    request.onsuccess = () => settle("cleared")
    request.onerror = () => settle("unavailable")
  })
}

async function clearOpfs(
  deps: ClearSiteDataDeps,
  left: Leftover[],
  stop: AbortSignal,
): Promise<void> {
  const root = await deps.opfsRoot()
  const pools = await deps.loadPools().catch(() => undefined)
  const entries: [string, FileSystemHandleKind][] = []
  for await (const [name, handle] of root.entries()) entries.push([name, handle.kind])
  for (const [name, kind] of entries) {
    if (stop.aborted) return
    // Aztec pools go through their lock. Without that module a directory may be a live pool, and
    // some browsers let a raw removal through under a live handle, so only plain files go.
    if (!pools && kind === "directory") {
      left.push({ kind: "files", item: name, reason: "unavailable" })
      continue
    }
    const outcome = await withRetry(
      () =>
        pools && name.startsWith(pools.prefix)
          ? pools.deletePoolDirectory(name)
          : root.removeEntry(name, { recursive: true }),
      stop,
    )
    if (outcome !== "cleared") left.push({ kind: "files", item: name, reason: outcome })
  }
}

async function clearIndexedDb(deps: ClearSiteDataDeps, left: Leftover[]): Promise<void> {
  const idb = deps.indexedDB()
  for (const { name } of await idb.databases()) {
    if (name === undefined) continue
    const outcome = await deleteDatabase(idb, name)
    if (outcome !== "cleared") left.push({ kind: "databases", item: name, reason: outcome })
  }
}

/**
 * Deletes everything the wallet keeps in this browser for this origin. Best effort: each kind of
 * storage is cleared on its own, and whatever could not be cleared (or checked) comes back.
 */
export async function clearSiteData(deps: ClearSiteDataDeps = browserDeps): Promise<Leftover[]> {
  const left: Leftover[] = []
  // Bounded so a hung import or removal can't hold the spinner forever. Past the deadline the pass
  // starts no more removals, so it can't delete files a retry or another tab writes afterwards.
  const files: Leftover[] = []
  const stop = new AbortController()
  try {
    if (
      (await withDeadline(clearOpfs(deps, files, stop.signal), FILES_DEADLINE_MS)) === "timeout"
    ) {
      stop.abort()
      files.push({ kind: "files", item: "*", reason: "busy" })
    }
  } catch {
    files.push({ kind: "files", item: "*", reason: "unavailable" })
  }
  left.push(...files)
  try {
    await clearIndexedDb(deps, left)
  } catch {
    left.push({ kind: "databases", item: "*", reason: "unavailable" })
  }
  for (const [kind, storage] of [
    ["localStorage", deps.localStorage],
    ["sessionStorage", deps.sessionStorage],
  ] as const) {
    try {
      storage().clear()
    } catch {
      left.push({ kind, item: "*", reason: "unavailable" })
    }
  }
  return left
}
