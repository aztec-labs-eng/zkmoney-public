import { PaylinkActionEnum } from "@obsidion/core/constants"
import type { PaylinkTransaction, TransactionStatus } from "../../../types/transactions"
import { PAYLINK_STATUS_LABEL, paylinkStatusFor, type PaylinkStatusKind } from "./paylinkStatus"

/** A creator's way back to an unclaimed link's escrow: in-window cancel, or post-expiry reclaim. */
export type PaylinkRecovery = "cancel" | "reclaim"

export type PaylinkRowStatusLabel =
  | "Pending"
  | "Failed"
  | "Cancelling"
  | "Reclaiming"
  | "Cancelled"
  | "Reclaimed"
  | (typeof PAYLINK_STATUS_LABEL)[PaylinkStatusKind]

const RECOVERED_LABEL = { cancel: "Cancelled", reclaim: "Reclaimed" } as const

export interface PaylinkRowView {
  title: "Paylink" | "Sent via paylink" | "Received via paylink"
  statusLabel?: PaylinkRowStatusLabel
  /** The link can still be handed to a recipient. */
  canShare: boolean
  /** The recovery the row offers now. */
  recovery: PaylinkRecovery | null
  /** A refund of this link is on its way; the row offers nothing until it settles. */
  recovering: PaylinkRecovery | null
  /** The escrow came back to the creator. */
  refunded: boolean
}

/**
 * What a paylink row shows and offers, for the feed row and the detail sheet alike. The create
 * transaction's own state comes first: a pending create's link is shareable but holds no escrow
 * yet, and a failed one never escrowed anything. A settled link then reads its lifecycle, unless a
 * refund of it is in flight.
 *
 * `offer` is the recovery the escrow's windows allow (the caller's chain-time gate); this only
 * withholds it. A refund is in flight from `refundStarting` (this page is running it, before its
 * hash exists) until the transaction behind `row.refundTxHash` settles: `refundStatus` "success"
 * reads refunded ahead of the reconciler's flag, and "failed" returns the link to its recovery (the
 * reconciler then clears the hash). A refunded link reads Cancelled or Reclaimed by the recovery
 * that ran, or Refunded where the row never recorded which.
 */
export function paylinkRowView(
  row: PaylinkTransaction,
  opts: {
    /** A fresher lifecycle than the row's own flags, e.g. the detail sheet's chain recheck. */
    linkStatus?: PaylinkStatusKind
    offer?: PaylinkRecovery | null
    refundStatus?: TransactionStatus
    refundStarting?: boolean
    nowSec: number
  },
): PaylinkRowView {
  const create = row.action === PaylinkActionEnum.PAY
  const none = { canShare: false, recovery: null, recovering: null, refunded: false } as const
  if (row.status === "failed") return { title: "Paylink", statusLabel: "Failed", ...none }
  if (row.status === "pending") {
    return { title: "Paylink", statusLabel: "Pending", ...none, canShare: create && !!row.paylink }
  }
  if (!create) return { title: "Received via paylink", ...none }
  const title = "Sent via paylink"
  const refundLanded = !!row.refundTxHash && opts.refundStatus === "success"
  const linkStatus = refundLanded
    ? "refunded"
    : opts.linkStatus ?? paylinkStatusFor(row, opts.nowSec)
  const unspent = linkStatus === "awaitingClaim" || linkStatus === "expired"
  const refunding =
    opts.refundStarting || (!!row.refundTxHash && !row.isRefunded && opts.refundStatus !== "failed")
  if (unspent && refunding) {
    // The kind is the live refund's only while its hash is: a failed try's goes with its hash.
    const recorded = row.refundTxHash && opts.refundStatus !== "failed" ? row.refundKind : undefined
    const recovering =
      recorded ??
      (row.untilClaimable != null && opts.nowSec > row.untilClaimable ? "reclaim" : "cancel")
    return {
      title,
      statusLabel: recovering === "reclaim" ? "Reclaiming" : "Cancelling",
      ...none,
      recovering,
    }
  }
  const refunded = linkStatus === "refunded"
  return {
    title,
    statusLabel:
      refunded && row.refundKind
        ? RECOVERED_LABEL[row.refundKind]
        : PAYLINK_STATUS_LABEL[linkStatus],
    canShare: linkStatus === "awaitingClaim" && !!row.paylink,
    recovery: unspent ? opts.offer ?? null : null,
    recovering: null,
    refunded,
  }
}
