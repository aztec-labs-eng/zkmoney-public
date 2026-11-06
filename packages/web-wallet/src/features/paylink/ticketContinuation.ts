import { bestEffort } from "@obsidion/core/errors"
import {
  currentRegistration,
  fundsIn,
  isTerminalRegistrationPhase,
  loadRecords,
  registrationSpentLink,
  type PendingRegistrationRecord,
  type RegistrationTerms,
} from "@obsidion/front-core"
import type { RegistrationSchedule } from "@obsidion/core/types"
import {
  updateRegistrationTerms,
  PAYLINK_TICKET_REFUSED_MESSAGE,
  quoteExpired,
  registrationOffer,
  signedSchedule,
} from "../registration/registrationTerms"
import { readRegistrationStage } from "../registration/openRegistration"
import { getConfig } from "../../config/env"
import { session } from "../../session/session"
import { loadedRegistrations } from "../registration/webRegistration"
import { peekClaimStash, peekTicketSignup, type TicketSignupStash } from "./claimStash"
import { linkIdentity } from "./linkIdentity"
import { isTicketSignupCreating, loadTicketSignupAttempt } from "./ticketSignupAccount"

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
  const stored = {
    ...(terms.paylinkAmount !== undefined ? { amount: terms.paylinkAmount } : {}),
    ...(terms.paylinkSender !== undefined ? { senderTag: terms.paylinkSender } : {}),
  }
  const marker = peekTicketSignup()
  if (marker && marker.fragment === fragment)
    return {
      ...marker,
      amount: marker.amount ?? stored.amount,
      senderTag: marker.senderTag ?? stored.senderTag,
    }
  if (terms.fee === undefined || terms.minDeposit === undefined) return null
  return {
    fragment,
    schedule: { fee: terms.fee, minDeposit: terms.minDeposit },
    // No ticket priced a deposit the link pays, so its split shows the name's price.
    ...(terms.paylinkDeposit ? { paid: true as const } : {}),
    ...stored,
  }
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

/**
 * This tab's claim publishes the registration's address: its terms are a ticket's, and the link they
 * are bound to is stashed here. Without that link nothing claims, so the address is the ledger's to
 * publish, as any registration's is once a surface shows it.
 */
export function claimPublishesAddress(record: Pick<PendingRegistrationRecord, "terms">): boolean {
  return boundTicketSignup(record.terms) !== null
}

/** The open reservation on this browser is one a payment link funds: its pending step claims that link. */
export function pendingTicketRegistration(): boolean {
  const record = currentRegistration(loadedRegistrations(session().registrations))
  if (!record) return false
  return registrationOffer(record.terms).funding === "paylink"
}

/** Find the registration whose terms name this link, optionally restricted to its bound account. */
export function ticketSignupRegistration(
  fragment: string,
  l2Address?: string,
): PendingRegistrationRecord | null {
  const paylinkId = identityOf(fragment)
  if (!paylinkId) return null
  return (
    [...loadedRegistrations(session().registrations)]
      .sort((a, b) => b.startTime - a.startTime)
      .find(
        (record) =>
          !isTerminalRegistrationPhase(record.phase) &&
          (l2Address === undefined || record.l2Address.toLowerCase() === l2Address.toLowerCase()) &&
          record.terms?.paylinkId === paylinkId,
      ) ?? null
  )
}

/**
 * The link closed before its claim paid the deposit it was to fund: the deposit is asked of the
 * user again. A ticket's registration stays bound, since only its link prices it.
 */
export function releaseLinkDeposit(
  record: Pick<PendingRegistrationRecord, "sipaAddress" | "terms">,
): void {
  if (!record.terms?.paylinkDeposit) return
  void bestEffort("unknown", session().registrations.releaseLink(record.sipaAddress))
}

/**
 * This account's registration that still waits for its whole deposit, on live signed terms no link
 * funds yet: a link opened on Home may pay it (`bindLinkDeposit`). Null for anything else.
 */
export function unfundedRegistration(
  l2Address: string,
  withdrawals: readonly { recipient: string; phase: string }[],
  nowMs: number = Date.now(),
): { record: PendingRegistrationRecord; schedule: RegistrationSchedule } | null {
  const record = currentRegistration(loadedRegistrations(session().registrations), l2Address)
  if (!record || record.phase !== "awaiting_deposit" || record.fundedAt !== undefined) return null
  if (readRegistrationStage(session(), record, withdrawals) !== "reserved" || unpublishable(record))
    return null
  const terms = record.terms ?? null
  const schedule = signedSchedule(terms)
  if (!schedule || quoteExpired(terms, nowMs) || registrationOffer(terms).funding === "paylink")
    return null
  return { record, schedule }
}

/** The link pays the registration's deposit, with the tip its review committed: Home's claim of it
 *  burns that slice to the deposit address. */
