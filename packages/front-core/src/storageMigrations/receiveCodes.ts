/**
 * Storage migration: the Receive codes older builds kept under the page's root, one key per network
 * and tag. Remove when no supported build older than the one that writes `acct/receiveCodes` v1
 * remains.
 */
import { REQUEST_STORAGE_KEY } from "../core/storages/storage-constants"
import type { Database, Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { decodeRecord, encodeRecord } from "../engine/persistentStore"
import { isReceiveCode } from "../engine/receiveCodes"

/** Older builds' key prefix; the code's id, `<networkId>.<tag>`, follows it. */
export const LEGACY_RECEIVE_CODE_PREFIX = "webwallet.receiveCode."
/** Not a code: the ids of codes minted without an amount, which the requests migration reads. */
export const LEGACY_UNLISTED_KEY = `${LEGACY_RECEIVE_CODE_PREFIX}unlisted`

/** The request ids in this namespace's legacy requests blob; none when it does not read. */
async function legacyRequestIds(w: Write): Promise<Set<unknown>> {
  const raw = await w.get(REQUEST_STORAGE_KEY)
  if (raw === undefined) return new Set()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Set() // the decode boundary: the code's request is looked for in the store too
  }
  const rows = (parsed as { requests?: unknown } | null)?.requests
  return new Set(Array.isArray(rows) ? rows.map((row) => (row as { id?: unknown })?.id) : [])
}

/**
 * Version 1 carries each code under the page's root to its id. The root holds no account, so a code
 * is carried only into the namespace whose requests hold its request. A code that does not read is
 * dropped: Receive mints a new one, and its address stays tracked by the SIPA deposits. The keys
 * stay for one release.
 */
export async function migrateReceiveCodes(
  from: number | undefined,
  w: Write,
  { prefix, legacy }: { prefix: string; legacy: Pick<Database, "range"> },
): Promise<void> {
  if (from !== undefined)
    throw new WalletError("invariant", `receiveCodes: unknown version ${from}`)
  const legacyIds = await legacyRequestIds(w)
  const ours = async ({ requestId }: { requestId: string }) =>
    legacyIds.has(requestId) ||
    (!requestId.includes("/") && (await w.get(`acct/requests/${requestId}`)) !== undefined)
  for (const [key, raw] of await legacy.range(LEGACY_RECEIVE_CODE_PREFIX)) {
    const id = key.slice(LEGACY_RECEIVE_CODE_PREFIX.length)
    if (key === LEGACY_UNLISTED_KEY || id.includes("/")) continue
    let code: unknown
    try {
      code = decodeRecord(raw)
    } catch {
      continue // the decode boundary: an unreadable code is minted again
    }
    if (isReceiveCode(code) && (await ours(code)))
      w.put(`${prefix}/${id}`, encodeRecord({ id, code }))
  }
}
