/**
 * The session a retired rollup's database kept. A move to a new rollup opens an empty wallet
 * database, so a browser signed in before the move holds no session after it. This one lets /enter
 * sign it in again from the cached key with no prompt; the chain picks the account, as for any
 * sign-in. Nothing is copied here: that sign-in writes this rollup's session.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
  SESSION_TUPLE_KEYS,
  getActiveStorageId,
  sessionCacheIn,
  storageIdFromSecret,
} from "../storage/activeStorage"
import { PASSKEY_IDENTITY_MAP_KEY, WEB_STORAGE_PREFIX } from "../storage/storageKeys"
import { readEntriesFromOtherDatabases } from "../storage/walletStorage"
import { openingRecordIn, type RetiredRecord } from "./WebPasskeyIdentityMap"

export type RetiredSession = {
  storageId: string
  credentialId: string
  msk: Fr
  record: RetiredRecord
}

const MAP_KEY = WEB_STORAGE_PREFIX + PASSKEY_IDENTITY_MAP_KEY

let found: RetiredSession | undefined

/** Looked up once this tab holds the wallet database, before the app mounts. Never throws. */
export async function findRetiredSession(rpId: string): Promise<void> {
  found = undefined
  if (getActiveStorageId() !== null) return
  try {
    found = await readRetiredSession(rpId)
  } catch (e) {
    console.warn("[retiredSession] could not read retired sessions:", e)
  }
}

async function readRetiredSession(rpId: string): Promise<RetiredSession | undefined> {
  const sessions: RetiredSession[] = []
  for (const entries of await readEntriesFromOtherDatabases([...SESSION_TUPLE_KEYS, MAP_KEY])) {
    const cache = sessionCacheIn(entries)
    const record = cache
      ? openingRecordIn(entries.get(MAP_KEY), rpId, cache.credentialId)
      : undefined
    if (!cache || !record) continue
    let msk: Fr
    try {
      msk = Fr.fromHexString(cache.msk)
    } catch {
      continue
    }
    if ((await storageIdFromSecret(new Uint8Array(msk.toBuffer()))) !== cache.storageId) continue
    sessions.push({ storageId: cache.storageId, credentialId: cache.credentialId, msk, record })
  }
  // Retired databases naming different sessions: none of them is known to be the latest.
  const [first] = sessions
  const agree = sessions.every(
    (s) => s.storageId === first?.storageId && s.credentialId === first.credentialId,
  )
  return agree ? first : undefined
}

/** The retired session, while this rollup holds no session of its own. */
export function retiredSession(): RetiredSession | undefined {
  return found && getActiveStorageId() === null ? found : undefined
}

export function forgetRetiredSession(): void {
  found = undefined
}