export function bindLinkDeposit(
  record: Pick<PendingRegistrationRecord, "sipaAddress" | "terms">,
  link: { fragment: string; amount?: bigint; senderTag?: string },
  proverTip: bigint,
  speed: "standard" | "faster",
): Promise<void> | undefined {
  if (!record.terms) return undefined
  return updateRegistrationTerms(session().registrations, record, {
    paylinkFunded: true,
    paylinkDeposit: true,
    paylinkId: linkIdentity(link.fragment),
    ...(link.amount !== undefined ? { paylinkAmount: link.amount.toString() } : {}),
    ...(link.senderTag ? { paylinkSender: link.senderTag } : {}),
    proverTip: proverTip.toString(),
    speed,
  })
}

/** An address a replacement derived after the account's one broadcast was spent: unpublished, and
 *  never publishable, so no link's claim can fund it. */
const unpublishable = (record: PendingRegistrationRecord) =>
  !record.broadcast && record.replaced?.broadcastSpent === true

const FUNDING_REFUSAL_COPY: Record<string, string> = {
  uncovered: "This payment cannot cover the account deposit.",
  expired: "The reservation needs a fresh quote. Refresh it on the registration page first.",
  blocked: "This payment cannot fund the registration at its current price.",
  unpublished: "The registration's address is still being set up. Try again in a moment.",
}

/** Words for a claim the registration's funding refused; undefined for any other error. */
export function fundingRefusalCopy(err: unknown): string | undefined {
  if (!(err instanceof Error) || err.name !== "RegistrationFundingError") return undefined
  const reason = (err as Error & { reason?: string }).reason ?? ""
  return FUNDING_REFUSAL_COPY[reason] ?? "This payment cannot fund the registration right now."
}

/** Resolves once this browser's registrations are read, so an absent one is known absent. */
export const loadRegistrations = async (): Promise<void> =>
  void (await loadRecords(session().registrations.view))

/** An open registration on this browser names this link. */
export function ticketSignupCommitted(fragment: string): boolean {
  return ticketSignupRegistration(fragment) !== null
}

/** A registration on this browser, a closed one too, names this link and its claim went out. */
export function ticketSignupSpent(
  fragment: string,
  withdrawals: readonly { recipient: string; phase: string }[],
): boolean {
  const paylinkId = identityOf(fragment)
  return (
    !!paylinkId &&
    registrationSpentLink(loadedRegistrations(session().registrations), paylinkId, withdrawals)
  )
}

/**
 * This link's ticket signup already has a registration or a saved account, so reopening it resumes
 * that signup rather than starting one: the offer's threshold now does not gate it.
 */
export function ticketSignupResumable(fragment: string): boolean {
  if (ticketSignupCommitted(fragment)) return true
  const paylinkId = identityOf(fragment)
  if (!paylinkId) return false
  try {
    const attempt = loadTicketSignupAttempt(getConfig().rpId, paylinkId)
    return attempt !== null && !isTicketSignupCreating(attempt)
  } catch {
    return false
  }
}

/**
 * What an activation surface may do for a ticket-funded registration, decided before any price:
 *
 * - `submitted`: the burn is on its way to L1 (a withdrawal to the SIPA, or custody stamped), so
 *   the surface shows progress and never burns twice.
 * - `ready`: the bound link is on this tab and its terms are live and fundable, so the claim may
 *   run. A SIPA not yet published is published by that claim.
 * - `blocked`: the last renewal quoted terms the link cannot pay. The link stays bound.
 * - `renew`: the terms lapsed or carry no schedule; the pending step's tick re-signs them.
 * - `missing_link`: the bound link is not on this tab; the original link has to be reopened.
 *
 * Null for a registration no paylink funds.
 */
export type TicketActivation =
  | { state: "submitted" }
  | { state: "ready"; stash: TicketSignupStash; schedule: RegistrationSchedule }
  | { state: "blocked"; stash: TicketSignupStash | null }
  | { state: "renew"; stash: TicketSignupStash | null }
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
  const stage = readRegistrationStage(session(), record, withdrawals)
  if (stage === "funding" || fundsIn(stage)) return { state: "submitted" }
  if (offer.blocked) return { state: "blocked", stash }
  const schedule = signedSchedule(terms)
  const lapsed = quoteExpired(terms, nowMs)
  if (lapsed || !schedule) return { state: "renew", stash }
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
  const record = currentRegistration(loadedRegistrations(session().registrations), l2Address)
  if (!record) return null
  // A registration this account's own burn funds keeps its continuation, submitted, until the
  // name confirms: the review is where the claim and the registration report. One funded or swept
  // by other means is not the link's.
  const sipa = record.sipaAddress.toLowerCase()
  const burnFunded = withdrawals.some(
    (w) => w.recipient.toLowerCase() === sipa && w.phase !== "failed",
  )
  if (fundsIn(readRegistrationStage(session(), record, withdrawals)) && !burnFunded) return null
  const terms = record.terms ?? null
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
    case "submitted":
      return `This payment is already claimed. @${tag} registers once the network sweeps the deposit.`
    default:
      return undefined
  }
}
