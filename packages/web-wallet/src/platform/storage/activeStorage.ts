/**
 * The active session's pointers and cache.
 *
 * The storage id is `sha256("zk.money/storage-id" || msk)`: a public identifier that follows the
 * master secret, so it is stable across rollup migration (new address). The pointers name the
 * account whose namespace `WebStorageAdapter` writes under and the passkey the session was entered
 * with. The cache holds the master key itself, in the clear (an accepted risk), so a reload or a
 * later tab opens without a passkey ceremony. The keys sit outside the account namespace, in the
 * rollup's wallet database.
 *
 * Readers take the pointers per call. Only the active tab opens the wallet database, so writes here
 * do not race another tab.
 */
import { removeOldWalletKeys } from "./rollupStorage"
import { removeFromOtherDatabases, walletStorage, walletStoreIsPersistent } from "./walletStorage"

const ID_KEY = "webwallet.storageId"
const CREDENTIAL_KEY = "webwallet.credentialId"
const MSK_KEY = "webwallet.msk"
const DOMAIN = new TextEncoder().encode("zk.money/storage-id")

/** The whole tuple, for a caller that has to treat the session as one thing. */
export const SESSION_TUPLE_KEYS: readonly string[] = [ID_KEY, CREDENTIAL_KEY, MSK_KEY]

/**
 * The saved pointer, never one still being written: the namespace moves only once the session that
 * owns it is saved, together with the key the commit then installs.
 */
export function getActiveStorageId(): string | null {
  return walletStorage.getCommitted(ID_KEY)
}

const scopeListeners = new Set<() => void>()

/** Fires when this page commits or clears the active storage id. */
export function onActiveStorageIdChange(listener: () => void): () => void {
  scopeListeners.add(listener)
  return () => scopeListeners.delete(listener)
}

const notifyScope = () => {
  for (const listener of [...scopeListeners]) listener()
}

walletStorage.onCommit((ops) => {
  if (ops.some(([key]) => key === ID_KEY)) notifyScope()
})

export function setActiveStorageId(id: string): void {
  walletStorage.setItem(ID_KEY, id)
}

/** The passkey the active session was entered with — refresh-unlock asserts against it. */
export function getActiveCredentialId(): string | null {
  return walletStorage.getCommitted(CREDENTIAL_KEY)
}

export function setActiveCredentialId(id: string): void {
  walletStorage.setItem(CREDENTIAL_KEY, id)
}

export function clearActiveCredentialId(): void {
  walletStorage.removeItem(CREDENTIAL_KEY)
}

let sessionTurn: Promise<unknown> = Promise.resolve()

/**
 * Session commits and sign-outs on this page take turns: each reads the session it replaces, or may
 * put back, before it writes, so none may run between another's read and write.
 */
export function withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = sessionTurn.then(fn)
  sessionTurn = run.catch(() => {})
  return run
}

/** The stored tuple, raw, so a switch that does not go through can put it back as it was. */
export function readSessionTuple(): Array<[string, string | null]> {
  return SESSION_TUPLE_KEYS.map((key) => [key, walletStorage.getItem(key)])
}

export function writeSessionTuple(tuple: ReadonlyArray<readonly [string, string | null]>): void {
  for (const [key, value] of tuple) {
    if (value === null) walletStorage.removeItem(key)
    else walletStorage.setItem(key, value)
  }
}

/** "This browser has no session": both pointers and the cached key go together. */
export function clearActiveStorage(): void {
  walletStorage.removeItem(ID_KEY)
  walletStorage.removeItem(CREDENTIAL_KEY)
  walletStorage.removeItem(MSK_KEY)
}

/**
 * The tuple out of every other rollup's database, and any copy of it an older build left in
 * `localStorage` (an older-build tab may write one after this tab's boot); rejects if a copy
 * cannot be removed. This database is the caller's.
 */
export async function clearSessionEverywhere(): Promise<void> {
  if (!walletStoreIsPersistent()) return
  await removeFromOtherDatabases(SESSION_TUPLE_KEYS)
  removeOldWalletKeys(SESSION_TUPLE_KEYS)
}

/** The session as saved, ignoring writes still in flight: what a cache restore may trust. */
export function readCommittedSession(): {
  storageId: string | null
  credentialId: string | null
  cache: CachedMsk | null
} {
  return {
    storageId: walletStorage.getCommitted(ID_KEY),
    credentialId: walletStorage.getCommitted(CREDENTIAL_KEY),
    cache: parseCachedMsk(walletStorage.getCommitted(MSK_KEY)),
  }
}

export async function storageIdFromSecret(msk: Uint8Array): Promise<string> {
  const preimage = new Uint8Array([...DOMAIN, ...msk])
  const digest = await crypto.subtle.digest("SHA-256", preimage)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

/** The cached master key, bound to the session it was committed under. `msk` is 0x-prefixed hex. */
export type CachedMsk = { v: 1; storageId: string; credentialId: string; msk: string }

const isHex32 = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)

/**
 * The cache as stored, or null when absent or of another shape. A blob this wallet did not write
 * is left alone here: the next commit overwrites it and a sign-out removes it, so no read has to
 * race another tab's write to get rid of it.
 */
export function readCachedMsk(): CachedMsk | null {
  return parseCachedMsk(walletStorage.getItem(MSK_KEY))
}

function parseCachedMsk(raw: string | null): CachedMsk | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<CachedMsk>
    if (
      parsed.v === 1 &&
      typeof parsed.storageId === "string" &&
      typeof parsed.credentialId === "string" &&
      isHex32(parsed.msk)
    ) {
      return {
        v: 1,
        storageId: parsed.storageId,
        credentialId: parsed.credentialId,
        msk: parsed.msk,
      }
    }
  } catch {
    // Not JSON: no cache.
  }
  return null
}

export function writeCachedMsk(cache: CachedMsk): void {
  walletStorage.setItem(MSK_KEY, JSON.stringify(cache))
}

export function clearCachedMsk(): void {
  walletStorage.removeItem(MSK_KEY)
}
