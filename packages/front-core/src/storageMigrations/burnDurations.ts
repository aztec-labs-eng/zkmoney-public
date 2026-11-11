/**
 * Storage migration: the burn durations older builds kept as one list. Remove when no supported
 * build older than the one that writes `acct/burnDurations` v1 remains.
 */
import type { Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { encodeRecord } from "../engine/persistentStore"

export const BURN_DURATIONS_KEY = "burnDurations"

/**
 * Version 1 carries the list's valid samples to `key`. A list that does not parse carries none, as
 * older builds read it: a lost sample only widens the next landing window. The list stays for one
 * release.
 */
export async function migrateBurnDurations(
  from: number | undefined,
  w: Write,
  key: string,
): Promise<void> {
  if (from !== undefined)
    throw new WalletError("invariant", `burnDurations: unknown version ${from}`)
  const raw = await w.get(BURN_DURATIONS_KEY)
  if (raw === undefined) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return // the decode boundary: an unreadable list carries no samples
  }
  if (!Array.isArray(parsed)) return
  const seconds = parsed.filter((s): s is number => Number.isFinite(s) && s > 0)
  if (seconds.length) w.put(key, encodeRecord({ id: "samples", seconds }))
}
