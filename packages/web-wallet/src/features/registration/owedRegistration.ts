import { depositOwed, isTicketSignup, type PendingRegistrationRecord } from "@obsidion/front-core"
import { useDepositAdmission } from "./admission"
import { useOpenRegistration } from "./openRegistration"
import { useRegistrationRefunded } from "./registrationRecovery"
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
  const record = open?.stage !== undefined && depositOwed(open.stage) ? open.record : null
  const terms = useRegistrationTerms(record?.account, record?.tag)
  const stalled = useRegistrationPublishStalled(record)
  const admitted = useDepositAdmission(record)
  const refunded = useRegistrationRefunded(record)
  if (!record) return null
  const nowMs = Date.now()
  const needsCheck =
    // A link's claim funds a ticket signup: the pending step owns it.
    isTicketSignup(terms ?? undefined) ||
    quoteExpired(terms, nowMs) ||
    signedWithoutSchedule(terms) ||
    stalled ||
    // Only a funded record's admission asks for the check: the screen spots the deposit first.
    (admitted && record.phase === "funded") ||
    refunded
  return { record, needsCheck }
}
