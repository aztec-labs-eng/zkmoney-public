/** What a backup passkey add's payment shows on its Activity row and its sheet. */
import {
  WITHDRAWAL_TERMINAL_PHASES,
  type BackupFee,
  type FundingRecovery,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import type { StatusLabel } from "@obsidion/web-ds"
import { formatUnits } from "viem"
import { recoveryCopy } from "../../features/backupPasskey/backupPasskeyCopy"
import { fmt } from "../../lib/fmt"
import rowCopy from "../activity/ActivityRow.copy"
import { toCents, usdFigure } from "../format"
import copy from "./WithdrawalDetailModal.copy"

/**
 * A backup passkey add's title, for its funding's or its deposit's row and sheet: added as the feed
 * marks it, not added once it stopped, else `untilAdded`.
 */
export function backupFundingTitle(
  item: { recovery?: FundingRecovery; stopped?: true; added?: true },
  untilAdded: string = rowCopy.counterparty.backupPasskeyFunding,
): string {
  if (item.stopped || (item.recovery && item.recovery.state !== "unread"))
    return recoveryCopy.activity.notAdded
  return item.added ? rowCopy.counterparty.backupPasskeyAdded : untilAdded
}

/**
 * A backup passkey fee's status, on its row and its sheet: a stopped add's recovery, else in
 * progress while the payment is in flight or the add runs, and nothing once the add finished.
 */
export function backupFeeStatus({
  record,
  added,
  running,
  recovery,
}: {
  record: Pick<WithdrawalRecord, "phase">
  added?: true
  running?: true
  recovery?: FundingRecovery
}): StatusLabel | undefined {
  if (recovery) return recoveryCopy.badge[recovery.state]
  if (record.phase === "failed") return rowCopy.status.failed
  if (added) return undefined
  return running || !WITHDRAWAL_TERMINAL_PHASES.has(record.phase)
    ? rowCopy.status.inProgress
    : undefined
}

/** A backup passkey fee's hold in dollars; none below a cent, as when the funding paid only the fee. */
export function backupHold(fee: BackupFee, decimals: number): string | undefined {
  return toCents(fee.hold, decimals, false) > 0n
    ? usdFigure(formatUnits(fee.hold, decimals))
    : undefined
}

/** A backup passkey fee row's line in place of its time: the hold, until it is back. */
export function backupHoldLine(fee: BackupFee, decimals: number): string | undefined {
  const amount = backupHold(fee, decimals)
  return amount && fmt(fee.returned ? rowCopy.hold.returned : rowCopy.hold.held, { amount })
}

/** The note a backup passkey fee's sheet shows while something is left to explain. */
export function backupNote({
  record,
  fee,
  added,
  running,
  exit,
}: {
  record: Pick<WithdrawalRecord, "phase" | "tokenDecimals">
  fee?: BackupFee
  added?: true
  running?: true
  exit: boolean
}): string | undefined {
  if (record.phase === "failed") return copy.backup.failed
  if (exit) return copy.backup.finishYourself
  const held = fee && !fee.returned ? backupHold(fee, record.tokenDecimals) : undefined
  if (held) return fmt(copy.backup.heldNote, { amount: held })
  if (fee?.returned || added || (!running && WITHDRAWAL_TERMINAL_PHASES.has(record.phase)))
    return undefined
  return copy.backup.adding
}
