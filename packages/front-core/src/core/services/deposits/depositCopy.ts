/**
 * The words a user sees for each deposit phase, in one table that every surface reads: the
 * activity pill, the detail sheet and the live notification row. From the funds leaving the
 * sender until they reach Aztec the deposit is Receiving; the claim that credits the balance is
 * Crediting.
 */
import type { SIPADepositPhase } from "@obsidion/core/types"
import { isUnfundedSipaDeposit, type SIPADepositRecord } from "./SIPADepositStore"

export interface DepositPhaseCopy {
  /** Activity pill. Undefined where the row carries no status. */
  pill?: string
  /** Detail sheet status line. */
  status: string
  /** Live notification row, after the amount. Undefined where no live row is shown. */
  live?: string
}

const AWAITING: DepositPhaseCopy = { pill: "Awaiting funds", status: "Awaiting funds" }
const RECEIVING: DepositPhaseCopy = { pill: "Receiving", status: "Receiving", live: "Receiving" }
const CREDITING: DepositPhaseCopy = { pill: "Crediting", status: "Crediting", live: "Crediting" }

export const DEPOSIT_PHASE_COPY: Readonly<Record<SIPADepositPhase, DepositPhaseCopy>> = {
  resolved: AWAITING,
  funding: RECEIVING,
  funded: RECEIVING,
  broadcast: RECEIVING,
  sweeping: RECEIVING,
  pendingClaim: CREDITING,
  claimed: { status: "Completed" },
  recoverable: { pill: "Needs recovery", status: "Needs recovery" },
  recovered: { pill: "Recovered", status: "Recovered" },
  failed: { pill: "Deposit failed", status: "Deposit failed" },
}

/** A deposit address nobody has sent to yet is awaiting funds, whatever phase it was created in. */
export function depositPhaseCopy(record: SIPADepositRecord): DepositPhaseCopy {
  return isUnfundedSipaDeposit(record) ? AWAITING : DEPOSIT_PHASE_COPY[record.phase]
}
