import {
  PendingRegistrationStore,
  isTerminalRegistrationPhase,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import type { RegistrationSchedule } from "@obsidion/core/types"
import {
  loadRegistrationTerms,
  PAYLINK_TICKET_REFUSED_MESSAGE,
  registrationOffer,
  signedSchedule,
  type RegistrationTerms,
} from "../onboarding/registrationTerms"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { peekClaimStash, peekTicketSignup, type TicketSignupStash } from "./claimStash"
import { linkIdentity } from "./linkIdentity"

/** `linkIdentity` for a fragment that may not decode: null names nothing. */
function identityOf(fragment: string): string | null {
  try {
    return linkIdentity(fragment)
  } catch {
    return null
  }
}

/**
 * The marker a stashed link carries for these terms when it is the link they name: the signup's
 * own, else one rebuilt from the terms the ticket bought. The marker only caches the offer for the
 * review; the binding lives in the terms, so the link reopened on a tab that lost its marker is
 * still this registration's, and a link the terms do not name never becomes one.
 */
function markerFor(terms: RegistrationTerms, fragment: string): TicketSignupStash | null {
  if (!terms.paylinkId || terms.paylinkId !== identityOf(fragment)) return null
  const marker = peekTicketSignup()
  if (marker && marker.fragment === fragment) return marker
  if (terms.fee === undefined || terms.minDeposit === undefined) return null
  return { fragment, schedule: { fee: terms.fee, minDeposit: terms.minDeposit } }
}

/**
 * The stashed link these terms are bound to, when it is on this tab: the link whose ticket bought
 * them, and no other. A marker for a different link is another visitor's choice, never this
 * registration's.
 */
export function boundTicketSignup(
  terms: RegistrationTerms | null | undefined,
): TicketSignupStash | null {
  const fragment = peekClaimStash()
  if (!terms || fragment === null) return null
  return markerFor(terms, fragment)
}

/** The open reservation on this browser is one a payment link funds: its pending step claims that link. */
export function pendingTicketRegistration(): boolean {
  const record = PendingRegistrationStore.get(webStorage).current()
  if (!record) return false
  return registrationOffer(loadRegistrationTerms(record.account, record.tag)).funding === "paylink"
}

/** Find the registration whose terms name this link, optionally restricted to its bound account. */
export function ticketSignupRegistration(
  fragment: string,
  l2Address?: string,
): PendingRegistrationRecord | null {
  const paylinkId = identityOf(fragment)
  if (!paylinkId) return null
  return (
    PendingRegistrationStore.get(webStorage)
      .list()
      .find(
        (record) =>
          !isTerminalRegistrationPhase(record.phase) &&
          (l2Address === undefined || record.l2Address.toLowerCase() === l2Address.toLowerCase()) &&
          loadRegistrationTerms(record.account, record.tag)?.paylinkId === paylinkId,
      ) ?? null
  )
}

/** The loaded account has a registration whose terms name this link. */
export function ticketSignupCommitted(fragment: string): boolean {
  return ticketSignupRegistration(fragment) !== null
}

/**
 * What an activation surface may do for a ticket-funded registration, decided before any price:
 *
 * - `submitted`: the burn is on its way to L1 (a withdrawal to the SIPA, or custody stamped), so
 *   the surface shows progress and never burns twice.
 * - `ready`: the bound link is on this tab, its terms are live and fundable and the SIPA is
 *   published, so the review may open.
 * - `blocked`: the last renewal quoted terms the link cannot pay. The link stays bound.
 * - `renew`: the terms lapsed or carry no schedule; the pending step's tick re-signs them.
 * - `unpublished`: the SIPA broadcast has not landed; the pending step retries it.
 * - `missing_link`: the bound link is not on this tab; the original link has to be reopened.
 *
 * Null for a registration no paylink funds.
 */
export type TicketActivation =
  | { state: "submitted" }
  | { state: "ready"; stash: TicketSignupStash; schedule: RegistrationSchedule }
  | { state: "blocked"; stash: TicketSignupStash | null }
  | { state: "renew"; stash: TicketSignupStash | null }
  | { state: "unpublished"; stash: TicketSignupStash | null }
  | { state: "missing_link" }

function ticketState(
  record: PendingRegistrationRecord,
  terms: RegistrationTerms | null,
  stash: TicketSignupStash | null,
  withdrawals: readonly { recipient: string; phase: string }[],
  nowMs: number,
): TicketActivation | null {
  const offer = registrationOffer(terms)
  if (offer.funding !== "paylink") return null
  const sipa = record.sipaAddress.toLowerCase()
  const burning = withdrawals.some(
    (w) => w.recipient.toLowerCase() === sipa && w.phase !== "failed",
  )
  if (burning || record.fundedAt !== undefined || record.sweptAt !== undefined) {
    return { state: "submitted" }
  }
  if (offer.blocked) return { state: "blocked", stash }
  const schedule = signedSchedule(terms)
  const lapsed = terms !== null && terms.deadline > 0 && nowMs > terms.deadline * 1000
  if (lapsed || !schedule) return { state: "renew", stash }
  if (!record.broadcast) return { state: "unpublished", stash }
  if (!stash) return { state: "missing_link" }
  return { state: "ready", stash, schedule }
}

export function ticketActivation(
  record: PendingRegistrationRecord,
  terms: RegistrationTerms | null,
  withdrawals: readonly { recipient: string; phase: string }[],
  nowMs: number = Date.now(),
): TicketActivation | null {
  return ticketState(record, terms, boundTicketSignup(terms), withdrawals, nowMs)
}

/**
 * The ticket-funded signup one stashed link continues on Home: this account's open registration
 * names the link, and the registration still waits for the claim's burn. Home then shows the
 * review, and claims with that burn only while the activation says `ready`; any other state is
 * shown with its reason and claims nothing, since a plain claim would credit the whole note and
 * leave the name unfunded. Null for a link no registration names, and for a registration funded
 * or swept by other means, whose link is an ordinary claim again.
 */
export interface TicketSignupContinuation {
  stash: TicketSignupStash
  record: PendingRegistrationRecord
  activation: Exclude<TicketActivation, { state: "missing_link" }>
}

export function ticketSignupContinuation(
  fragment: string,
  l2Address: string | undefined,
  withdrawals: readonly { recipient: string; phase: string }[],
  nowMs: number = Date.now(),
): TicketSignupContinuation | null {
  if (l2Address === undefined) return null
  const record = PendingRegistrationStore.get(webStorage).current(l2Address)
  if (!record || record.phase !== "awaiting_deposit") return null
  if (record.fundedAt !== undefined || record.sweptAt !== undefined) return null
  const terms = loadRegistrationTerms(record.account, record.tag)
  const stash = terms && markerFor(terms, fragment)
  if (!stash) return null
  const activation = ticketState(record, terms, stash, withdrawals, nowMs)
  if (!activation || activation.state === "missing_link") return null
  return { stash, record, activation }
}

/** Why a claim surface holds a ticket-funded claim, for the sheet; nothing for a ready one. */
export function ticketHoldNotice(
  state: TicketActivation["state"],
  tag: string,
): string | undefined {
  switch (state) {
    case "blocked":
      return PAYLINK_TICKET_REFUSED_MESSAGE
    case "renew":
      return `The reservation for @${tag} needs a fresh quote before this payment can fund it. Refresh it on the registration page first.`
    case "unpublished":
      return `Your deposit address is not published yet, so this payment cannot fund it. Check the registration to publish it first.`
    case "submitted":
      return `This payment is already claimed. @${tag} registers once the network sweeps the deposit.`
    default:
      return undefined
  }
}
