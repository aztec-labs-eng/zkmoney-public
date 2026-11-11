/**
 * Storage migration: the desktop-send marker older builds saved under the page's root. Remove when
 * no supported build older than the one that writes `acct/unresolved-send` v1 remains.
 */
import type { Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { decodeRecord, encodeRecord } from "../engine/persistentStore"
import type { UnresolvedSend } from "../engine/unresolvedSends"

/**
 * The legacy marker an older build saved under the page's root, as the store keeps it under `hold`;
 * undefined for one that does not read as a hold.
 */
function carried(raw: string, hold: UnresolvedSend["id"]): UnresolvedSend | undefined {
  let parsed: Partial<UnresolvedSend> | null
  try {
    parsed = decodeRecord(raw) as Partial<UnresolvedSend> | null
  } catch {
    return undefined // the decode boundary: an unreadable marker reads as no hold
  }
  if (!parsed || typeof parsed.address !== "string" || typeof parsed.at !== "number")
    return undefined
  const send: UnresolvedSend = { id: hold, address: parsed.address, at: parsed.at }
  if (typeof parsed.submission === "string") send.submission = parsed.submission
  return send
}

/**
 * Version 1 carries the marker older builds saved under the page's root for this network and
 * account, and removes it in the same write: the chain cannot say that a desktop approval may still
 * send. A marker that does not read as a hold is dropped, so the open never fails on it.
 */
export async function migrateUnresolvedSends(
  from: number | undefined,
  w: Write,
  {
    prefix,
    hold,
    legacyKey,
  }: { prefix: string; hold: UnresolvedSend["id"]; legacyKey?: () => string | undefined },
): Promise<void> {
  if (from !== undefined)
    throw new WalletError("invariant", `unresolvedSends: unknown version ${from}`)
  const key = legacyKey?.()
  if (!key) return
  const raw = await w.get(key)
  if (raw === undefined) return
  const send = carried(raw, hold)
  if (send) w.put(`${prefix}/${hold}`, encodeRecord(send))
  w.remove(key)
}
