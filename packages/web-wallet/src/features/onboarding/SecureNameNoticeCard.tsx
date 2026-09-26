import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { useNavigate } from "react-router-dom"
import {
  SIPADepositStore,
  formatDateLabel,
  formatTimeLabel,
  sipaDepositInflightLabel,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import { Card, Icon, PrimaryGradientButton, Spinner } from "@obsidion/web-ds"
import paylinkCoins from "../../assets/home/paylink-coins.webp"
import { getConfig } from "../../config/env"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { ticketActivation } from "../paylink/ticketContinuation"
import { getWithdrawalStore } from "../withdraw/withdrawGateway"
import { useDepositAdmission } from "../identity/admission"
import {
  getPendingStore,
  registrationSwept,
  useRegistrationEscalated,
  useRegistrationPublishStalled,
  useTagPresentationPending,
} from "./webRegistration"
import {
  signedWithoutSchedule,
  termsUnpriced,
  useChainReadRetry,
  useDepositSkim,
  useRegistrationSchedule,
  useRegistrationTerms,
  useSweepDeductions,
} from "./registrationTerms"
import { REGISTRATIONS_PAUSED_NOTICE } from "./onboardingErrorCopy"
import { registrationRecoveryNeeded, useRegistrationRefunded } from "./registrationQuoteRecovery"

const CLOCK_MS = 60_000

/** The active wallet's registration whose deposit landed and whose claim is on the wire: the
 *  only state that is genuinely "claiming". An unfunded or unbroadcast record is still waiting. */
function claimingRecord(): PendingRegistrationRecord | null {
  const identity = loadWalletIdentity()
  const record = getPendingStore().current()
  if (!identity?.pending || !record || record.phase !== "funded" || !record.broadcast) return null
  return record.l2Address.toLowerCase() === identity.address.toLowerCase() ? record : null
}

/**
 * Where the open registration's deposit is on the rail, as the bell's live row words it, or null
 * before the funds are seen and once they are credited.
 */
function railStage(): string | null {
  const open = getPendingStore().current()
  if (!open) return null
  const deposit = SIPADepositStore.get(webStorage).get(open.sipaAddress as never)
  return deposit ? sipaDepositInflightLabel(deposit) ?? null : null
}

/** The active wallet's registration still waiting for its deposit, if any. */
export function awaitingDepositRecord(): PendingRegistrationRecord | null {
  const identity = loadWalletIdentity()
  const record = getPendingStore().current()
  if (!identity?.pending || !record || record.phase !== "awaiting_deposit") return null
  return record.l2Address.toLowerCase() === identity.address.toLowerCase() ? record : null
}

/**
 * What the activation surfaces read off the open record, as one snapshot: the store hands out
 * fresh objects, which would never settle. The custody stamps are in because a sweep or a funding
 * observed between polls changes them and nothing else.
 */
export function awaitingDepositKey(): string | null {
  const open = getPendingStore().current()
  if (!open) return null
  return [open.account, open.phase, open.broadcast, open.fundedAt, open.sweptAt, open.sweepTxHash]
    .map((v) => v ?? "")
    .join(":")
}

/**
 * The standing reminder for a name entered before its deposit (registration-fee.md Campaign:
 * Free names enter at once, and a waived reload may enter early): that a deposit is owed and how
 * long the reservation holds. The amount and address are in the deposit prompt (`onActivate`),
 * else the pending step. Gone once the deposit is seen.
 */
export function SecureNameNoticeCard({ onActivate }: { onActivate?: () => void } = {}) {
  const navigate = useNavigate()
  const config = getConfig()
  const claiming = useTagPresentationPending()
  const escalated = useRegistrationEscalated()
  const key = useSyncExternalStore(
    (onChange) => getPendingStore().onListChanged(onChange),
    awaitingDepositKey,
  )
  const stage = useSyncExternalStore(
    (onChange) => SIPADepositStore.get(webStorage).onListChanged(onChange),
    railStage,
  )
  const account = key === null ? null : awaitingDepositRecord()?.account ?? null
  const record = account === null ? null : awaitingDepositRecord()
  const depositAdmitted = useDepositAdmission(record)
  const refunded = useRegistrationRefunded(record)
  const publishStalled = useRegistrationPublishStalled(record)
  const terms = useRegistrationTerms(record?.account, record?.tag)
  const unsignedFallback = signedWithoutSchedule(terms)
  const [readAttempt, setReadAttempt] = useState(0)
  const retryReads = useCallback(() => setReadAttempt((n) => n + 1), [])
  const sweepFee = useDepositSkim(config, record !== null, readAttempt)
  const chainAmounts = useRegistrationSchedule(
    config,
    record !== null && unsignedFallback,
    readAttempt,
    sweepFee,
  )
  const deductions = useSweepDeductions(config, record?.depositToken, record !== null, readAttempt)
  useChainReadRetry(
    record !== null &&
      ((unsignedFallback && chainAmounts === undefined) ||
        sweepFee === undefined ||
        deductions === undefined),
    retryReads,
  )
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!record) return
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_MS)
    return () => clearInterval(timer)
  }, [record])

  const identity = loadWalletIdentity()
  // The claim is still in flight: the same hero, holding, rather than a separate line on Home.
  // An escalated claim has no background driver left, so it says so and stays the way back in.
  if (claiming && identity?.handle && claimingRecord()) {
    return (
      <button
        type="button"
        className="zkm-btn-reset ww-banner ww-banner--activate"
        data-testid="claiming-notice"
        aria-label={`Claiming @${identity.handle}`}
        onClick={() => navigate(`/claim/${identity.handle}`)}
      >
        <span className="ww-banner__text">
          <span className="ww-banner__title">Claiming @{identity.handle}</span>
          <span className="ww-banner__body">
            {escalated
              ? "This is taking longer than expected. Check on it."
              : `${stage ?? "Securing your tag"}. This only takes a moment.`}
          </span>
        </span>
        <img src={paylinkCoins} alt="" />
        <span className="ww-banner__chevron">
          <Spinner size={12} color="#fff" />
        </span>
      </button>
    )
  }

  if (!record) return null
  // A paylink-funded registration is never asked for an L1 deposit: its link's claim funds the
  // SIPA. What it needs is decided before any price: progress while the burn is on its way,
  // the claim while the bound link is on this tab, else the way back to the link or the renewal.
  const ticket = ticketActivation(record, terms, getWithdrawalStore().list(), nowMs)
  if (ticket) {
    const reservedUntil =
      terms?.deadline && terms.deadline > 0
        ? ` until ${formatDateLabel(terms.deadline * 1000)}`
        : ""
    const submitted = ticket.state === "submitted"
    const title =
      ticket.state === "submitted"
        ? "Registration pending"
        : ticket.state === "ready"
        ? "Claim your payment"
        : ticket.state === "blocked"
        ? `This payment cannot fund @${record.tag}`
        : ticket.state === "renew"
        ? "Refresh your reservation"
        : ticket.state === "unpublished"
        ? "Activate account"
        : "Open your payment link"
    const body =
      ticket.state === "submitted"
        ? `Payment claimed. @${record.tag} registers once the network sweeps the deposit. Nothing to send.`
        : ticket.state === "ready"
        ? `@${record.tag} is reserved${reservedUntil}. The payment you were sent funds it — claim it to finish.`
        : ticket.state === "blocked"
        ? "The renewed price is not one the payment covers. Check on the registration."
        : ticket.state === "renew"
        ? `The reservation for @${record.tag} needs a fresh quote. Open it to renew.`
        : ticket.state === "unpublished"
        ? "Your deposit address was not published. Check on it to try again."
        : `@${record.tag} is reserved${reservedUntil}. Open the payment link you were sent again to claim it and fund the tag.`
    return (
      <button
        type="button"
        className="zkm-btn-reset ww-banner ww-banner--activate"
        data-testid="secure-name-notice"
        data-ticket-state={ticket.state}
        aria-label={`Activate @${record.tag}`}
        onClick={() => (onActivate ? onActivate() : navigate(`/claim/${record.tag}`))}
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
    { depositAdmitted, refunded },
    sweepFee || undefined,
    deductions?.fpcCut,
  )
  // A past refund holds this hero only while the restart it calls for is still owed: a registration
  // resumed under the corrected quote wants its deposit again.
  if (depositAdmitted || needsRefund) {
    return (
      <button
        type="button"
        className="zkm-btn-reset ww-banner ww-banner--activate ww-banner--registration-pending"
        data-testid="registration-pending-notice"
        aria-label={`Check registration for @${record.tag}`}
        onClick={() => navigate(`/claim/${record.tag}?recovery=1`)}
      >
        <span className="ww-banner__text">
          <span className="ww-banner__title">
            {needsRefund ? "Registration needs recovery" : "Deposit received"}
          </span>
          <span className="ww-banner__body">
            {needsRefund
              ? refunded
                ? "Your wallet is open. The old deposit was recovered. Register at the earned price."
                : "Your wallet is open. Recover the old deposit, then register at the earned price."
              : `Your wallet is open. Registration for @${record.tag} is still pending. Check its status. Do not send another deposit.`}
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
  // An unpriced quote cannot waive a fee it never priced.
  const feeWaived = !termsUnpriced(terms) && terms?.feeWaived === true
  // A swept deposit is past its deadline and its publication: the sweep is what registers the name.
  const swept = registrationSwept(record)
  // Past the stored deadline the resume path signs a fresh quote, so the banner leads back there.
  const quoteStale = !swept && terms !== null && terms.deadline > 0 && nowMs > terms.deadline * 1000
  const paused = unsignedFallback && chainAmounts === null
  // An unpublished address is not asked for: the pending step's retry publishes it first.
  const stalled = !quoteStale && !paused && !swept && publishStalled
  /**
   * The deposit landed at the address, or was already swept from it, and no detection tick has
   * promoted the record yet. The money is in: the hero says so and spins, rather than asking again
   * for what was just sent.
   */
  const detected = !quoteStale && !paused && !stalled && (record.fundedAt !== undefined || swept)
  // A live quote's deadline is the headline. The amount it holds is the sheet's to name.
  const held =
    !quoteStale && terms !== null && terms.deadline > 0 ? terms.deadline * 1000 : undefined
  const heldLine =
    held === undefined
      ? undefined
      : `Reserved until ${formatDateLabel(held)}, ${formatTimeLabel(held)}.`
  const body = `Send a deposit to keep @${record.tag}.${feeWaived ? " The tag is free." : ""}`

  return (
    <button
      type="button"
      className="zkm-btn-reset ww-banner ww-banner--activate"
      data-testid="secure-name-notice"
      aria-label={`Activate @${record.tag}`}
      onClick={() =>
        onActivate && !quoteStale && !paused && !stalled
          ? onActivate()
          : navigate(`/claim/${record.tag}`)
      }
    >
      <span className="ww-banner__text">
        <span className="ww-banner__title">
          {quoteStale
            ? "Refresh your deposit"
            : paused
            ? "Activation is paused"
            : detected
            ? "Deposit received"
            : "Activate account"}
        </span>
        <span className="ww-banner__body">
          {quoteStale ? (
            "The deposit amount needs a refresh. Open it to get the current amount."
          ) : paused ? (
            REGISTRATIONS_PAUSED_NOTICE
          ) : stalled ? (
            `${
              heldLine ? `${heldLine} ` : ""
            }Your deposit address was not published. Check on it to try again.`
          ) : detected ? (
            `${stage ? `${stage}. Registering` : "Confirming it and registering"} @${
              record.tag
            }. This only takes a moment.`
          ) : (
            <>
              {heldLine !== undefined && (
                <>
                  {heldLine}
                  <br />
                </>
              )}
              {body}
            </>
          )}
        </span>
      </span>
      <img src={paylinkCoins} alt="" />
      <span
        className="ww-banner__chevron"
        {...(detected ? { "data-testid": "deposit-detected" } : {})}
      >
        {detected ? (
          <Spinner size={12} color="#fff" />
        ) : (
          <Icon name="chevron-right" size={8.5} color="#fff" />
        )}
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
  const identity = loadWalletIdentity()
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
          Pick your name
        </span>
        <span className="zkm-type-body-sm" style={{ color: "var(--text-secondary)" }}>
          People pay a name, not an address. Register yours whenever you are ready.
        </span>
        <PrimaryGradientButton title="Register a name" onClick={() => navigate("/claim")} />
      </div>
    </Card>
  )
}
