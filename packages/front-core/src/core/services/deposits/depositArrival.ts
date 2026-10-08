/**
 * How long a spotted deposit takes to credit the private balance. The relayer sweeps it on L1, the
 * Inbox files the portal's message `inboxLag` checkpoints ahead, one checkpoint per slot, and the
 * wallet's sync tick proves and sends the claim, which mines in the next checkpoint.
 */

/** The relayer's pickup plus one L1 block, from a balance seen to the sweep landed. */
export const SWEEP_PICKUP_SECONDS = 120
/** The wallet's fast-lane sync tick, which sees the message ready. */
export const SYNC_TICK_SECONDS = 12
/** Proving the claim in the browser. */
export const CLAIM_PROOF_SECONDS = 60

export function depositArrivalSeconds(input: {
  nowSeconds: number
  l1GenesisTime: number
  slotDuration: number
  inboxLag: number
  sweepSeconds?: number
  syncTickSeconds?: number
  claimProofSeconds?: number
}): number {
  const {
    nowSeconds,
    l1GenesisTime,
    slotDuration,
    inboxLag,
    sweepSeconds = SWEEP_PICKUP_SECONDS,
    syncTickSeconds = SYNC_TICK_SECONDS,
    claimProofSeconds = CLAIM_PROOF_SECONDS,
  } = input
  const sweepAt = nowSeconds + sweepSeconds
  const slotAtSweep = Math.floor((sweepAt - l1GenesisTime) / slotDuration)
  const availableAt = l1GenesisTime + (slotAtSweep + inboxLag + 1) * slotDuration
  const creditedAt = availableAt + syncTickSeconds + claimProofSeconds + slotDuration
  return Math.max(0, creditedAt - nowSeconds)
}

/** Whole minutes for copy, never below one. */
export function depositArrivalMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60))
}
