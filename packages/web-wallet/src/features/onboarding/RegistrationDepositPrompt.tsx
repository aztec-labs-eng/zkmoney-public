import { useCallback, useEffect, useReducer, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import type { Address } from "viem"
import { fundsIn } from "@obsidion/front-core"
import { WALLET_TOKEN_SYMBOL, tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { useDepositAdmission } from "../identity/admission"
import { OweRegistrationBroadcast } from "../broadcasts/useOweRegistrationBroadcast"
import { RegistrationSheet } from "./RegistrationSheet"
import { swapAssetsLabel } from "./steps/DepositTermsRows"
import { useOpenRegistration } from "./openRegistration"
import { registrationRecoveryNeeded, useRegistrationRefunded } from "./registrationQuoteRecovery"
import {
  committedProverTip,
  depositChainLabel,
  loadRegistrationTerms,
  quotedRegistrationKind,
  registrationKind,
  quoteExpired,
  registrationQuote,
  reservedUntil,
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
import { registrationAddressPublished, useRegistrationPublishStalled } from "./webRegistration"
import {
  activationPromptDismissed,
  closeActivationPrompt,
  openActivationPrompt,
  useActivationPromptOpen,
} from "./activationPrompt"

const CLOCK_MS = 60_000

export function RegistrationDepositPrompt() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const config = getConfig()
  // Only a registration still awaiting its deposit: once the record is promoted, the Home hero
  // carries the claim.
  const current = useOpenRegistration()
  const registration = current?.record.phase === "awaiting_deposit" ? current : null
  const record = registration?.record ?? null
  const open = useActivationPromptOpen()
  // Asked once per tab and record: the moment the name is waiting, unless this tab already closed
  // it. A ticket-funded name on Home is left to Home, which claims its link itself and reports
  // the rest in the hero; raising this sheet beside it would be a second prompt for one action.
  useEffect(() => {
    if (!record || activationPromptDismissed(record)) return
    const ticket = ticketActivation(
      record,
      loadRegistrationTerms(record.account, record.tag),
      getWithdrawalStore().list(),
    )
    if (ticket && pathname === "/") return
    openActivationPrompt()
  }, [record?.account])
  const onClose = () => closeActivationPrompt(record)
  const terms = useRegistrationTerms(record?.account, record?.tag)
  const unsignedFallback = signedWithoutSchedule(terms)
  const [readAttempt, setReadAttempt] = useState(0)
  const retryReads = useCallback(() => setReadAttempt((n) => n + 1), [])
  // The pill's own read of the address is out.
  const [reading, setReading] = useState(false)
  const sweepDeductions = useSweepDeductions(
    config,
    record?.depositToken,
    record !== null && open,
    readAttempt,
  )
  const watch = useDepositWatch(
    config,
    record && open
      ? { token: record.depositToken as Address, address: record.sipaAddress as Address }
      : null,
  )
  const { balance: received, token: receivedToken } = watch
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
  if (!registration || !record || !open) return null
  const nowMs = Date.now()
  const { stage } = registration

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
  // Funds in are past the quote's deadline and the address's publication.
  const held = fundsIn(stage)
  const expired = !held && quoteExpired(terms, nowMs)
  const holdEnds = reservedUntil(terms, nowMs)
  const wrongChain = record.l1ChainId !== config.l1ChainId
  const recovery = registrationRecoveryNeeded(
    record,
    terms,
    { depositAdmitted, refunded, reached: received > 0n || record.fundedAt !== undefined },
    sweepFee || undefined,
    fpcCut,
  )
  // An unpublished address is not asked for: the pending step's retry publishes it first.
  const stalled = publishStalled && !held && !wrongChain && !recovery && !expired
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
            // The review this hands off to quotes the tip again.
            proverTip: committedProverTip(terms),
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
        ? publishStalled
          ? "Your deposit address was not published, so the payment cannot fund it yet. Check on the registration to try again."
          : "Publishing your deposit address. The payment funds it once that lands."
        : ticket.state === "missing_link"
        ? "The payment link that funds this name is not open here. Open the link you were sent again to claim it."
        : undefined
    return (
      <>
        {ticket.state === "unpublished" && <OweRegistrationBroadcast record={record} />}
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
          reservedUntil={expired ? undefined : holdEnds}
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
            ticket.state === "submitted" ? undefined : (
              <div className="ww-deposit-actions">
                {ready ? (
                  <PrimaryGradientButton
                    title="Claim your payment"
                    isDisabled={quote === undefined || quote.covers === false}
                    onClick={claimNow}
                  />
                ) : (
                  <PrimaryGradientButton title="Check registration" onClick={claimPage} />
                )}
              </div>
            )
          }
        />
      </>
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

  const addressShown = !(wrongChain || recovery || expired || stalled || paused)
  return (
    <>
      {addressShown && <OweRegistrationBroadcast record={record} />}
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
        reservedUntil={expired ? undefined : holdEnds}
        note={note}
        onClose={onClose}
        payment={
          !addressShown
            ? undefined
            : {
                address: record.sipaAddress as Address,
                publishing: !registrationAddressPublished(record),
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
                network: config.network,
                swapAssets: swapAssetsLabel(config.network),
                tokenDecimals: tokenDecimalsForNetwork(config.network),
                received,
                receivedToken,
                // The machine holds the deposit, at the address or already swept: the address it
                // was sent to is not offered again, whatever its balance reads now.
                funded: held,
                // The pill: the chain reads again, and the address ahead of its poll.
                check: {
                  lastCheckedAt: watch.readAt,
                  busy: reading,
                  onCheck: () => {
                    retryReads()
                    setReading(true)
                    void watch.read().finally(() => setReading(false))
                  },
                },
              }
        }
        actions={
          wrongChain || !(recovery || expired || stalled) ? undefined : (
            <div className="ww-deposit-actions">
              {recovery ? (
                <PrimaryGradientButton
                  title={refunded ? "Request a new address" : "Recover deposit"}
                  onClick={recoveryPage}
                />
              ) : expired ? (
                <PrimaryGradientButton
                  title={`Register @${record.tag} again`}
                  onClick={claimPage}
                />
              ) : (
                <PrimaryGradientButton title="Check registration" onClick={claimPage} />
              )}
            </div>
          )
        }
      />
    </>
  )
}
