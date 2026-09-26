/**
 * Which recovery a creator's own paylink row offers in the activity detail modal.
 *
 * Both recoveries spend the escrow's single nullifier, so at most one is ever on offer and neither
 * survives a claim: `cancel` is the in-window refund (`now <= refundableUntil`, a window that opens
 * at creation and may overlap the claim window; offered only while `canCancelAt` says a proof can
 * still land before it closes), `reclaim` is the post-expiry refund (`now > untilClaimable`). The
 * contract decides the branch itself; this only picks the copy. Between the refund window closing
 * and expiry only the recipient can move the funds.
 *
 * The window arithmetic and every material/lifecycle guard come from front-core's shared
 * `isPaylinkInRefundWindow` / `paylinkRefundEligibility`.
 */
import { isPaylinkInRefundWindow, paylinkRefundEligibility } from "@obsidion/front-core"
import type { PaylinkStatusKind, PaylinkTransaction } from "@obsidion/front-core"
import { canCancelAt } from "./claimWindow"

export type CreatorLinkAction = "reclaim" | "cancel"

/** Statuses that still hold spendable escrow; anything else has already consumed the nullifier. */
export function paylinkStatusIsUnspent(status: PaylinkStatusKind): boolean {
  return status === "awaitingClaim" || status === "expired"
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
  if (opts.account && row.obsidionAccountAddress && row.obsidionAccountAddress !== opts.account) {
    return null
  }
  if (row.flavor !== "email" && row.flavor !== "direct") return null
  if (!paylinkRefundEligibility(row, opts.nowSec).eligible) return null
  if (isPaylinkInRefundWindow(row, opts.nowSec)) {
    return canCancelAt(row.refundableUntil!, opts.nowSec) ? "cancel" : null
  }
  return "reclaim"
}
