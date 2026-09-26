/**
 * Recipient-side claim window on `/link`. `from_claimable` is not in the URL — it lives in the
 * escrow note (and on this device's create row). Compare against chain-tip seconds, never the wall
 * clock: the sandbox ticker and `Date.now()` routinely diverge.
 */

import { PAYLINK_CANCEL_MARGIN_SECONDS } from "@obsidion/core/constants"

export const PAYLINK_NOT_CLAIMABLE_YET_MESSAGE = "This link isn't claimable yet. Try again in a moment."

/**
 * Seconds past `from_claimable` before the wallet offers a claim. The prompt reads the node tip, but the
 * claim proves against the block the PXE has synced to, which trails the tip; a claim taken at the
 * boundary was refused as not yet claimable.
 */
export const PAYLINK_CLAIM_MARGIN_SECONDS = 30
export const PAYLINK_WINDOW_MESSAGE =
  "The window for this action has closed. Refresh the link to see what it offers now."

/** True only when both timestamps are known and the claim window, plus the proving margin, has not
 *  opened yet. */
export function isPaylinkNotYetClaimable(
  claimableFrom: number | undefined,
  chainNow: number | undefined,
): boolean {
  if (claimableFrom == null || chainNow == null) return false
  return chainNow < claimableFrom + PAYLINK_CLAIM_MARGIN_SECONDS
}

/**
 * True while a creator's cancel can still land before `refundable_until`. The refund tx expires
 * there, and proof + inclusion must finish first, so the offer closes a margin early.
 */
export function canCancelAt(refundableUntil: number, chainNow: number): boolean {
  return chainNow + Number(PAYLINK_CANCEL_MARGIN_SECONDS) < refundableUntil
}

/** Remaining seconds as `m:ss`, or `h:mm:ss` once an hour has elapsed. */
export function formatClaimCountdown(remainingSec: number): string {
  const sec = Math.max(0, Math.floor(remainingSec))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  return `${m}:${String(s).padStart(2, "0")}`
}
