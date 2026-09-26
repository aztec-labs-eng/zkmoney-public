/**
 * The active session's pointers and cache.
 *
 * The storage id is `sha256("zk.money/storage-id" || msk)`: a public identifier that follows the
 * master secret, so it is stable across rollup migration (new address). The pointers name the
 * account whose namespace `WebStorageAdapter` writes under and the passkey the session was entered
 * with. The cache holds the master key itself, in the clear (an accepted risk), so a reload or a
 * later tab opens without a passkey ceremony. Global (unprefixed) keys by design. No-ops without
 * `localStorage`.
 *
 * Readers take the pointers per call. The PXE's OPFS store admits one tab per origin, so writes
 * here do not race another tab.
 */
import { withWebLock } from "./webLock"

const ID_KEY = "webwallet.storageId"
const CREDENTIAL_KEY = "webwallet.credentialId"
const MSK_KEY = "webwallet.msk"
const SESSION_LOCK = "webwallet.session"
const DOMAIN = new TextEncoder().encode("zk.money/storage-id")

/** The whole tuple, for a caller that has to treat the session as one thing. */
export const SESSION_TUPLE_KEYS: readonly string[] = [ID_KEY, CREDENTIAL_KEY, MSK_KEY]

const store = () => (typeof localStorage === "undefined" ? undefined : localStorage)

export function getActiveStorageId(): string | null {
  return store()?.getItem(ID_KEY) ?? null
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

export function setActiveStorageId(id: string): void {
  store()?.setItem(ID_KEY, id)
  notifyScope()
}

/** The passkey the active session was entered with — refresh-unlock asserts against it. */
export function getActiveCredentialId(): string | null {
  return store()?.getItem(CREDENTIAL_KEY) ?? null
}

export function setActiveCredentialId(id: string): void {
  store()?.setItem(CREDENTIAL_KEY, id)
}

export function clearActiveCredentialId(): void {
  store()?.removeItem(CREDENTIAL_KEY)
}

/** The tuple's writers and its compare-and-remove cleanups take turns across tabs. */
export function withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
  return withWebLock(SESSION_LOCK, fn)
}

/** "This browser has no session": both pointers and the cached key go together. */
export function clearActiveStorage(): void {
  store()?.removeItem(ID_KEY)
  store()?.removeItem(CREDENTIAL_KEY)
  store()?.removeItem(MSK_KEY)
  notifyScope()
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
  const raw = store()?.getItem(MSK_KEY)
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
  store()?.setItem(MSK_KEY, JSON.stringify(cache))
}

export function clearCachedMsk(): void {
  store()?.removeItem(MSK_KEY)
}
