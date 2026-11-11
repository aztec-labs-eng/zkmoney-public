/**
 * Storage migration: the withdraw funnel phases older builds reported, kept in one blob. Remove when
 * no supported build older than the one that writes `acct/withdrawFunnel` v1 remains.
 */
import type { Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import type { FunnelMark } from "../engine/withdrawFunnel"
import { carryRecordBlob } from "./recordBlob"

export const WITHDRAW_FUNNEL_KEY = "analytics.withdrawFunnel"

/**
 * Version 1 carries every reported phase, so no phase is reported twice. Older builds read a blob
 * that does not parse as nothing reported, and so does the carry; an entry that names no phase is
 * dropped. The blob stays for one release.
 */
export async function migrateWithdrawFunnel(
  from: number | undefined,
  w: Write,
  prefix: string,
): Promise<void> {
  if (from !== undefined)
    throw new WalletError("invariant", `withdrawFunnel: unknown version ${from}`)
  await carryRecordBlob(
    w,
    WITHDRAW_FUNNEL_KEY,
    { prefix, id: (mark: FunnelMark) => mark.localId },
    (phase, localId): FunnelMark | undefined =>
      phase === "finalizing_l1" || phase === "done" ? { localId, phase } : undefined,
    "empty",
  )
}
