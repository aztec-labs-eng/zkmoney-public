import { depositOwed, type PendingRegistrationRecord } from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { useDepositAdmission } from "../identity/admission"
import { ticketActivation } from "../paylink/ticketContinuation"
import { getWithdrawalStore } from "../withdraw/withdrawGateway"
import { useOpenRegistration } from "./openRegistration"
import { useRegistrationRefunded } from "./registrationQuoteRecovery"
import { quoteExpired, signedWithoutSchedule, useRegistrationTerms } from "./registrationTerms"
import { useRegistrationPublishStalled } from "./webRegistration"

export interface OwedRegistration {
  record: PendingRegistrationRecord
  /** The deposit screen cannot ask for this deposit: the pending step resolves it first. */
  needsCheck: boolean
}

/** The open registration while it owes its deposit, null otherwise. */
export function useOwedRegistration(): OwedRegistration | null {
  const open = useOpenRegistration()
  const record = open && depositOwed(open.stage) ? open.record : null
  const terms = useRegistrationTerms(record?.account, record?.tag)
  const stalled = useRegistrationPublishStalled(record)
  const admitted = useDepositAdmission(record)
  const refunded = useRegistrationRefunded(record)
  if (!record) return null
  const nowMs = Date.now()
  const needsCheck =
    record.l1ChainId !== getConfig().l1ChainId ||
    ticketActivation(record, terms, getWithdrawalStore().list(), nowMs) !== null ||
    quoteExpired(terms, nowMs) ||
    signedWithoutSchedule(terms) ||
    stalled ||
    admitted ||
    refunded
  return { record, needsCheck }
}
