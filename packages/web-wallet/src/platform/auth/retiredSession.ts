/**
 * The session a retired rollup's database kept. A move to a new rollup opens an empty wallet
 * database, so a browser signed in before the move holds no session after it. This one lets /enter
 * sign it in again from the cached key with no prompt; the chain picks the account, as for any
 * sign-in. Nothing is copied here: that sign-in writes this rollup's session.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ReadonlyStore } from "@obsidion/front-core"
import { SESSION_TUPLE_KEYS, sessionCacheIn, storageIdFromSecret } from "../storage/activeStorage"
import type { DeviceState } from "../storage/deviceKeys"
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

/** Looked up once this tab holds the wallet database, before the app mounts. Never throws. */
export async function findRetiredSession(
  device: ReadonlyStore<DeviceState>,
  rpId: string,
): Promise<RetiredSession | undefined> {
  if (device.get().storageId !== null) return undefined
  try {
    return await readRetiredSession(rpId)
  } catch (e) {
    console.warn("[retiredSession] could not read retired sessions:", e)
    return undefined
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
