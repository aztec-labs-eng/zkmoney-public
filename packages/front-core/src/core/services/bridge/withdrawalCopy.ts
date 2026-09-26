/**
 * The words a user sees for each withdrawal phase, in one table that every surface reads: the
 * activity pill, the detail sheet, the live notification row and the step ladder. From the burn
 * landing on Aztec until the funds reach Ethereum the user sees one state,
 * "Releasing to Ethereum": the proof on Ethereum is never called "proven" or "finalized", words
 * that read as the proof the device makes.
 */
import type { WithdrawalPhase } from "./types"

export interface WithdrawalPhaseCopy {
  /** Activity pill. Undefined where the row carries no status. */
  pill?: string
  /** Detail sheet status line. */
  status: string
  /** Live notification row, after the amount. Undefined where no live row is shown. */
  live?: string
}

const RELEASING: WithdrawalPhaseCopy = {
  pill: "Releasing",
  status: "Releasing to Ethereum",
  live: "Releasing to Ethereum",
}

export const WITHDRAWAL_PHASE_COPY: Readonly<Record<WithdrawalPhase, WithdrawalPhaseCopy>> = {
  submitting: { pill: "Pending", status: "Waiting for Aztec confirmation", live: "Proving privately" },
  l2_mined: RELEASING,
  awaiting_proven: RELEASING,
  finalizing_l1: RELEASING,
  swapping: { pill: "Swapping", status: "Waiting for the swap", live: "Swapping" },
  recoverable: { pill: "Needs recovery", status: "Needs recovery" },
  recovered: { pill: "Recovered", status: "Recovered" },
  done: { status: "Paid" },
  failed: { pill: "Failed", status: "Failed" },
}
