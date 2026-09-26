/**
 * The rungs a withdrawal climbs, in order. One table so every presenter names the same steps and
 * advances them on the same phases. The names follow `WITHDRAWAL_PHASE_COPY`: everything between the
 * burn and the payout is one rung.
 */

import type { WithdrawalPhase } from "./types"

export interface WithdrawalStep {
  /** Phase whose completion this rung represents. */
  phase: WithdrawalPhase
  label: string
}

const SENT: WithdrawalStep = { phase: "submitting", label: "Sent on Aztec" }
const RELEASING: WithdrawalStep = { phase: "finalizing_l1", label: "Releasing to Ethereum" }
const SWAPPING: WithdrawalStep = { phase: "swapping", label: "Swapping" }
const PAID: WithdrawalStep = { phase: "done", label: "Paid" }

/** The ladder of a withdrawal paid out directly. */
export const WITHDRAWAL_STEPS: readonly WithdrawalStep[] = [SENT, RELEASING, PAID]

const SWAP_STEPS: readonly WithdrawalStep[] = [SENT, RELEASING, SWAPPING, PAID]

/** The ladder for a record: a swap-on-withdraw adds its swap before the payout. */
export function withdrawalSteps(swap: boolean): readonly WithdrawalStep[] {
  return swap ? SWAP_STEPS : WITHDRAWAL_STEPS
}

/**
 * Index of the rung currently in progress. `done` and `recovered` return past the last rung —
 * every rung is complete. `failed` parks on the releasing rung: the record keeps no marker of how
 * far it actually got before it died.
 */
export function withdrawalStepIndex(phase: WithdrawalPhase, swap = false): number {
  const steps = withdrawalSteps(swap)
  switch (phase) {
    case "done":
    case "recovered":
      return steps.length
    case "l2_mined":
    case "awaiting_proven":
    case "finalizing_l1":
    case "failed":
      return 1
    case "swapping":
    case "recoverable":
      return steps.length - (swap ? 2 : 1)
    default:
      return 0
  }
}
