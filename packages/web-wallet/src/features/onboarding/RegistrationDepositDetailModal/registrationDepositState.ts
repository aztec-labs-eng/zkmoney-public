import {
  depositOwed,
  fundsIn,
  isTerminalRegistrationPhase,
  registrationNeedsRefund,
  type PendingRegistrationRecord,
  type RegistrationStage,
  type RegistrationTerms,
} from "@obsidion/front-core"
import { registrationAddressPublished } from "../../registration/webRegistration"

/** What the registration deposit's detail offers: a refund, the publishing row, the pay block. */
export function registrationDepositState(
  record: PendingRegistrationRecord,
  terms: RegistrationTerms | null,
  stage: RegistrationStage | undefined,
  {
    depositAdmitted,
    refunded,
    seen,
  }: { depositAdmitted: boolean; refunded: boolean; seen: bigint },
  sweepFee?: bigint,
) {
  const reached = depositAdmitted || refunded
  const needsRefund = registrationNeedsRefund(record, terms, reached, seen, sweepFee)
  const closed = isTerminalRegistrationPhase(record.phase) || record.sweptAt !== undefined
  return {
    needsRefund,
    // Only once funds wait on it; one whose deposit must be recovered instead is not published.
    publishing:
      !!stage && fundsIn(stage) && !needsRefund && !registrationAddressPublished(record) && !closed,
    // While the address still takes funds, its only copy is the pay block's, which the limits and
    // capacity gate; the record row shows the address without offering it.
    fundingOpen: !!stage && depositOwed(stage) && !depositAdmitted && !needsRefund,
  }
}
