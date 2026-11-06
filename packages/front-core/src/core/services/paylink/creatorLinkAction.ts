/**
 * Which recovery a creator's own paylink row offers, in the activity list and its detail sheet, and
 * which links a backup passkey add takes back or waits on.
 *
 * Both recoveries spend the escrow's single nullifier, so at most one is ever on offer and neither
 * survives a claim: `cancel` is the in-window refund (`now <= refundableUntil`, a window that opens
 * at creation and may overlap the claim window; offered only while `canCancelAt` says a proof can
 * still land before it closes), `reclaim` is the post-expiry refund (`now > untilClaimable`). The
 * contract decides the branch itself; this only picks the copy. Between the refund window closing
 * and expiry only the recipient can move the funds.
 *
 * The window arithmetic and every material/lifecycle guard come from the shared
 * `isPaylinkInRefundWindow` / `paylinkRefundEligibility`.
 */
import { PAYLINK_CANCEL_MARGIN_SECONDS, PaylinkActionEnum } from "@obsidion/core/constants"
import type { PaylinkTransaction, Transaction } from "../../../types/transactions"
import type { PaylinkStatusKind } from "./paylinkStatus"
import { isPaylinkInRefundWindow, paylinkRefundEligibility } from "./refundParamsFromRow"

export type CreatorLinkAction = "reclaim" | "cancel"

/**
 * True while a creator's cancel can still land before `refundable_until`. The refund tx expires
 * there, and proof + inclusion must finish first, so the offer closes a margin early.
 */
export function canCancelAt(refundableUntil: number, chainNow: number): boolean {
  return chainNow + Number(PAYLINK_CANCEL_MARGIN_SECONDS) < refundableUntil
}

/** Statuses that still hold spendable escrow; anything else has already consumed the nullifier. */
export function paylinkStatusIsUnspent(status: PaylinkStatusKind): boolean {
  return status === "awaitingClaim" || status === "expired"
}

/**
 * A link made on another rollup than `network`, the active one. This build can't act on it there;
 * the upgrade refunds it.
 */
export function isOtherRollupLink(
  row: Pick<PaylinkTransaction, "networkId">,
  network: string | undefined,
): boolean {
  return !!network && !!row.networkId && row.networkId.toLowerCase() !== network.toLowerCase()
}

/**
 * Whether `account` made the link. A row without `obsidionAccountAddress` predates that field and
 * counts as the account's: this wallet's store holds only its own rows.
 */
export function linkMadeBy(row: PaylinkTransaction, account: string): boolean {
  const creator = row.obsidionAccountAddress
  return !creator || creator.toLowerCase() === account.toLowerCase()
}

/**
 * A link `account` made on `network` whose escrow it can still take back, now or after expiry. Only
 * the creator can, so a backup passkey add takes such a link back before it moves the wallet off
 * `account`. A create still in flight counts, since its escrow may land.
 */
export function isOpenCreatorLink(
  row: PaylinkTransaction,
  account: string,
  network: string | undefined,
): boolean {
  if (row.emailPaymentAction !== PaylinkActionEnum.PAY || !linkMadeBy(row, account)) return false
  if (row.flavor !== "email" && row.flavor !== "direct") return false
  if (isOtherRollupLink(row, network)) return false
  if (row.status === "pending") return true
  // A time past every expiry lifts the window checks, leaving only spent and missing material.
  return paylinkRefundEligibility(row, Number.POSITIVE_INFINITY).eligible
}

/** Why a backup passkey add waits on an open link instead of taking it back itself. */
export type BackupLinkHold =
  /** Its create is still in flight. */
  | { kind: "creating" }
  /** It escrows a retired deployment's token, which the move does not carry. */
  | { kind: "token" }
  /** Its cancel window closes before its expiry, so the user cancels it while it still can be. */
  | { kind: "cancel" }
  /** It can't be cancelled before its expiry, `until` in seconds, and only then reclaimed. */
  | { kind: "expiry"; until: number }

/**
 * Whether an open link holds the add. The add cancels a link inside its refund window and reclaims
 * an expired one; a link whose window closes before its expiry, or that records none, would be out
 * of the add's reach in between, so the user cancels it while they still can, or the add waits for
 * its expiry. Links made today close both at once.
 */
export function backupLinkHold(
  row: PaylinkTransaction,
  nowSec: number,
  token: string,
): BackupLinkHold | undefined {
  if (row.status === "pending") return { kind: "creating" }
  if (row.tokenAddress && row.tokenAddress.toLowerCase() !== token.toLowerCase())
    return { kind: "token" }
  const until = row.untilClaimable ?? 0
  const gap = row.refundableUntil == null || row.refundableUntil < until
  if (!gap || nowSec > until) return undefined
  return row.refundableUntil != null && canCancelAt(row.refundableUntil, nowSec)
    ? { kind: "cancel" }
    : { kind: "expiry", until }
}

type ExpiryHold = Extract<BackupLinkHold, { kind: "expiry" }>

/**
 * The open links `account` made on `network` that a backup add takes back, and what holds the add
 * instead: a create in flight first, then a retired token, then a link to cancel, then the latest
 * expiry it waits for. `claimed` are the links a recipient's claim spent, in the moved token: a
 * reorg that undoes the claim reopens the link.
 */
export function backupLinks(
  rows: readonly Transaction[],
  opts: { account: string; network: string | undefined; token: string; nowSec: number },
): { open: PaylinkTransaction[]; claimed: PaylinkTransaction[]; hold?: BackupLinkHold } {
  const open: PaylinkTransaction[] = []
  const claimed: PaylinkTransaction[] = []
  const holds: BackupLinkHold[] = []
  for (const row of rows as readonly PaylinkTransaction[]) {
    if (row.isClaimed) {
      if (
        isOpenCreatorLink({ ...row, isClaimed: false }, opts.account, opts.network) &&
        (!row.tokenAddress || row.tokenAddress.toLowerCase() === opts.token.toLowerCase())
      )
        claimed.push(row)
      continue
    }
    if (!isOpenCreatorLink(row, opts.account, opts.network)) continue
    const hold = backupLinkHold(row, opts.nowSec, opts.token)
    if (hold) holds.push(hold)
    else open.push(row)
  }
  const hold =
    holds.find((h) => h.kind === "creating") ??
    holds.find((h) => h.kind === "token") ??
    holds.find((h) => h.kind === "cancel") ??
    holds.filter((h): h is ExpiryHold => h.kind === "expiry").sort((a, b) => b.until - a.until)[0]
  return hold ? { open, claimed, hold } : { open, claimed }
}

export function creatorLinkAction(
  row: PaylinkTransaction,
  opts: {
    /** Chain-tip seconds where readable — the contract checks block time at inclusion. */
    nowSec: number
    /** The modal's on-open status refresh, folded over the row's own flags. */
    liveStatus: PaylinkStatusKind
    /** The account this session acts as, or undefined before it is known. */
    account?: string
  },
): CreatorLinkAction | null {
  if (!paylinkStatusIsUnspent(opts.liveStatus)) return null
  // A known account that isn't the row's creator can't authorize the escrow's spend. An unknown one
  // can't contradict the row's own stamp, and these rows are this device's.
  if (opts.account && !linkMadeBy(row, opts.account)) return null
  if (row.flavor !== "email" && row.flavor !== "direct") return null
  if (!paylinkRefundEligibility(row, opts.nowSec).eligible) return null
  if (isPaylinkInRefundWindow(row, opts.nowSec)) {
    return canCancelAt(row.refundableUntil!, opts.nowSec) ? "cancel" : null
  }
  return "reclaim"
}
