// Interim backstop until the claim-reconciliation PR makes `isClaimed`
// authoritative: claim/refund/cancel all consume the SAME paylink nullifier, so
// refunding an already-claimed-or-refunded paylink reverts with a
// nullifier-already-spent error. Map only that revert to a friendly message;
// fee/network errors must fall through to generic handling.
//
// The exact revert string must be confirmed on sandbox.

export const PAYLINK_ALREADY_SPENT_MESSAGE = "This paylink has already been claimed or refunded."

const ALREADY_SPENT_PATTERNS = [
  "existing nullifier",
  "nullifier already exists",
  "duplicate nullifier",
  "already nullified",
  "note has been nullified",
]

/** True when `error`'s message looks like a nullifier-already-spent revert. */
export function isPaylinkAlreadySpentRevert(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase()
  return ALREADY_SPENT_PATTERNS.some((p) => msg.includes(p))
}

/**
 * Thrown by a wallet-side pre-flight when chain time has left the window an action needs
 * (a cancel whose grace period closed under it). Same treatment as the on-chain window revert.
 */
export class PaylinkWindowClosedError extends Error {
  constructor() {
    super("paylink window closed")
    this.name = "PaylinkWindowClosedError"
  }
}

const WINDOW_PATTERNS = [
  // `enforce_window`: the anchor block is still before the window opens (fails in simulation).
  "window not open",
  // The tx expired at the window's end before the node accepted it.
  "invalid expiration timestamp",
  "timestamp mismatch",
]

/**
 * True when the escrow's time gate rejected the action (too early in simulation, too late at
 * send) or the wallet pre-flight caught it first. Time moved on between offer and inclusion;
 * nothing was spent.
 */
export function isPaylinkWindowRevert(error: unknown): boolean {
  if (error instanceof PaylinkWindowClosedError) return true
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase()
  return WINDOW_PATTERNS.some((p) => msg.includes(p))
}
