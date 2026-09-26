import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import type { Address } from "viem"
import type { PendingRegistrationRecord } from "@obsidion/front-core"
import { WALLET_TOKEN_SYMBOL, tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { useDepositAdmission } from "../identity/admission"
import { RegistrationSheet } from "./RegistrationSheet"
import { fundingAssetsLabel } from "./steps/DepositTermsRows"
import { awaitingDepositKey, awaitingDepositRecord } from "./SecureNameNoticeCard"
import { registrationRecoveryNeeded, useRegistrationRefunded } from "./registrationQuoteRecovery"
import {
  depositChainLabel,
  loadRegistrationTerms,
  quotedRegistrationKind,
  registrationKind,
  registrationQuote,
  scheduleForRecord,
  signedWithoutSchedule,
  termsUnpriced,
  useChainReadRetry,
  useDepositSkim,
  useRegistrationSchedule,
  useRegistrationTerms,
  useSweepDeductions,
} from "./registrationTerms"
import { REGISTRATIONS_PAUSED_NOTICE } from "./onboardingErrorCopy"
import { noteRegistrationDepositSeen } from "./registrationRailSync"
import { useDepositWatch } from "./useDepositWatch"
import { openClaimPrompt } from "../paylink/claimPrompt"
import { paylinkSignupQuote } from "../paylink/paylinkSignupQuote"
import { ticketActivation } from "../paylink/ticketContinuation"
import { getWithdrawalStore } from "../withdraw/withdrawGateway"
import {
  getPendingStore,
  registrationSwept,
  useRegistrationPublishStalled,
} from "./webRegistration"
import {
  activationPromptDismissed,
  closeActivationPrompt,
  openActivationPrompt,
  useActivationPromptOpen,
} from "./activationPrompt"

const CLOCK_MS = 60_000

/** The active wallet's registration still waiting for its deposit, live from the record store. */
export function useAwaitingDepositRecord(): PendingRegistrationRecord | null {
  const key = useSyncExternalStore(
    (onChange) => getPendingStore().onListChanged(onChange),
    awaitingDepositKey,
  )
  return key === null ? null : awaitingDepositRecord()
}

export function RegistrationDepositPrompt() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const config = getConfig()
  const record = useAwaitingDepositRecord()
  const open = useActivationPromptOpen()
  // Asked once per tab and record: the moment the name is waiting, unless this tab already said
  // later. A ticket-funded name whose bound link is on this tab is left to Home's claim review,
  // which owns that claim; raising this sheet beside it would be a second prompt for one action.
  useEffect(() => {
    if (!record || activationPromptDismissed(record)) return
    const ticket = ticketActivation(
      record,
      loadRegistrationTerms(record.account, record.tag),
      getWithdrawalStore().list(),
    )
    if (ticket?.state === "ready" && pathname === "/") return
    openActivationPrompt()
  }, [record?.account])
  const onClose = () => closeActivationPrompt(record)
  const terms = useRegistrationTerms(record?.account, record?.tag)
  const unsignedFallback = signedWithoutSchedule(terms)
  const [readAttempt, setReadAttempt] = useState(0)
  const retryReads = useCallback(() => setReadAttempt((n) => n + 1), [])
  const sweepDeductions = useSweepDeductions(
    config,
    record?.depositToken,
    record !== null && open,
    readAttempt,
  )
  const received = useDepositWatch(
    config,
    record && open
      ? { token: record.depositToken as Address, address: record.sipaAddress as Address }
      : null,
  )
  // Seen here first: the rail carries it from now on.
  useEffect(() => {
    if (record && received > 0n) void noteRegistrationDepositSeen(record.sipaAddress, received)
  }, [record, received])
  // The same recovery rule as the Home hero and the pending step: an earned registration whose
  // address something reached under a quote the earned price cannot use is recovered, never topped up.
  const depositAdmitted = useDepositAdmission(record)
  const refunded = useRegistrationRefunded(record)
  const sweepFee = useDepositSkim(config, record !== null && open, readAttempt)
  const chainAmounts = useRegistrationSchedule(
    config,
    record !== null && open && unsignedFallback,
    readAttempt,
    sweepFee,
  )
  useChainReadRetry(
    record !== null &&
      open &&
      ((unsignedFallback && chainAmounts === undefined) ||
        sweepFee === undefined ||
        sweepDeductions === undefined),
    retryReads,
  )
  const publishStalled = useRegistrationPublishStalled(record)
  // The deadline is checked against the clock as read on this render, so a sheet reopened after
  // the reservation lapsed never offers the address; the interval only keeps an open sheet current.
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!record || !open) return
    const timer = setInterval(tick, CLOCK_MS)
    return () => clearInterval(timer)
  }, [record, open])
  if (!record || !open) return null
  const nowMs = Date.now()

  const feeWaived = !termsUnpriced(terms) && terms?.feeWaived === true
  const schedule = scheduleForRecord(
    terms,
    unsignedFallback ? chainAmounts ?? undefined : undefined,
    record.fee !== undefined ? BigInt(record.fee) : undefined,
  )
  const fpcCut = sweepDeductions?.fpcCut
  // The sheet is a prompt, so it quotes the asked deposit, not the schedule behind it.
  const kind = quotedRegistrationKind(feeWaived, schedule, fpcCut)
  const quote = kind === undefined ? undefined : registrationQuote(schedule, kind, fpcCut)
  // No schedule is being read for this registration, and none is outstanding.
  const scheduleUnavailable =
    schedule === undefined && !(unsignedFallback && chainAmounts === undefined)
  const paused = unsignedFallback && chainAmounts === null
  const deadline = terms?.deadline && terms.deadline > 0 ? terms.deadline : undefined
  // A swept deposit is past its deadline and its publication: the sweep is what registers the name.
  const swept = registrationSwept(record)
  const expired = !swept && deadline !== undefined && nowMs > deadline * 1000
  const wrongChain = record.l1ChainId !== config.l1ChainId
  const recovery = registrationRecoveryNeeded(
    record,
    terms,
    { depositAdmitted, refunded, reached: received > 0n || record.fundedAt !== undefined },
    sweepFee || undefined,
    fpcCut,
  )
  // An unpublished address is not asked for: the pending step's retry publishes it first.
  const stalled = publishStalled && !swept && !wrongChain && !recovery && !expired
  const claimPage = () => navigate(`/claim/${record.tag}`)
  const recoveryPage = () => navigate(`/claim/${record.tag}?recovery=1`)

  // The funding decides the sheet before any price: a ticket-funded registration has a claim, a
  // burn in flight, or a way back to its link or renewal, never an external deposit ask.
  const ticket = ticketActivation(record, terms, getWithdrawalStore().list(), nowMs)
  if (ticket) {
    const ready = ticket.state === "ready"
    const quote =
      ticket.state === "ready" && fpcCut !== undefined
        ? paylinkSignupQuote({
            ...(ticket.stash.amount !== undefined ? { paylink: BigInt(ticket.stash.amount) } : {}),
            schedule: ticket.schedule,
            cuts: { withdrawalCut: fpcCut, depositCut: fpcCut },
            sweepFee: sweepFee || undefined,
          })
        : undefined
    const claimNow = () => {
      if (ticket.state !== "ready") return
      openClaimPrompt(ticket.stash.fragment)
      closeActivationPrompt(record)
      if (pathname !== "/") navigate("/")
    }
    const ticketNote =
      ticket.state === "submitted"
        ? `Payment claimed. @${record.tag} registers once the network sweeps the deposit. Nothing to send.`
        : ticket.state === "blocked"
        ? "The renewed price is not one this payment covers. Check on the registration; the link stays with it."
        : ticket.state === "renew"
        ? `The reservation for @${record.tag} needs a fresh quote before the payment can fund it.`
        : ticket.state === "unpublished"
        ? "Your deposit address was not published, so the payment cannot fund it yet. Check on the registration to try again."
        : ticket.state === "missing_link"
        ? "The payment link that funds this name is not open here. Open the link you were sent again to claim it."
        : undefined
    return (
      <RegistrationSheet
        variant="wallet"
        tag={record.tag}
        title={
          ticket.state === "submitted"
            ? "Registration pending"
            : ready
            ? "Claim your payment"
            : "Activate account"
        }
        deadline={expired ? undefined : deadline}
        note={ticketNote}
        onClose={onClose}
        settlement={
          ready
            ? {
                quote,
                tokenSymbol: WALLET_TOKEN_SYMBOL,
                tokenDecimals: tokenDecimalsForNetwork(config.network),
              }
            : undefined
        }
        actions={
          <div className="ww-deposit-actions">
            {ready && (
              <PrimaryGradientButton
                title="Claim your payment"
                isDisabled={quote === undefined || quote.covers === false}
                onClick={claimNow}
              />
            )}
            {(ticket.state === "blocked" ||
              ticket.state === "renew" ||
              ticket.state === "unpublished" ||
              ticket.state === "missing_link") && (
              <PrimaryGradientButton title="Check registration" onClick={claimPage} />
            )}
            <button
              type="button"
              className="zkm-btn-reset ww-deposit-actions__link"
              data-testid="deposit-prompt-later"
              onClick={onClose}
            >
              Later
            </button>
          </div>
        }
      />
    )
  }

  const note = wrongChain
    ? "This claim was started on a different network. Open the wallet on that network to finish it."
    : recovery
    ? refunded
      ? "The original deposit was recovered. Request a new address at the earned price. Do not send more to the old address."
      : "The old deposit address cannot use the earned price. Recover its funds before requesting a new address. Do not send more to it."
    : expired
    ? `Your reservation for @${record.tag} ended. Register it again if it is still available.`
    : stalled
    ? "Your deposit address was not published, so a deposit cannot be processed yet. Check on the registration to try again."
    : paused
    ? REGISTRATIONS_PAUSED_NOTICE
    : undefined

  return (
    <RegistrationSheet
      variant="wallet"
      tag={record.tag}
      title={
        recovery && !wrongChain
          ? "Registration needs recovery"
          : paused
          ? "Activation is paused"
          : "Activate account"
      }
      deadline={expired ? undefined : deadline}
      note={note}
      onClose={onClose}
      payment={
        wrongChain || recovery || expired || stalled || paused
          ? undefined
          : {
              address: record.sipaAddress as Address,
              token: record.depositToken as Address,
              chainId: record.l1ChainId,
              chainLabel: depositChainLabel(config),
              total: quote?.total,
              fee: quote?.fee,
              sweepFee,
              floor: quote?.floor,
              fpcCut,
              scheduleUnavailable,
              kind: kind ?? registrationKind(feeWaived),
              tokenSymbol: WALLET_TOKEN_SYMBOL,
              fundingAssets: fundingAssetsLabel(config.network),
              tokenDecimals: tokenDecimalsForNetwork(config.network),
              received,
              // The machine holds the deposit, at the address or already swept: the address it
              // was sent to is not offered again, whatever its balance reads now.
              funded: record.fundedAt !== undefined || swept,
            }
      }
      actions={
        <div className="ww-deposit-actions">
          {recovery && !wrongChain && (
            <PrimaryGradientButton
              title={refunded ? "Request a new address" : "Recover deposit"}
              onClick={recoveryPage}
            />
          )}
          {expired && !recovery && !wrongChain && (
            <PrimaryGradientButton title={`Register @${record.tag} again`} onClick={claimPage} />
          )}
          {stalled && <PrimaryGradientButton title="Check registration" onClick={claimPage} />}
          <button
            type="button"
            className="zkm-btn-reset ww-deposit-actions__link"
            data-testid="deposit-prompt-later"
            onClick={onClose}
          >
            Later
          </button>
        </div>
      }
    />
  )
}
