import { useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import {
  formatDateLabel,
  formatTimeLabel,
  memoryStore,
  SIPA_PROCESSING_COPY,
  depositPhaseCopy,
  depositDetailOffer,
  currentRegistration,
  depositOwed,
  fundsIn,
  registrationRecoveryNeeded,
  selectSipaDeposit,
  useStore,
  type SipaProcessingState,
} from "@obsidion/front-core"
import { railStage, type RailStage } from "./railStage"
import { Card, Icon, PrimaryGradientButton, Spinner } from "@obsidion/web-ds"
import { WALLET_TOKEN_SYMBOL, tokenDecimalsForNetwork } from "@obsidion/core/constants"
import paylinkCoins from "../../../assets/home/paylink-coins.webp"
import { DepositDetailModal } from "../../../ui/screens/DepositDetailModal/DepositDetailModal"
import rowCopy from "../../../ui/activity/ActivityRow.copy"
import { registrationRecordForSipa } from "../../registration/webRegistration"
import { DepositExitModal } from "../../deposit/DepositExitModal/DepositExitModal"
import { usePolledChainSeconds } from "../../paylink/chainTime"
import { claimWaitSeconds, useClaimCountdown } from "../../paylink/claimWindow"
import { peekClaimStash } from "../../paylink/claimStash"
import { tabStash } from "../../../platform/storage/tabStash"
import {
  claimLinkId,
  claimRefused,
  linkOf,
  ticketClaimGate,
  ticketClaimView,
} from "../../paylink/ticketClaim"
import { useActionVerdict } from "../../actionGate"
import { openTicketClaimReview, ticketActivation } from "../../paylink/ticketContinuation"
import { useSipaProcessing } from "../../deposit/sipaProcessing"
import { useDepositAdmission, useDepositShown } from "../../registration/admission"
import {
  loadedRegistrations,
  useRegistrationEscalated,
  useRegistrationPublishStalled,
} from "../../registration/webRegistration"
import { useOpenRegistration } from "../../registration/openRegistration"
import {
  quoteExpired,
  reservedUntil,
  signedWithoutSchedule,
  termsUnpriced,
  useRegistrationTerms,
} from "../../registration/registrationTerms"
import { useRegistrationPricing } from "../../registration/registrationPricing"
import { REGISTRATIONS_PAUSED_NOTICE } from "../onboardingErrorCopy"
import { formatTokenAmount } from "../../deposit/DepositTermsRows/DepositTermsRows"
import { useRegistrationRefunded } from "../../registration/registrationRecovery"
import { useSession } from "../../../session/session"
import { fmt } from "../../../lib/fmt"
import copy from "./SecureNameNoticeCard.copy"

/** A direct link, which Home claims without a tap; an email link's sign-in needs one. */

/** What the hero says while Home's own claim of the link waits to start. */
function holdBody(countdown: string | undefined): string {
  return countdown === undefined ? copy.hold.preparing : fmt(copy.hold.countdown, { countdown })
}

/**
 * Where the open registration's deposit is on the rail, as the bell's live row words it, or null
 * before the funds are seen and once they are credited. A deposit waiting for its sweep says why,
 * by the shared `sipaReasonShown` rule.
 */
function railLabel({ deposit, shown }: RailStage): string | null {
  if (!deposit) return null
  return shown
    ? SIPA_PROCESSING_COPY[shown.reason.kind].short
    : depositPhaseCopy(deposit).live ?? null
}

const NO_STATES = memoryStore<ReadonlyMap<string, SipaProcessingState>>(new Map()).readonly

/** The registration's deposit as the activity feed shows it, kept current while open. */
function LiveDepositDetail(props: { sipaAddress: string; tag: string; onClose: () => void }) {
  const { sipaDeposits, registrations } = useSession()
  const deposit = useStore(sipaDeposits.view, (set) => selectSipaDeposit(set, props.sipaAddress))
  // Records that cannot be read offer no exit: which sweep the address takes is unknown.
  const unread = useStore(registrations.view, (view) => view.failed)
  const { state: processing } = useSipaProcessing(props.sipaAddress)
  const [exit, setExit] = useState<NonNullable<ReturnType<typeof depositDetailOffer>>>()
  if (!deposit) return null
  if (exit) {
    return (
      <DepositExitModal
        record={deposit}
        reason={exit.reason}
        canSweep={exit.canSweep}
        sweepable={exit.sweepable}
        onClose={props.onClose}
      />
    )
  }
  const offer = unread
    ? undefined
    : depositDetailOffer(deposit, {
        processing,
        registration: registrationRecordForSipa(registrations, deposit.sipaAddress) ?? undefined,
        now: Date.now(),
      })
  return (
    <DepositDetailModal
      record={deposit}
      registrationTag={props.tag}
      exit={
        offer
          ? {
              title: offer.action === "sweep" ? rowCopy.action.sweep : rowCopy.action.recover,
              sweep: offer.canSweep,
              onStart: () => setExit(offer),
            }
          : undefined
      }
      onClose={props.onClose}
    />
  )
}

/**
 * The standing reminder for a name entered before its deposit (registration-fee.md Campaign:
 * Free names enter at once, and a waived reload may enter early): that a deposit is owed and how
 * long the reservation holds. The caller's `ask` renders the plain deposit ask with its hold and
 * waiver note; a quote to refresh, paused registrations and an unpublished address are banners that
 * lead to the pending step. A ticket-funded name reads as claiming while Home claims its link, which
 * also publishes its address. Once funds are in it reads as claiming until the name registers.
 */
export function SecureNameNoticeCard({ ask }: { ask: (note: string) => ReactNode }) {
  const navigate = useNavigate()
  const session = useSession()
  const { config } = session.page
  const escalated = useRegistrationEscalated()
  const { wallClock } = useSession().page
  const nowMs = useStore(wallClock)
  const open = useOpenRegistration()
  const record = open?.record ?? null
  const deposits = useStore(session.sipaDeposits.view)
  const observer = session.sipaProcessingObserver
  useStore(observer?.states ?? NO_STATES)
  const railAt = railStage(
    currentRegistration(loadedRegistrations(session.registrations)),
    deposits,
    (sipa) => observer?.stateFor(sipa),
    nowMs,
  )
  const rail = railLabel(railAt)
  const moment = railAt.openEnded ? "" : copy.moment
  const depositAdmitted = useDepositAdmission(record)
  const seen = useDepositShown(record)
  const refunded = useRegistrationRefunded(record)
  const publishStalled = useRegistrationPublishStalled(record)
  // Whether this page is claiming the stashed link, for a ticket-funded name, or will on its own.
  const stashed = peekClaimStash(tabStash)
  const stashedLink = stashed === null ? null : linkOf(config, stashed)
  const claims = useStore(session.claims.state)
  const claimRunning = stashed !== null && claims.running.has(stashed)
  const operations = useStore(session.operations.view, (view) => view.records)
  const chainNow = usePolledChainSeconds(stashedLink !== null)
  const opensAt = stashedLink?.claimableFrom ?? undefined
  const countdown = useClaimCountdown(claimWaitSeconds(opensAt, chainNow), chainNow, session.page)
  const claimOpen = useActionVerdict("claim") === "open"
  const linkFunding = claims.funding
  const terms = useRegistrationTerms(record?.account, record?.tag)
  const unsignedFallback = signedWithoutSchedule(terms)
  const { sweepFee, schedule: chainAmounts } = useRegistrationPricing(
    record !== null,
    unsignedFallback,
  )
  const [detailOpen, setDetailOpen] = useState(false)
  const burns = useStore(session.withdrawals.list)

  // Unknown while the withdrawals load: the card waits rather than ask for a funded deposit.
  if (!open || !record || open.stage === undefined || !burns.hydrated) return null
  const { stage } = open
  // A paylink-funded registration is never asked for an L1 deposit: its link's claim funds and
  // publishes the SIPA. What it needs is decided before any price: progress while this page claims
  // or the burn is on its way; the claim while the bound link is on this tab; else the way back to
  // the link or the renewal.
  const ticket = ticketActivation(session, record, terms, burns.records, nowMs)
  if (ticket) {
    const holdEnds = reservedUntil(terms, nowMs)
    const heldFor =
      holdEnds === undefined ? "" : fmt(copy.ticket.heldFor, { date: formatDateLabel(holdEnds) })
    // The burn's record is written before its batch signs, so `submitted` alone would read as sent
    // too early: the page's own claim covers proving and the send. Home claims a ready direct link
    // by itself, so the tap is asked for only once that try is over without a claim.
    const auto =
      ticket.state === "ready"
        ? ticketClaimView(
            ticketClaimGate({
              activation: ticket.state,
              link: linkOf(config, ticket.stash.fragment),
              chainNow,
              open: claimOpen,
            }),
            claims,
            ticket.stash.fragment,
            claimRefused(operations, claimLinkId(ticket.stash.fragment)),
          )
        : undefined
    const claimingLink =
      (claimRunning && ticket.state === "submitted") ||
      auto?.kind === "claiming" ||
      auto?.kind === "hold"
    // Home's own claim has not started: what it waits for, since the bell has nothing yet.
    const held = auto?.kind === "hold" ? auto.hold : undefined
    const submitted = claimingLink || ticket.state === "submitted"
    const tag = record.tag
    const title = held
      ? fmt(copy.ticket.title.held, { tag })
      : submitted
      ? fmt(copy.claiming, { tag })
      : ticket.state === "ready"
      ? copy.claimPayment
      : ticket.state === "blocked"
      ? fmt(copy.ticket.title.blocked, { tag })
      : ticket.state === "renew"
      ? copy.ticket.title.renew
      : copy.ticket.title.open
    const body = held
      ? holdBody(typeof held === "object" ? countdown : undefined)
      : claimingLink
      ? copy.ticket.body.claiming
      : ticket.state === "submitted"
      ? rail
        ? fmt(copy.ticket.body.rail, { rail })
        : fmt(copy.ticket.body.submitted, { tag })
      : ticket.state === "ready"
      ? fmt(copy.ticket.body.ready, { tag, heldFor })
      : ticket.state === "blocked"
      ? copy.ticket.body.blocked
      : ticket.state === "renew"
      ? fmt(copy.ticket.body.renew, { tag })
      : fmt(copy.ticket.body.open, { tag, heldFor })
    return (
      <button
        type="button"
        className="zkm-btn-reset ww-banner ww-banner--activate"
        data-testid="secure-name-notice"
        data-ticket-state={ticket.state}
        aria-label={fmt(copy.activateLabel, { tag })}
        onClick={() => openTicketClaimReview(session) || navigate(`/claim/${record.tag}`)}
      >
        <span className="ww-banner__text">
          <span className="ww-banner__title">{title}</span>
          <span className="ww-banner__body">{body}</span>
        </span>
        <img src={paylinkCoins} alt="" />
        <span className="ww-banner__chevron">
          {submitted ? (
            <Spinner size={12} color="#fff" />
          ) : (
            <Icon name="chevron-right" size={12} color="#fff" />
          )}
        </span>
      </button>
    )
  }
  const needsRefund = registrationRecoveryNeeded(
    record,
    terms,
    { depositAdmitted, refunded, seen },
    sweepFee || undefined,
  )
  // A past refund holds this hero only while the restart it calls for is still owed: a registration
  // resumed under the corrected quote wants its deposit again. A funded one is the sweep's to finish
  // unless its committed quote must be recovered first.
  if (needsRefund || (record.phase === "awaiting_deposit" && depositAdmitted)) {
    return (
      <button
        type="button"
        className="zkm-btn-reset ww-banner ww-banner--activate"
        data-testid="registration-pending-notice"
        aria-label={fmt(copy.recovery.label, { tag: record.tag })}
        onClick={() => navigate(`/claim/${record.tag}?recovery=1`)}
      >
        <span className="ww-banner__text">
          <span className="ww-banner__title">
            {needsRefund ? copy.recovery.title : fmt(copy.claiming, { tag: record.tag })}
          </span>
          <span className="ww-banner__body">
            {needsRefund
              ? refunded
                ? copy.recovery.refunded
                : copy.recovery.recover
              : fmt(copy.recovery.pending, { tag: record.tag })}
          </span>
        </span>
        <img src={paylinkCoins} alt="" />
        <span
          className="ww-banner__chevron"
          {...(needsRefund ? {} : { "data-testid": "deposit-detected" })}
        >
          {needsRefund ? (
            <Icon name="chevron-right" size={8.5} color="#fff" />
          ) : (
            <Spinner size={12} color="#fff" />
          )}
        </span>
      </button>
    )
  }
  // Funds are in: the hero holds and spins until the name is registered. A deposit still waiting
  // for its sweep after the background driver gave up says so and stays the way back in.
  if (fundsIn(stage) || stage === "funding") {
    const stuck = escalated && (stage === "received" || stage === "sweeping")
    return (
      <>
        <button
          type="button"
          className="zkm-btn-reset ww-banner ww-banner--activate"
          data-testid="claiming-notice"
          aria-label={fmt(copy.claiming, { tag: record.tag })}
          onClick={() =>
            openTicketClaimReview(session) ||
            (selectSipaDeposit(deposits, record.sipaAddress)
              ? setDetailOpen(true)
              : navigate(`/claim/${record.tag}`))
          }
        >
          <span className="ww-banner__text">
            <span className="ww-banner__title">{fmt(copy.claiming, { tag: record.tag })}</span>
            <span className="ww-banner__body">
              {stuck
                ? copy.fundsIn.stuck
                : fmt(copy.fundsIn.stage, {
                    stage:
                      rail ?? (stage === "funding" ? copy.fundsIn.funding : copy.fundsIn.received),
                    moment,
                  })}
            </span>
          </span>
          <img src={paylinkCoins} alt="" />
          <span className="ww-banner__chevron" data-testid="deposit-detected">
            <Spinner size={12} color="#fff" />
          </span>
        </button>
        {detailOpen && (
          <LiveDepositDetail
            sipaAddress={record.sipaAddress}
            tag={record.tag}
            onClose={() => setDetailOpen(false)}
          />
        )}
      </>
    )
  }
  // A stashed link that may pay the deposit: no deposit is asked for while Home checks it, and
  // once it pays, the way back to its review stands in for the ask.
  if (depositOwed(stage) && linkFunding && linkFunding.fragment === stashed) {
    const checking = linkFunding.state === "checking"
    const amount =
      linkFunding.amount === undefined
        ? copy.linkFunding.amountUnknown
        : fmt(copy.linkFunding.amount, {
            amount: formatTokenAmount(
              linkFunding.amount,
              tokenDecimalsForNetwork(config.network),
              WALLET_TOKEN_SYMBOL,
            ),
          })
    return (
      <button
        type="button"
        className="zkm-btn-reset ww-banner ww-banner--activate"
        data-testid="secure-name-notice"
        data-link-funding={linkFunding.state}
        aria-label={
          checking
            ? copy.linkFunding.checkingLabel
            : fmt(copy.linkFunding.claimLabel, { tag: record.tag })
        }
        disabled={checking}
        onClick={() => session.claims.request(linkFunding.fragment)}
      >
        <span className="ww-banner__text">
          <span className="ww-banner__title">
            {checking ? copy.linkFunding.checkingTitle : copy.claimPayment}
          </span>
          <span className="ww-banner__body">
            {checking
              ? fmt(copy.linkFunding.checkingBody, { tag: record.tag })
              : fmt(copy.linkFunding.claimBody, { amount, tag: record.tag })}
          </span>
        </span>
        <img src={paylinkCoins} alt="" />
        <span className="ww-banner__chevron">
          {checking ? (
            <Spinner size={12} color="#fff" />
          ) : (
            <Icon name="chevron-right" size={12} color="#fff" />
          )}
        </span>
      </button>
    )
  }
  if (!depositOwed(stage)) return null
  // An unpriced quote cannot waive a fee it never priced.
  const feeWaived = !termsUnpriced(terms) && terms?.feeWaived === true
  // Past the stored deadline the resume path signs a fresh quote, so the banner leads back there.
  const quoteStale = quoteExpired(terms, nowMs)
  const paused = unsignedFallback && chainAmounts === null
  // An unpublished address is not asked for: the pending step's retry publishes it first.
  const stalled = !quoteStale && !paused && publishStalled
  // The hold is the headline. The amount it holds is the sheet's to name.
  const held = quoteStale ? undefined : reservedUntil(terms, nowMs)
  const heldLine =
    held === undefined
      ? undefined
      : fmt(copy.deposit.held, { date: formatDateLabel(held), time: formatTimeLabel(held) })
  if (!quoteStale && !paused && !stalled)
    return ask([heldLine, feeWaived && copy.deposit.free].filter(Boolean).join(" "))

  return (
    <button
      type="button"
      className="zkm-btn-reset ww-banner ww-banner--activate"
      data-testid="secure-name-notice"
      aria-label={fmt(copy.activateLabel, { tag: record.tag })}
      onClick={() => navigate(`/claim/${record.tag}`)}
    >
      <span className="ww-banner__text">
        <span className="ww-banner__title">
          {quoteStale
            ? copy.deposit.title.stale
            : paused
            ? copy.deposit.title.paused
            : copy.deposit.title.unpublished}
        </span>
        <span className="ww-banner__body">
          {quoteStale
            ? copy.deposit.stale
            : paused
            ? REGISTRATIONS_PAUSED_NOTICE
            : fmt(copy.deposit.unpublished, { held: heldLine ? `${heldLine} ` : "" })}
        </span>
      </span>
      <img src={paylinkCoins} alt="" />
      <span className="ww-banner__chevron">
        <Icon name="chevron-right" size={8.5} color="#fff" />
      </span>
    </button>
  )
}

/**
 * The standing prompt for a nameless account: the wallet works, but receiving by tag, sponsored
 * fees, and messaging all wait on a registered name. Leads to the name step; the ceremony there
 * asserts the existing passkey instead of minting one.
 */
export function RegisterNameCard() {
  const navigate = useNavigate()
  const identity = useStore(useSession().identity).value
  if (!identity || identity.handle) return null
  return (
    <Card padding={16} style={{ marginBottom: 24 }}>
      <div
        data-testid="register-name-prompt"
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        <span
          className="zkm-type-card-title"
          style={{ color: "var(--text-primary)", fontFamily: "var(--font-display)" }}
        >
          {copy.registerName.title}
        </span>
        <span className="zkm-type-body-sm" style={{ color: "var(--text-secondary)" }}>
          {copy.registerName.body}
        </span>
        <PrimaryGradientButton
          title={copy.registerName.action}
          onClick={() => navigate("/claim")}
        />
      </div>
    </Card>
  )
}
