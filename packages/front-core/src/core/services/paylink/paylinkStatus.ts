import type { PaylinkTransaction } from "../../../types/transactions"

/** Coarse claim-lifecycle state for a stored paylink row's status pill. */
export type PaylinkStatusKind = "awaitingClaim" | "claimed" | "refunded" | "migrated" | "expired"

export const PAYLINK_STATUS_LABEL = {
  awaitingClaim: "Unclaimed",
  claimed: "Claimed",
  refunded: "Refunded",
  migrated: "Migrated",
  expired: "Expired",
} as const satisfies Record<PaylinkStatusKind, string>

/**
 * Derive the paylink's display state from persisted row fields + the local clock
 * (no RPC), so it renders correctly offline. `refunded` is checked before
 * `claimed`: claim and refund share one nullifier, and the reconciler is the
 * primary guard against a self-refund being marked `isClaimed` — this ordering is
 * defense-in-depth so a refunded row can never read as "Claimed". `migrated` ranks
 * below both (a row the v4-era reconciler already flagged keeps its truthful label)
 * and above `expired` = unclaimed past `untilClaimable`.
 */
export function paylinkStatusFor(tx: PaylinkTransaction, nowSec: number): PaylinkStatusKind {
  if (tx.isRefunded) return "refunded"
  if (tx.isClaimed) return "claimed"
  if (tx.isMigrated) return "migrated"
  if (tx.untilClaimable != null && tx.untilClaimable < nowSec) return "expired"
  return "awaitingClaim"
}
