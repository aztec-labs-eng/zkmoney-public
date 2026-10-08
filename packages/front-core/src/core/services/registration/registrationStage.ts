/**
 * Where one registration stands, read once from every store that records part of it: the pending
 * record, its SIPA rail deposit and any burn funding its address. Every surface asks this one
 * question instead of reading the record's fields its own way.
 *
 * A stage says where the name and the money are. It does not say:
 *
 * - whether the wallet still presents the tag as pending (the wallet identity),
 * - whether the deposit address is published (`broadcast`),
 * - whether the reservation ended and the quote needs a re-sign (the stored deadline),
 * - whether background retries have escalated (`registrationUiState`),
 * - whether sponsored sends are open (the rail's L1→L2 import).
 *
 * Callers combine those with the stage.
 */
import type { SIPADepositRecord } from "../deposits/SIPADepositStore"
import type { PendingRegistrationRecord } from "./PendingRegistrationStore"

export type RegistrationStage =
  | "reserved" // the deposit is owed
  | "funding" // a ticket signup's burn is on its way to the deposit address
  | "received" // a deposit at the floor is at the address
  | "sweeping" // a relayer is sweeping them
  | "claiming" // the sweep landed; the Registry has yet to show the name
  | "crediting" // the name is claimed; the L1→L2 credit is settling
  | "registered"
  | "failed"

/** The part of a withdrawal record the stage reads: where the burn goes and whether it is still going. */
export type FundingBurn = { recipient: string; phase: string }

export interface RegistrationStageInputs {
  deposit?: SIPADepositRecord | null
  burns?: readonly FundingBurn[]
}

/** The furthest stage the stores show. Only the Registry read registers or loses the name. */
export function registrationStage(
  record: PendingRegistrationRecord,
  { deposit, burns = [] }: RegistrationStageInputs = {},
): RegistrationStage {
  const rail = deposit?.phase
  if (record.phase === "confirmed") return "registered"
  if (record.phase === "failed_taken" || record.phase === "failed_terminal") return "failed"
  if (rail === "pendingClaim" || rail === "claimed") return "crediting"
  // The sweep is what registers the name.
  if (record.sweptAt !== undefined || record.sweepTxHash !== undefined) return "claiming"
  if (rail === "sweeping") return "sweeping"
  // The deposit left the address, whatever the record stamped or a landed burn brought.
  if (rail === "recovered") return "reserved"
  // A rail moves to `funded` only once the balance covers the floor. The amount it stamps on an
  // address the wallet watches is any balance, short or not, and a short deposit is still owed.
  if (record.fundedAt !== undefined || rail === "funded") return "received"
  // A ticket signup's claim burns the link's payment to the deposit address; a failed or reclaimed
  // burn funds nothing.
  const sipa = record.sipaAddress.toLowerCase()
  if (
    burns.some(
      (b) => b.recipient.toLowerCase() === sipa && b.phase !== "failed" && b.phase !== "recovered",
    )
  )
    return "funding"
  return "reserved"
}

/** The deposit is still owed: nothing has reached, or is on its way to, the address. */
export const depositOwed = (stage: RegistrationStage): stage is "reserved" => stage === "reserved"

/** Funds reached the address and the name is not settled yet: never ask for the deposit again. */
export const fundsIn = (stage: RegistrationStage): boolean =>
  stage === "received" || stage === "sweeping" || stage === "claiming" || stage === "crediting"
