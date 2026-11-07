/** Where an open registration stands while its deposit is owed, and whether its tag settles there. */
import { registrationFloor } from "@obsidion/core/constants"
import type { RegistrationSchedule } from "@obsidion/core/types"
import { depositOwed, fundsIn, type RegistrationStage } from "../core/services/registration"
import { registrationNeedsRefund } from "../oxide/registrationRefunds"
import {
  isTicketSignup,
  type PendingRegistrationRecord,
  type RegistrationTerms,
} from "./registrationRecord"

/** Where the open record stands, before its address is watched. */
export function pendingRecordState(
  record: PendingRegistrationRecord | null,
  stage: RegistrationStage | null | undefined,
  terms: RegistrationTerms | null,
) {
  // Unknown while the withdrawals load: nothing is owed or held until then.
  const openPending =
    record !== null &&
    stage != null &&
    (depositOwed(stage) || stage === "funding" || fundsIn(stage))
  return {
    openPending,
    custodyHeld: openPending && fundsIn(stage),
    awaitingDeposit: openPending && !fundsIn(stage),
    // The link's burn is on its way to this registration, so no deposit is asked for it, whether
    // or not its link is on this tab.
    linkBurnOut: stage === "funding" && isTicketSignup(terms ?? undefined),
  }
}

export interface PendingEntryFacts {
  record: PendingRegistrationRecord | null
  terms: RegistrationTerms | null
  stage: RegistrationStage | null | undefined
  /** A link on this tab funds the registration. */
  paylinkStashed: boolean
  depositAdmitted: boolean
  refunded: boolean
  /** What the address holds now. */
  depositSeen: bigint
  /** The most the address showed, sweeps included. */
  shown: bigint
  sweepFee: bigint | undefined
  expectedEarned: boolean
  feeWaived: boolean
  signedQuote: RegistrationSchedule | undefined
  /** The claim's chain-time deadline, in seconds. */
  claimDeadline: number | undefined
  registrationsPaused: boolean
  /** What an earned tag is asked to deposit. */
  earnedAsk: bigint
  nowMs: number
}

/** What the record's address is for, and whether its tag settles there. */
export function selectPendingEntry(f: PendingEntryFacts) {
  const { record } = f
  const state = pendingRecordState(record, f.stage, f.terms)
  // Bound but refused: no claim, no L1 send, the refusal on the sheet until renewed or abandoned.
  const ticketBlocked = f.paylinkStashed && f.terms?.paylinkBlocked === true
  const depositSeenAny = state.awaitingDeposit && f.depositSeen > 0n
  // Only an earned tag has a cheaper price to restart at; a paid deposit is watched, not refunded.
  const needsRefund =
    record !== null &&
    f.expectedEarned &&
    registrationNeedsRefund(
      record,
      f.terms,
      f.depositAdmitted || f.refunded || depositSeenAny || record.fundedAt !== undefined,
      f.shown,
      f.sweepFee,
    )
  // Wall clock against the claim's chain-time deadline. Custody keeps the machine's own recovery.
  const quoteExpired =
    state.awaitingDeposit &&
    !f.depositAdmitted &&
    !state.custodyHeld &&
    !depositSeenAny &&
    f.claimDeadline !== undefined &&
    f.nowMs > f.claimDeadline * 1000
  // A signed quote the campaign's promise disagrees with: an address holding a deposit is watched,
  // never replaced. A record without a quote has nothing to disagree with.
  const earnedQuoteDiffers =
    f.expectedEarned &&
    f.signedQuote !== undefined &&
    (!f.feeWaived || registrationFloor(f.signedQuote) > f.earnedAsk)
  const quoteMismatch = earnedQuoteDiffers && !quoteExpired
  // An old-price address nothing ever reached has no deposit to watch or refund: the earned quote
  // replaces the address outright.
  const replaceUnfunded =
    earnedQuoteDiffers &&
    !needsRefund &&
    !f.depositAdmitted &&
    !depositSeenAny &&
    !state.custodyHeld &&
    state.awaitingDeposit &&
    record?.fundedAt === undefined
  const paylinkPending = f.paylinkStashed && state.awaitingDeposit && !quoteExpired
  // The address the tag settles on: one no link funds, at a live quote nothing must refund or
  // replace, while registrations take deposits.
  const settles =
    state.openPending &&
    !paylinkPending &&
    !state.linkBurnOut &&
    !ticketBlocked &&
    !quoteExpired &&
    !f.depositAdmitted &&
    !needsRefund &&
    !quoteMismatch &&
    !f.registrationsPaused
  return {
    ticketBlocked,
    depositSeenAny,
    needsRefund,
    quoteExpired,
    quoteMismatch,
    replaceUnfunded,
    paylinkPending,
    settles,
  }
}

/** Where the pending step goes once its record moves. */
export type PendingExit = "restart" | "failed" | "enter" | "wallet" | "recover" | "held" | "stay"

export interface PendingExitFacts {
  record: PendingRegistrationRecord | null
  /** The tag the session's identity names; undefined for none. */
  identityTag: string | undefined
  /** This browser entered the identity: its passkey's breadcrumb is here. */
  entered: boolean
  /** The earned deposit buys entry. */
  admitted: boolean
  /** The address's refund settled. */
  refunded: boolean
  /** The signup's own passkey made the keys this step holds. */
  keysHeld: boolean
  /** The device holds the session's key, so the session can save the identity itself. */
  signedIn: boolean
  /** The step opened to recover a deposit, so a funded record keeps it. */
  recoveryVisit: boolean
  /** An identity save failed: only its retry enters. */
  entryFailed: boolean
}

/**
 * The pending step's exit. A lost or failed record leaves; a confirmed, funded or admitted one
 * enters, with the signup's keys or, once the session's identity names its tag, without them. A
 * signed-out tab, or an account that holds another name, goes to sign-in.
 */
export function selectPendingExit(f: PendingExitFacts): PendingExit {
  const { record } = f
  if (!record || f.entryFailed) return "stay"
  if (record.phase === "failed_taken") return "restart"
  if (record.phase === "failed_terminal") return "failed"
  if (record.notice?.recovery) return "held"
  if (record.phase !== "confirmed" && record.phase !== "funded" && !f.admitted) return "stay"
  const recovering = f.admitted || (record.phase === "funded" && f.refunded)
  if (f.recoveryVisit && record.phase !== "confirmed" && recovering) return "stay"
  if (f.keysHeld) return "enter"
  if (!f.signedIn) return "recover"
  if (f.identityTag !== record.tag) return "stay"
  return f.entered ? "wallet" : "recover"
}
