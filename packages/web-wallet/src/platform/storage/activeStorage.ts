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
 * Readers take them from the page's device store (`deviceKeys.ts`). Only the active tab opens the
 * wallet database, so writes here do not race another tab.
 */
import type { Database } from "@obsidion/front-core"
import { DEVICE_KEYS, writeDeviceKeys, type DeviceState } from "./deviceKeys"
import { removeOldWalletKeys } from "./storageMigrations/oldLocalStorage"
import { removeFromOtherDatabases, walletStoreIsPersistent } from "./walletStorage"

const ID_KEY = DEVICE_KEYS.storageId
const CREDENTIAL_KEY = DEVICE_KEYS.credentialId
const MSK_KEY = DEVICE_KEYS.msk
const DOMAIN = new TextEncoder().encode("zk.money/storage-id")

/** The whole tuple, for a caller that has to treat the session as one thing. */
export const SESSION_TUPLE_KEYS: readonly string[] = [ID_KEY, CREDENTIAL_KEY, MSK_KEY]

/** Runs `fn` after every earlier call's `fn` has settled. */
export type SessionLock = <T>(fn: () => Promise<T>) => Promise<T>

/**
 * The page's lock for session commits and sign-outs: each reads the session it replaces, or may
 * put back, before it writes, so none may run between another's read and write.
 */
export function sessionLock(): SessionLock {
  let turn: Promise<unknown> = Promise.resolve()
  return (fn) => {
    const run = turn.then(fn)
    turn = run.catch(() => {})
    return run
  }
}

/** The tuple as device-key values; null for an absent key. */
export type SessionTuple = Record<"storageId" | "credentialId" | "msk", string | null>

/** "This browser has no session": both pointers and the cached key go together. */
export const NO_SESSION: SessionTuple = { storageId: null, credentialId: null, msk: null }

/** The saved tuple, raw, so a switch that does not go through can put it back as it was. */
export const tupleOf = ({ storageId, credentialId, msk }: DeviceState): SessionTuple => ({
  storageId,
  credentialId,
  msk,
})

/** Saves the whole tuple as one transaction. */
export function writeSessionTuple(db: Database, tuple: SessionTuple): Promise<void> {
  return writeDeviceKeys(db, tuple)
}

/**
 * The tuple out of every other rollup's database, and any copy of it an older build left in
 * `localStorage` (an older-build tab may write one after this tab's boot); rejects if a copy
 * cannot be removed. This database, `rollup`'s, is the caller's.
 */
export async function clearSessionEverywhere(rollup: string): Promise<void> {
  if (!walletStoreIsPersistent()) return
  await removeFromOtherDatabases(SESSION_TUPLE_KEYS)
  removeOldWalletKeys(rollup, SESSION_TUPLE_KEYS)
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
 * The saved cache, or null when absent or of another shape. A blob this wallet did not write is left
 * alone here: the next commit overwrites it and a sign-out removes it.
 */
export const cachedMsk = (device: DeviceState): CachedMsk | null => parseCachedMsk(device.msk)

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

/** The cached key of a tuple read out of another rollup's database, when it is bound to that tuple. */
export function sessionCacheIn(entries: ReadonlyMap<string, string>): CachedMsk | null {
  const cache = parseCachedMsk(entries.get(MSK_KEY) ?? null)
  const bound =
    cache?.storageId === entries.get(ID_KEY) && cache?.credentialId === entries.get(CREDENTIAL_KEY)
  return bound ? cache : null
}

export function clearCachedMsk(db: Database): Promise<void> {
  return writeDeviceKeys(db, { msk: null })
}
