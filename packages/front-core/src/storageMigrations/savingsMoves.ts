/**
 * Storage migration: the Savings moves older builds kept in one `RecordStorage` blob. Remove when no
 * supported build older than the one that writes `acct/savingsMoves` v1 remains and the rollup
 * migration (ZKM-1625) reads no legacy blob.
 */
import type { SavingsMoveRecord } from "../core/services/savings/types"
import type { Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { logger } from "../utils/logger"
import { carryRecordBlob } from "./recordBlob"

export const KEY_SAVINGS_MOVES = "@obsidion/savings/moves"

/** The blob's moves, unchecked but for their key; none when it does not parse. */
export function legacySavingsMoves(raw: string | null | undefined): SavingsMoveRecord[] {
  if (typeof raw !== "string") return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined // the decode boundary: a retired database's damaged blob carries nothing
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logger.warn("[savingsMoves] a retired database holds a malformed Savings move blob")
    return []
  }
  return Object.values(parsed).filter(
    (v): v is SavingsMoveRecord =>
      !!v &&
      typeof v === "object" &&
      typeof (v as SavingsMoveRecord).withdrawalLocalId === "string",
  )
}

/**
 * Version 1 carries every move of the blob as saved, its `retired` and `recovered` marks included.
 * A blob that does not parse, or one move that fails `toRecord`, fails the open with nothing
 * written: a move holds funds in flight. The blob stays for one release.
 */
export async function migrateSavingsMoves<R>(
  from: number | undefined,
  w: Write,
  store: { prefix: string; id(record: R): string },
  toRecord: (value: unknown, key: string) => R,
): Promise<void> {
  if (from !== undefined)
    throw new WalletError("invariant", `savingsMoves: unknown version ${from}`)
  await carryRecordBlob(w, KEY_SAVINGS_MOVES, store, toRecord)
}
