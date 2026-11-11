import { ModalFrame } from "../../../ui/Modal"
import type { ReactNode } from "react"
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom"
import type { Address } from "viem"
import {
  isRegistrationEscalated,
  normalizeTag,
  pendingRecordState,
  selectPendingEntry,
  useStore,
} from "@obsidion/front-core"
import { WALLET_TOKEN_SYMBOL, tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { errorMessage } from "../../../errors/catalog"
import { useHoldEndpoints } from "../../../session/endpointsHold"
import { useNextRoute } from "../../../ui/hooks"
import { useDepositAdmission, useDepositShown } from "../../registration/admission"
import { openCreationProbe, useCeremonyGate } from "../../identity/ceremonyGate"
import { IosFloorNotice } from "../../identity/IosFloorNotice"
import { PasskeyRefusal, leadsWithPhone, refusalFor } from "../../identity/PasskeyRefusal"
import { GateStep, PhoneSteps } from "../../identity/PhoneSteps"
import { currentDevicePosture, currentOpenInBrowserHref } from "@obsidion/passkey-web"
import { InAppBrowserNotice } from "../../identity/InAppBrowserNotice"
import { walletInAppUpFront } from "../../identity/inAppUpFront"
import { enteredIdentity } from "../../../session/account"
import { peekTicketSignup } from "../../paylink/claimStash"
import { tabStash } from "../../../platform/storage/tabStash"
import { OperationHandOff } from "../../operations/OperationHandOff"
import { isTicketSignupCreating } from "../../paylink/ticketSignupAccount"
import {
  boundTicketSignup,
  claimPublishesAddress,
  ticketHoldNotice,
} from "../../paylink/ticketContinuation"
import type { PaylinkKit } from "../../paylink/usePaylinkDeps"
import { paylinkSignupQuote } from "../../paylink/paylinkSignupQuote"
import { useActiveWithdrawalFee } from "../../withdraw/withdrawalFee"
import { useRegistrationSpeed } from "../../paylink/registrationProverTip"
import { SpeedRow } from "../../withdraw/speedChoice"
import { belowTicketThresholdCopy, ticketEligibility } from "../../paylink/ticketThreshold"
import type { SignupStage } from "../oxideOnboarding"
import { registrationAddressPublished } from "../../registration/webRegistration"
import { ActivationDraft } from "../ActivationHome/ActivationHome"
import { OwnTagSheet } from "../OwnTagSheet/OwnTagSheet"
import { useRegistrationStage } from "../../registration/openRegistration"
import { InvitationChrome } from "../InvitationChrome"
import { CreateWalletStep } from "../steps/CreateWalletStep/CreateWalletStep"
import { LostRegistrationNoticeCard } from "../LostRegistrationNoticeCard/LostRegistrationNoticeCard"
import { ConnectPendingNotice } from "../../contacts/ConnectPendingNotice"
import { OnboardingSpinnerBody } from "../OnboardingCard"
import {
  claimErrorMessage,
  enterErrorMessage,
  passkeyErrorMessage,
  REGISTRATIONS_PAUSED_NOTICE,
} from "../onboardingErrorCopy"
import { passkeysSupported, UNSUPPORTED_BROWSER_MESSAGE } from "@obsidion/passkey-web"
import { formatTokenAmount, swapAssetsLabel } from "../../deposit/DepositTermsRows/DepositTermsRows"
import { formatDepositDue, formatDepositSeen } from "../../registration/depositAmounts"
import { RegistrationSheet, type RegistrationCheck } from "../RegistrationSheet/RegistrationSheet"
import { useRegistrationRefunded } from "../../registration/registrationRecovery"
import { RegistrationRefundAction } from "../RegistrationRefundAction/RegistrationRefundAction"
import { ManualSweepAction } from "../RegistrationDepositDetailModal/RegistrationDepositDetailModal"
import { useSipaProcessing } from "../../deposit/sipaProcessing"
import { useDepositTokens } from "../../sipa/loadDepositFacts"
import { heldDepositLine } from "../../deposit/processingCopy"
import { canManualRegistrationSweep } from "@obsidion/front-core"
import { InvitationStep, type InviteNotice } from "../steps/InvitationStep/InvitationStep"
import { ClaimTagModal } from "../steps/ClaimTagModal"
import { ChooseTagStep } from "../steps/ChooseTagStep/ChooseTagStep"
import { TicketPaymentCard, ticketClaimLabel } from "../steps/GoldenTicketHead"
import { PaylinkSignupRows } from "../steps/PaylinkSignupRows/PaylinkSignupRows"
import { WelcomeStep } from "../steps/WelcomeStep"
import { useDepositWatch } from "../../sipa/useDepositWatch"
import {
  depositChainLabel,
  PAYLINK_TICKET_PAUSED_MESSAGE,
  PAYLINK_TICKET_REFUSED_MESSAGE,
  askedTotal,
  claimTerms,
  quotedRegistrationKind,
  registrationQuote,
  reservedUntil,
  scheduleForRecord,
  signedSchedule,
  signedWithoutSchedule,
  termsUnpriced,
  useRegistrationTerms,
} from "../../registration/registrationTerms"
import { useRegistrationPricing } from "../../registration/registrationPricing"
import { pendingEntry } from "../../registration/registrationTasks"
import { useSession } from "../../../session/session"
import { fmt } from "../../../lib/fmt"
import copy from "./OnboardingScreen.copy"
import styles from "./OnboardingScreen.module.css"
import { retryChoiceFor } from "./createFailure"
import { openSignupFlow, type SignupInputs } from "./signupFlow"
import type { InviteNote } from "./signupTransition"
import { useScreenFlow } from "../../../ui/useScreenFlow"

// Age past which a funded-but-unconfirmed claim warrants the retry lead and the urgency copy.
// Presentation only; the machine guards the claim budget. A record still waiting for its deposit
// is never "stuck": the user has to send it.
const PENDING_URGENCY_MS = 5 * 60_000
/** What a paylink signup's claim is doing after the passkey, from the stage it last reached. */
function paylinkSignupLabel(stage: SignupStage | undefined, tag: string): string {
  switch (stage) {
    case "ticket_prove":
      return copy.paylinkStage.ticket
    case "reserve":
      return fmt(copy.paylinkStage.reserve, { tag })
    case "derive":
    case "broadcast":
      return fmt(copy.paylinkStage.setup, { tag })
    default:
      return copy.paylinkStage.checking
  }
}

/** The invitation's notice, in words. */
function inviteNoticeOf(note: InviteNote | undefined): InviteNotice | undefined {
  if (note?.kind === "unverified") {
    const { error } = note
    const message = error instanceof Error ? errorMessage(error) : undefined
    const detail = message ? fmt(copy.handleUnverifiedDetail, { message }) : ""
    return { kind: "error", message: fmt(copy.handleUnverified, { detail }) }
  }
  if (note?.kind === "refused") return { kind: "error", message: claimErrorMessage(note.error) }
  if (note?.kind === "drawFailed") return { kind: "error", message: copy.drawFailed }
  return note?.kind === "failed" ? { kind: "error", message: copy.claimFailed } : note
}

const NOTE_TEXT = {
  mismatch: copy.passkeyMismatch,
  notOffered: copy.passkeyNotOffered,
  ticketPaused: PAYLINK_TICKET_PAUSED_MESSAGE,
  ticketRefused: PAYLINK_TICKET_REFUSED_MESSAGE,
}

/**
 * The ticket signup's own creation sheet, which asks the browser both questions the gate asks again
 * before the ceremony. Mounted only while shown, so every showing waits for its own answers and
 * never offers what an earlier one said.
 */
function TicketSheet(
  props: Omit<Parameters<typeof PhoneSteps>[0], "reach" | "creation" | "loading">,
) {
  const { auth } = useSession()
  const probed = useStore(useScreenFlow(undefined, () => openCreationProbe(auth)).answers)
  return (
    <PhoneSteps
      {...props}
      reach={probed?.reach ?? "unknown"}
      creation={probed?.creation}
      loading={!probed}
    />
  )
}

/**
 * Signup wizard (/claim/:handle?): the invitation page with the signup steps as sheets over it.
 * The passkey comes first, then the claim on the same spinner, then Home. An open record shows
 * the pending step, which the flow leaves once the record moves.
 */
export interface OnboardingScreenProps {
  embedded?: boolean
  /** Hosted by Home before any account: the drawn tag waits there, and the passkey follows it. */
  draftTag?: string
  /** Hosted by the visitor page as the link's own signup: the stashed ticket is this one's. */
  ticketSignup?: boolean
  /** Landing-layout content above the invitation step (the /link paylink summary). */
  inviteHeader?: ReactNode
  /** Where closing the first step of a ticket-funded signup goes: back to the host's page. */
  onExit?: () => void
  /** The paylink services a ticket-funded signup claims its link with (`PaylinkOnboardingScreen`). */
  paylinkKit?: PaylinkKit
}
export function OnboardingScreen({
  embedded = false,
  draftTag,
  ticketSignup = false,
  inviteHeader,
  onExit,
  paylinkKit,
}: OnboardingScreenProps) {
  // `/claim/:handle` is the only tag source that skips the invitation step's own check. Folded
  // because registration hashes a tag as typed while every resolver folds first, then dropped if it
  // still cannot be claimed, so the wizard falls back to asking for one.
  const { handle: routeParam } = useParams()
  const registrationTokens = useDepositTokens("registration")
  const routeHandle = (routeParam === undefined ? null : normalizeTag(routeParam)) ?? undefined
  const { pathname, state: location } = useLocation()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const next = useNextRoute()
  const rendered = useSession()
  const { config } = rendered.page
  const { pastUser, device } = rendered
  const { gate, state: gateState, cancel: cancelGate, dismiss: dismissGate } = useCeremonyGate()
  // The paylink's hooks below fill in the ticket signup's hold and speed.
  const inputs: SignupInputs = {
    navigate,
    gate: { gate, cancel: cancelGate, dismiss: dismissGate },
    ticketHeld: false,
    embedded,
    draftTag,
    ticketSignup,
    paylinkKit,
    routeHandle,
    pathname,
    params,
    next,
    boundGrantOwner: (location as { boundGrantOwner?: string } | null)?.boundGrantOwner,
  }
  const flow = useScreenFlow(inputs, (latest) =>
    openSignupFlow({ session: rendered, mock: rendered.onboardingMock?.() }, latest),
  )
  const { fromPaylink, freshStart, mock, resuming } = flow
  const s = useStore(flow.state)
  const { step, handle } = s
  const busy = s.busy > 0
  const tagField = useStore(flow.tagField)
  const boundGrant = (tag: string) =>
    flow.enterGo(`/enter?handle=${encodeURIComponent(tag)}&bound=1`)
  const pastUserVerified = useStore(pastUser.state, (p) => p.verified)
  const verifying = useStore(pastUser.state, (p) => p.open)
  // Embedded, the pill is in the host page's frame, out of reach of a prop.
  useHoldEndpoints(s.inviteBusy)
  useStore(rendered.registrations.view)
  const identityView = useStore(rendered.identity)
  const { passkeyMap } = useStore(device)
  const record = flow.record()
  const { wallClock } = useSession().page
  const nowMs = useStore(wallClock)
  const { ticketAttempt } = s
  const resumingTicket = ticketAttempt !== null && !isTicketSignupCreating(ticketAttempt)
  // An app's built-in browser is told before the first prompt, and no passkey action starts there.
  const inAppMode = walletInAppUpFront(device.get(), config.rpId)
  const inAppHold = inAppMode !== undefined
  const inviteNotice = inviteNoticeOf(s.inviteNote)
  const modalError =
    s.modalError &&
    (s.modalError.kind === "claim"
      ? claimErrorMessage(s.modalError.error, { tag: handle })
      : s.modalError.kind === "enter"
      ? enterErrorMessage(s.modalError.error)
      : passkeyErrorMessage(s.modalError.error))
  const inlineNotice =
    s.note &&
    (s.note.kind === "ticketHold"
      ? ticketHoldNotice(s.note.state, s.note.tag)
      : NOTE_TEXT[s.note.kind])
  const closeBusySheet = () => flow.closeBusySheet(gateState.kind !== "idle")

  // The whole pending surface pins the record's tag; the typed/route handle is only a fallback.
  const pendingTag = record?.tag ?? handle
  /**
   * This browser has completed onboarding — for this name or any other — so the wallet is already
   * theirs to open: the sheet reports what the name still owes, it does not hold anyone. Closing it
   * must never land on the invitation, which is the signup for someone with no account: that is the
   * loop where a passkey is touched, the sheet appears, and closing it returns to /claim.
   */
  const alreadyEntered = enteredIdentity(identityView, passkeyMap, config.rpId) !== null
  const stage = useRegistrationStage(record)
  // A capacity blocker on the address outranks "being processed", in the words its stated reason uses.
  const { shown: sweepHold } = useSipaProcessing(record?.sipaAddress)
  const sweepBlocker = sweepHold?.blocker
  // The deadline and signed schedule outlive the in-memory claim through the persisted terms, so a
  // reload still shows them. A fresh claim outranks the stored copy of one.
  const terms = useRegistrationTerms(record?.account, record?.tag)
  const recordState = pendingRecordState(record, stage, terms)
  const { openPending, custodyHeld, awaitingDeposit, linkBurnOut } = recordState
  const depositAdmitted = useDepositAdmission(record)
  const refunded = useRegistrationRefunded(record)
  // What this address replaced, off its own record: a refunded predecessor, and whether one took
  // the account's one-shot broadcast, in which case only a manual sweep finishes this one.
  const refundedFrom = record?.replaced?.refunded ? record.replaced.sipaAddress : undefined
  const broadcastSpent = record?.replaced?.broadcastSpent === true
  // A ticket-funded claim waiting on this tab: the link pays for the registration. The hosted
  // wizard owns the marker outright; a pending reservation only the link its terms name.
  const ticketStash = fromPaylink ? peekTicketSignup(tabStash) : boundTicketSignup(terms)
  const paylinkStashed = ticketStash !== null
  const pendingUrgent =
    openPending &&
    record !== null &&
    (custodyHeld || (!record.broadcast && !paylinkStashed)) &&
    nowMs - record.startTime > PENDING_URGENCY_MS
  const readChain = (step === "terms" || step === "pending") && !mock
  // The chain read is only worth making where the controller's immutables would price this
  // registration; elsewhere the prompt quotes the ask alone.
  const readChainSchedule = readChain && signedWithoutSchedule(terms)
  // A ticket's tag step prices the split, so its fee is read before the terms.
  const pricing = useRegistrationPricing(readChain || paylinkStashed, readChainSchedule)
  const relayerFee = mock ? mock.fee : pricing.sweepFee
  // The Check status pill also reads a failed price again.
  const checkStatus = () => {
    pricing.retry()
    void flow.checkPendingStatus()
  }
  const expectedEarned = flow.expectedEarned()
  const signedTerms = s.freshClaim?.terms ?? terms
  // The signed quote is the waiver's authority: the live claim, else the copy stored at claim time.
  // A reload has neither, and "no quote" must never read as "you pay": the stored expectation stands.
  // A stored record without a signed schedule (an expectation) is not a quote either.
  const signedWaiver =
    s.freshClaim?.terms !== undefined
      ? s.freshClaim.terms.reduced === true
      : terms?.fee !== undefined
      ? terms.feeWaived === true
      : undefined
  // An unpriced quote cannot waive a fee it never priced.
  const feeWaived = !termsUnpriced(signedTerms) && (signedWaiver ?? expectedEarned)
  // A stamped record carries deadline 0: no deadline known, which is not a lapsed one.
  const claimDeadline = s.freshClaim
    ? claimTerms(s.freshClaim).deadline
    : terms?.deadline || undefined
  const chainAmounts = pricing.schedule
  const quoteLive = terms?.deadline === undefined || terms.deadline * 1000 > nowMs
  const claimQuote = s.freshClaim?.terms && signedSchedule(s.freshClaim.terms)
  const committedFee = record?.fee !== undefined ? BigInt(record.fee) : undefined
  const amounts = mock
    ? { min: mock.min, fee: mock.fee }
    : claimQuote ??
      scheduleForRecord(
        quoteLive ? terms : undefined,
        readChainSchedule ? chainAmounts ?? undefined : undefined,
        committedFee,
      )
  // No schedule prices this registration and none is on its way: no read is outstanding, so nothing
  // will replace a placeholder. The rows it prices are dropped rather than held open on one.
  const scheduleUnavailable =
    !mock && amounts === undefined && !(readChainSchedule && chainAmounts === undefined)
  const registrationsPaused = readChainSchedule && chainAmounts === null
  // The ticket signup's split: the signed schedule, else the one the service advertised before
  // the ticket was spent. `covers` is the real check once the witness read the note.
  const ticketSchedule = ticketStash
    ? amounts ?? {
        fee: BigInt(ticketStash.schedule.fee),
        min: BigInt(ticketStash.schedule.minDeposit),
      }
    : undefined
  const ticketWithdrawalFee = useActiveWithdrawalFee(!mock && ticketStash !== null)
  const ticketSpeed = useRegistrationSpeed({
    active: !mock && ticketStash !== null,
    noteAmount: ticketStash?.amount !== undefined ? BigInt(ticketStash.amount) : undefined,
    schedule: ticketSchedule,
    withdrawalFee: ticketWithdrawalFee,
    initialSpeed: ticketStash?.speed ?? terms?.speed,
  })
  inputs.ticketSpeed = ticketSpeed
  // Before the passkey the split is Standard's until the tip quote answers: the quote refines it,
  // and a passkey started before then commits Standard (`settle`). The review claims at the tip it
  // committed, so it waits for the quote.
  const ticketBeforePasskey =
    fromPaylink && (step === "tag" || step === "terms" || step === "create")
  const ticketProverTip = mock
    ? 0n
    : ticketSpeed.proverTip ?? (ticketBeforePasskey ? 0n : undefined)
  const ticketFee = mock ? 0n : ticketWithdrawalFee
  const paylinkQuote =
    ticketStash && ticketSchedule && ticketProverTip !== undefined && ticketFee !== undefined
      ? paylinkSignupQuote({
          ...(ticketStash.amount !== undefined ? { paylink: BigInt(ticketStash.amount) } : {}),
          schedule: ticketSchedule,
          sweepFee: relayerFee,
          proverTip: ticketProverTip,
          withdrawalFee: ticketFee,
          ticket: !ticketStash.paid,
        })
      : undefined
  const chainLabel = depositChainLabel(config)
  const earnedAskLabel = formatDepositDue(
    askedTotal("earned_tag"),
    tokenDecimalsForNetwork(config.network),
  )
  // The deposit shows as received the moment it lands. A funded record is watched too, while
  // unswept: its refund action reads what the address holds now.
  const watchedDeposit = useDepositWatch(
    openPending && !mock && record && canManualRegistrationSweep(record)
      ? (record.sipaAddress as Address)
      : null,
  )
  // The preview seeds what the address holds, so its panel, celebration and title agree.
  const depositSeen = mock ? mock.received ?? 0n : watchedDeposit.balance
  const shown = useDepositShown(record)
  const {
    ticketBlocked,
    depositSeenAny,
    needsRefund,
    quoteExpired,
    quoteMismatch,
    replaceUnfunded,
    paylinkPending,
    settles,
  } = selectPendingEntry({
    record,
    terms,
    stage,
    paylinkStashed,
    depositAdmitted,
    refunded,
    depositSeen,
    shown,
    sweepFee: relayerFee,
    expectedEarned,
    feeWaived,
    signedQuote: claimQuote ?? signedSchedule(terms),
    claimDeadline,
    registrationsPaused,
    earnedAsk: askedTotal("earned_tag"),
    nowMs,
  })
  // `quoteMismatch` below is what tells the user when a waived tag ends up quoted as standard.
  const quotedKind = quotedRegistrationKind(feeWaived, amounts)
  const pendingQuote = registrationQuote(amounts, quotedKind)
  // Celebration is reserved for a deposit the chain would accept; a shorter one keeps the panel,
  // which prices the top-up to the asked figure. An unread floor is no verdict, so the panel holds.
  const depositReceived =
    depositSeenAny && pendingQuote.floor !== undefined && depositSeen >= pendingQuote.floor
  // The pending step's own claim, not a status check sharing the busy flag.
  const paylinkClaiming = busy && (s.busyStage === "passkey" || s.busyStage === "claiming")
  const pendingTitle = (() => {
    if (needsRefund) return fmt(copy.pendingTitle.recover, { tag: pendingTag })
    if (depositAdmitted) return fmt(copy.pendingTitle.received, { tag: pendingTag })
    if (custodyHeld || depositReceived) return fmt(copy.pendingTitle.received, { tag: pendingTag })
    if (quoteExpired) return fmt(copy.pendingTitle.refresh, { tag: pendingTag })
    // A waived tag is being activated, not bought; a paid one is buying its way off the waitlist.
    // A paylink-funded reservation is claimed, not bought with an L1 send.
    if (awaitingDeposit) {
      return paylinkStashed || feeWaived ? copy.activate : copy.instantAccess
    }
    return fmt(copy.pendingTitle.claiming, { tag: pendingTag })
  })()
  const pendingBody = (() => {
    const tag = { tag: pendingTag }
    if (needsRefund) {
      return refunded
        ? copy.pendingBody.refunded
        : depositAdmitted
        ? copy.pendingBody.refundAdmitted
        : copy.pendingBody.refund
    }
    if (depositAdmitted) return copy.pendingBody.admitted
    if (pendingUrgent) return fmt(copy.pendingBody.urgent, tag)
    if (custodyHeld || depositReceived) return copy.pendingBody.received
    if (replaceUnfunded) return copy.pendingBody.replaceUnfunded
    if (quoteMismatch) return copy.pendingBody.quoteMismatch
    if (quoteExpired) return fmt(copy.pendingBody.expired, tag)
    if (registrationsPaused) return fmt(copy.pendingBody.paused, tag)
    if (linkBurnOut && !paylinkStashed) return fmt(copy.pendingBody.sweeping, tag)
    if (awaitingDeposit && paylinkStashed) return fmt(copy.pendingBody.paylink, tag)
    if (awaitingDeposit) return fmt(copy.pendingBody.awaiting, tag)
    return copy.pendingBody.confirming
  })()
  // A claim the background driver cannot finish on its own: never published, escalated, or aged
  // past the point where waiting is the answer.
  const retryWarranted =
    openPending &&
    record !== null &&
    !quoteExpired &&
    !needsRefund &&
    !replaceUnfunded &&
    !broadcastSpent &&
    // A ticket's address is published by its claim, never by a retry.
    ((!record.broadcast && !paylinkStashed) ||
      isRegistrationEscalated(record, nowMs) ||
      pendingUrgent)
  const retryButton = (className: string) =>
    retryWarranted && !s.pendingRefusal ? (
      <button
        type="button"
        className={`zkm-btn-reset zkm-pressable ${className}`}
        onClick={flow.retryClaim}
        disabled={busy}
      >
        {busy && s.busyStage ? copy.busy[s.busyStage] : copy.retry}
      </button>
    ) : undefined
  const checkNote = (() => {
    if (record === null) return undefined
    const minutes =
      s.checkedAt === undefined ? undefined : Math.floor((nowMs - s.checkedAt) / 60_000)
    return (
      <>
        {!busy &&
          minutes !== undefined &&
          fmt(copy.checked, {
            when: minutes < 1 ? copy.justNow : fmt(copy.minutesAgo, { minutes }),
          })}
        <button
          type="button"
          className="zkm-btn-reset ww-send-to__link"
          aria-label={copy.checkAgain}
          onClick={checkStatus}
          disabled={busy}
        >
          {busy ? copy.checking : copy.checkAgain}
        </button>
        {retryButton("ww-send-to__link")}
      </>
    )
  })()
  // The sheet's pill: the step's forced tick, and the watcher's read for the balance line.
  const check: RegistrationCheck | undefined =
    record === null
      ? undefined
      : {
          lastCheckedAt: s.checkedAt,
          busy: busy || s.reading,
          onCheck: () => {
            checkStatus()
            flow.reading(true)
            void watchedDeposit.read().finally(() => flow.reading(false))
          },
          action: retryButton("ww-deposit-sheet__check"),
        }
  // Once reserved, the deposit gate is dismissible only with a waiver.
  // Before the ceremony starts, anyone can return to the invitation and choose another tag.
  const gateDismissible = expectedEarned || feeWaived || Boolean(mock?.free)
  // The terms frame quotes the stored expectation; the claim after the passkey is what decides.
  const termsFree = expectedEarned || Boolean(mock?.free)
  const termsBusy = step === "create" && s.modalBusy
  // Cancel hides a spinner without aborting its request; only the initial terms gain a new exit.
  const termsDismissible = !termsBusy && (step === "terms" || gateDismissible)
  // `termsFree` steers copy only; the kind the total is quoted at comes from the signature.
  const termsKind = quotedKind
  const termsQuote = registrationQuote(amounts, termsKind)
  const termsTotalLabel = formatDepositDue(
    termsQuote.total,
    tokenDecimalsForNetwork(config.network),
  )
  const { modalRefusal } = s
  const refusalRow = modalRefusal && refusalFor(modalRefusal)
  const inAppRefusal = !!refusalRow?.openInBrowser
  // The in-app card with no retry: nothing more can be created in this browser.
  const inAppDeadEnd = inAppRefusal && !refusalRow?.retry
  // The card's way out comes first: Open in browser or the app's own menu while this device has a
  // browser to go to, or the phone where the card leads with it.
  const ctaStyle =
    (inAppRefusal && currentOpenInBrowserHref(window.location.href)) ||
    (step === "create" && modalRefusal && leadsWithPhone(modalRefusal))
      ? "dark"
      : "gradient"
  // The card takes the idle sheet. A running attempt keeps its spinner.
  const inAppWait = inAppHold && s.modalBusy
  const inAppCard = inAppHold && !s.modalBusy && !(step === "create" && modalRefusal)
  // The sheet's button stays beside a refusal card only where it is not a second retry: the in-app
  // card borrows it as its retry, and a payment-link signup starts another passkey with it.
  const refusalKeepsActions = !!refusalRow?.retry && (inAppRefusal || fromPaylink)

  // The ceremony's own surface, shared by the terms sheet and the ticket signup's welcome step:
  // refusals and errors above, then the CTA or whatever the ceremony shows in its place.
  const termsNotices = (
    <>
      {inAppMode && inAppCard && (
        <InAppBrowserNotice
          mode={inAppMode}
          reportContext="onboarding"
          testId="create-in-app-notice"
          exits={
            termsDismissible && (
              <button
                type="button"
                className="zkm-btn-reset zkm-pressable ww-invite-pill"
                data-testid="create-in-app-back"
                onClick={flow.closeToInvite}
              >
                {copy.back}
              </button>
            )
          }
        />
      )}
      {step === "terms" && registrationsPaused && (
        <p className={styles.feedback} data-testid="registrations-paused">
          {REGISTRATIONS_PAUSED_NOTICE}
        </p>
      )}
      {fromPaylink &&
        isTicketSignupCreating(ticketAttempt) &&
        !termsBusy &&
        !inAppDeadEnd &&
        !inAppCard && (
          <p className="ww-invite-modal-error" role="alert">
            {copy.unsavedSignup}
          </p>
        )}
      {step === "create" && <IosFloorNotice />}
      {step === "create" && modalRefusal && (
        <PasskeyRefusal
          error={modalRefusal}
          // The sheet's own button is the in-app card's retry: it also restarts an interrupted
          // payment-link signup.
          onRetry={inAppRefusal ? undefined : () => flow.backToSheet(retryChoiceFor(modalRefusal))}
          onPhone={() => flow.backToSheet("phone")}
          busy={s.modalBusy}
          reportContext="onboarding"
          testId="create-refused"
          retryTestId="create-retry"
          exits={
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-invite-pill"
              data-testid="create-start-over"
              onClick={flow.logOut}
            >
              {copy.startOver}
            </button>
          }
        />
      )}
      {step === "create" && modalError && (
        <p className="ww-invite-modal-error" role="alert">
          {modalError}
        </p>
      )}
      {!passkeysSupported() && (
        <p className="ww-invite-modal-error" role="alert">
          <Icon name="alert-triangle" size={14} color="var(--accent-pink)" />{" "}
          {UNSUPPORTED_BROWSER_MESSAGE}
        </p>
      )}
    </>
  )
  const gateHeld = termsBusy && gateState.kind === "awaiting-action"
  // A fresh ticket signup on a laptop is the creation sheet itself, shown once: what comes next, the
  // split, the phone and the key. A phone's own passkey needs no route, so its card keeps the CTA.
  const ticketSheet =
    fromPaylink &&
    !!ticketStash &&
    !resumingTicket &&
    !isTicketSignupCreating(ticketAttempt) &&
    currentDevicePosture() === "laptop"
  // What the payment link's signup keeps and what the account costs, before the passkey is made:
  // the claim on Home commits to this split with no review of its own, so the signup waits for
  // the split to be priced and refuses a payment that cannot cover the account.
  const ticketUnpriced =
    fromPaylink &&
    !!ticketStash &&
    (paylinkQuote === undefined || paylinkQuote.tagWaived === undefined)
  // A paid link too small for the name goes on to an ordinary deposit, and Home claims it as any
  // other payment: only a ticket signup is held for it.
  const linkShort = fromPaylink && !!ticketStash && paylinkQuote?.covers === false
  const ticketUncovered = linkShort && !ticketStash?.paid
  // The sweep fee prices the split; while it is unread the hold says so.
  const ticketFeeUnread = fromPaylink && !!ticketStash && relayerFee === undefined
  // A new passkey spends the ticket next, so it needs the note at or above the threshold. A bound
  // account resumes what it committed; its redeem checks the live threshold before spending.
  const ticketThreshold =
    fromPaylink && ticketStash && !resumingTicket
      ? ticketStash.paid
        ? undefined
        : ticketEligibility(ticketStash.amount, ticketStash.threshold)
      : undefined
  const ticketHeld =
    ticketUnpriced ||
    ticketUncovered ||
    (ticketThreshold !== undefined && ticketThreshold !== "eligible")
  inputs.ticketHeld = ticketHeld
  const ticketAmount = ticketStash?.amount === undefined ? undefined : BigInt(ticketStash.amount)
  const ticketRows =
    fromPaylink && ticketStash ? (
      <>
        <PaylinkSignupRows
          quote={paylinkQuote}
          tokenSymbol={WALLET_TOKEN_SYMBOL}
          tokenDecimals={tokenDecimalsForNetwork(config.network)}
          speed={
            mock ? undefined : (
              <SpeedRow choice={ticketSpeed.choice} outcome={ticketSpeed.outcome} />
            )
          }
        />
        {ticketThreshold === "below_threshold" && ticketStash.threshold && (
          <p className="ww-invite-modal-error" role="alert">
            {belowTicketThresholdCopy(
              formatTokenAmount(
                BigInt(ticketStash.threshold),
                tokenDecimalsForNetwork(config.network),
                WALLET_TOKEN_SYMBOL,
              ),
            )}
          </p>
        )}
        {ticketThreshold === "unknown" && (
          <p className="ww-invite-modal-error" role="alert">
            {copy.ticket.amountUnread}
          </p>
        )}
        {ticketUncovered && (
          <p className="ww-invite-modal-error" role="alert">
            {copy.ticket.uncovered}
          </p>
        )}
        {linkShort && !ticketUncovered && (
          <p className="ww-reg-sheet__note">{copy.ticket.nameUncovered}</p>
        )}
        {ticketFeeUnread && !pricing.failed && (
          <p className="ww-invite__checking">{copy.ticket.feeChecking}</p>
        )}
        {ticketFeeUnread && pricing.failed && (
          <p className="ww-invite-modal-error" role="alert">
            {copy.ticket.feeUnread}{" "}
            <button type="button" className="zkm-btn-reset ww-invite__link" onClick={pricing.retry}>
              {copy.ticket.tryAgain}
            </button>
          </p>
        )}
      </>
    ) : undefined
  const ticketSplit = ticketRows && (
    <>
      {ticketAmount !== undefined && (
        <TicketPaymentCard
          amount={ticketAmount}
          tokenDecimals={tokenDecimalsForNetwork(config.network)}
          tokenSymbol={WALLET_TOKEN_SYMBOL}
          senderTag={ticketStash?.senderTag}
        />
      )}
      {ticketRows}
    </>
  )
  const busyLabel =
    s.busyPhase === "claim"
      ? fromPaylink
        ? paylinkSignupLabel(s.signupStage, handle)
        : copy.busyLabel.preparing
      : resumingTicket
      ? copy.busyLabel.confirming
      : gateState.kind === "probing"
      ? copy.busyLabel.probing
      : copy.busyLabel.creating
  // A drawn tag's passkey sheet stays up, its button spinning, until Home opens on the account.
  const draftBusy = !!draftTag && termsBusy && gateState.kind !== "awaiting-action"
  // Only while the passkey creation itself runs: not the browser check, a ticket's sign-in or
  // the claim work after the passkey exists.
  const runningWarning =
    s.busyPhase === "passkey" && gateState.kind === "idle" && !resumingTicket
      ? s.creationWarning
      : undefined
  // Cancel closes the sheet; a link's signup keeps its own way back.
  const termsActions =
    termsBusy && gateState.kind === "awaiting-action" ? (
      <GateStep state={gateState} details={ticketSplit} tag={handle} onPick={flow.warn} />
    ) : draftBusy ? (
      <PhoneSteps
        reach="unknown"
        busy={busyLabel}
        warning={runningWarning}
        tag={handle}
        onChoose={() => {}}
      />
    ) : termsBusy || inAppWait ? (
      <OnboardingSpinnerBody label={busyLabel} warning={runningWarning} />
    ) : (refusalRow && !refusalKeepsActions) || inAppCard ? null : ticketSheet ? (
      // A refusal or the in-app card leaves only what the card itself offers.
      <TicketSheet
        details={ticketSplit}
        tag={handle}
        disabled={!passkeysSupported() || ticketHeld}
        onChoose={flow.chooseOnSheet}
      />
    ) : (
      <div className={fromPaylink ? "ww-deposit-actions ww-sheet__actions" : "ww-deposit-actions"}>
        <PrimaryGradientButton
          title={
            fromPaylink
              ? isTicketSignupCreating(ticketAttempt)
                ? copy.cta.anotherPasskey
                : resumingTicket
                ? copy.cta.continuePasskey
                : ticketClaimLabel(
                    handle,
                    ticketAmount,
                    tokenDecimalsForNetwork(config.network),
                    WALLET_TOKEN_SYMBOL,
                  ) ?? copy.cta.createAccount
              : fmt(copy.cta.deposit, { total: termsTotalLabel })
          }
          buttonStyle={ctaStyle}
          isDisabled={!passkeysSupported() || ticketHeld}
          onClick={flow.continueSignup}
        />
        {termsFree && !fromPaylink && (
          <button
            type="button"
            className="zkm-btn-reset ww-deposit-actions__link"
            onClick={() => flow.leaveTerms(false)}
            disabled={!passkeysSupported()}
          >
            {copy.later}
          </button>
        )}
      </div>
    )

  // One "scan this code" at a time: the deposit address steps aside for the phone steps. A stashed
  // paylink funds the SIPA — never offer an L1 send beside it.
  // The address shows where the `registrationEntry` task owes its broadcast.
  const entrySettles = mock
    ? settles
    : record !== null && pendingEntry(rendered, record, nowMs, claimPublishesAddress).settles
  const pendingAddressShown =
    step === "pending" && entrySettles && gateState.kind !== "awaiting-action"

  // The terms and passkey sheet close like their X: outside, Escape, or the X itself.
  const sheetClose =
    fromPaylink || (step !== "terms" && step !== "create")
      ? undefined
      : termsDismissible
      ? flow.closeToInvite
      : termsBusy
      ? closeBusySheet
      : undefined
  const modals = step !== "invite" && (
    <ModalFrame label={copy.sheetLabel} onClose={sheetClose}>
      {/* One frame from the terms through the ceremony + claim: the same sheet the address
          lands in, so nothing swaps out under the user mid-registration. */}
      {(step === "terms" || step === "create") &&
        (fromPaylink ? (
          <WelcomeStep
            tag={handle}
            resuming={resumingTicket}
            gated={gateHeld || (ticketSheet && !termsBusy) || inAppCard}
            busy={termsBusy && !gateHeld}
            split={ticketSplit}
            onClose={termsDismissible ? flow.closeToInvite : undefined}
            notices={termsNotices}
            actions={termsActions}
          />
        ) : (
          <RegistrationSheet
            tag={handle}
            // The passkey prompt carries its own heading.
            title={
              (termsBusy && gateState.kind === "awaiting-action") || draftBusy
                ? undefined
                : draftTag
                ? copy.draftTitle
                : termsFree
                ? copy.activate
                : copy.instantAccess
            }
            onClose={termsDismissible ? flow.closeToInvite : termsBusy ? closeBusySheet : undefined}
            onBack={draftTag && termsDismissible ? flow.backFromTerms : undefined}
            // One thing at a time, as on the pending step: the terms stand aside while the passkey
            // runs, and come back under the deposit address the claim returns.
            payment={
              step === "create" || registrationsPaused || inAppCard
                ? undefined
                : {
                    chainLabel,
                    total: termsQuote.total,
                    fee: termsQuote.fee,
                    sweepFee: relayerFee,
                    floor: termsQuote.floor,
                    scheduleUnavailable,
                    kind: termsKind,
                    tokenSymbol: mock?.tokenSymbol ?? WALLET_TOKEN_SYMBOL,
                    swapAssets: swapAssetsLabel(registrationTokens),
                    tokenDecimals: tokenDecimalsForNetwork(config.network),
                  }
            }
            notices={termsNotices}
            actions={termsActions}
          />
        ))}
      {step === "tag" && (
        <ChooseTagStep
          ticket={{
            amount: ticketAmount,
            tokenDecimals: tokenDecimalsForNetwork(config.network),
            tokenSymbol: WALLET_TOKEN_SYMBOL,
            senderTag: ticketStash?.senderTag,
            paid: ticketStash?.paid,
          }}
          tagField={tagField}
          onType={flow.typeTag}
          busy={s.inviteBusy}
          notice={inviteNotice}
          resuming={resuming || flow.leftoverTag !== undefined}
          boundGrantOwner={flow.boundGrantOwner()}
          onBoundGrant={boundGrant}
          split={ticketRows}
          held={ticketHeld}
          onClaim={(h) => void flow.unlockAccess(h)}
          onLogIn={flow.logIn}
          onCancel={flow.cancelUnlock}
          onClose={() => onExit?.()}
        />
      )}
      {step === "claim" && (
        <ClaimTagModal
          handle={handle}
          busy={s.modalBusy}
          error={modalError}
          onClaim={() => void flow.claimTagStep()}
          onCancel={() => flow.cancelModalOp(gateState.kind !== "idle")}
          onClose={flow.closeToInvite}
        />
      )}
      {step === "pending" && (
        <RegistrationSheet
          tag={pendingTag}
          title={pendingTitle}
          reservedUntil={reservedUntil(s.freshClaim ? claimTerms(s.freshClaim) : terms, nowMs)}
          note={pendingBody}
          onClose={
            depositAdmitted || refundedFrom || alreadyEntered
              ? flow.intoWallet
              : gateDismissible || paylinkStashed
              ? flow.closeToInvite
              : undefined
          }
          payment={
            pendingAddressShown && record
              ? {
                  address: record.sipaAddress as Address,
                  publishing: !registrationAddressPublished(record),
                  token: record.depositToken as Address,
                  chainId: record.l1ChainId,
                  chainLabel,
                  total: pendingQuote.total,
                  fee: pendingQuote.fee,
                  sweepFee: relayerFee,
                  floor: pendingQuote.floor,
                  scheduleUnavailable,
                  kind: quotedKind,
                  tokenSymbol: mock?.tokenSymbol ?? WALLET_TOKEN_SYMBOL,
                  swapAssets: swapAssetsLabel(registrationTokens),
                  tokenDecimals: tokenDecimalsForNetwork(config.network),
                  received: depositSeenAny ? depositSeen : undefined,
                  receivedToken: !depositSeenAny
                    ? undefined
                    : mock
                    ? registrationTokens?.options.find((t) => t.symbol === mock.tokenSymbol)
                        ?.address ?? (record.depositToken as Address)
                    : watchedDeposit.token,
                  funded: custodyHeld,
                  check,
                }
              : undefined
          }
          settlement={
            paylinkPending && !ticketBlocked
              ? {
                  quote: paylinkQuote,
                  tokenSymbol: WALLET_TOKEN_SYMBOL,
                  tokenDecimals: tokenDecimalsForNetwork(config.network),
                  speed: mock ? undefined : (
                    <SpeedRow choice={ticketSpeed.choice} outcome={ticketSpeed.outcome} />
                  ),
                }
              : undefined
          }
          notices={
            <>
              {registrationsPaused && (
                <>
                  <p className={styles.feedback} data-testid="registrations-paused">
                    {REGISTRATIONS_PAUSED_NOTICE}
                  </p>
                  <p className={styles.feedback}>{checkNote}</p>
                </>
              )}
              {gateState.kind === "awaiting-action" && (
                <GateStep state={gateState} onPick={flow.warn} onCancel={flow.cancelPendingGate} />
              )}
              {(quoteMismatch || replaceUnfunded || depositAdmitted || needsRefund) && record && (
                <section aria-label={copy.existing.label}>
                  <p>{copy.existing.address}</p>
                  <code style={{ overflowWrap: "anywhere" }}>{record.sipaAddress}</code>
                  {depositSeenAny && (
                    <p>
                      {copy.existing.detected}{" "}
                      {formatDepositSeen(depositSeen, tokenDecimalsForNetwork(config.network))}
                    </p>
                  )}
                  {custodyHeld && <p>{heldDepositLine(sweepHold) ?? copy.existing.processing}</p>}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8 }}>
                    {checkNote}
                  </div>
                </section>
              )}
              {(needsRefund || replaceUnfunded) && record && (
                <RegistrationRefundAction
                  record={record}
                  unfunded={!needsRefund}
                  holdsFunds={depositSeen > 0n}
                  onRestart={needsRefund ? flow.restartAfterRefund : flow.replaceAtEarnedPrice}
                />
              )}
              {broadcastSpent && record && canManualRegistrationSweep(record) && (
                <section aria-label={copy.earned.label}>
                  <p>
                    {(custodyHeld || depositReceived || depositAdmitted) && sweepBlocker
                      ? sweepBlocker.kind === "capacity"
                        ? copy.earned.capacity
                        : copy.earned.tooLarge
                      : custodyHeld || depositReceived || depositAdmitted
                      ? copy.earned.sweep
                      : fmt(copy.earned.fund, {
                          refunded: refundedFrom ? copy.earned.refundedPrefix : "",
                          ask: earnedAskLabel,
                        })}{" "}
                    {copy.earned.gas}
                  </p>
                  <ManualSweepAction record={record} attempt={flow.sweepAttempt} />
                </section>
              )}
              {paylinkPending && !ticketBlocked && <p className={styles.feedback}>{checkNote}</p>}
              {s.pendingRefusal && (
                <PasskeyRefusal
                  error={s.pendingRefusal}
                  onRetry={() => void flow.retryClaim()}
                  busy={busy}
                  testId="pending-refused"
                  retryTestId="pending-retry"
                  exits={
                    <button
                      type="button"
                      className="zkm-btn-reset zkm-pressable ww-invite-pill"
                      data-testid="pending-log-out"
                      onClick={flow.logOut}
                      disabled={busy}
                    >
                      {copy.logOut}
                    </button>
                  }
                />
              )}
              {inlineNotice && <span className={styles.feedback}>{inlineNotice}</span>}
              {ticketBlocked && s.note?.kind !== "ticketRefused" && (
                <span className={styles.feedback}>{PAYLINK_TICKET_REFUSED_MESSAGE}</span>
              )}
            </>
          }
          actions={
            <div className="ww-deposit-actions">
              {s.entryFailed && (
                <PrimaryGradientButton
                  title={copy.retryEnter}
                  isDisabled={busy}
                  onClick={flow.retryEntry}
                />
              )}
              {openPending && (
                <>
                  {quoteExpired && !replaceUnfunded && (
                    <PrimaryGradientButton
                      title={busy && s.busyStage ? copy.busy[s.busyStage] : copy.refreshAmount}
                      isDisabled={busy}
                      onClick={() => void flow.refreshExpiredQuote()}
                    />
                  )}
                  {paylinkPending &&
                    !ticketBlocked &&
                    paylinkClaiming &&
                    !s.claimLeft &&
                    (s.busyStage === "passkey" ? (
                      <OnboardingSpinnerBody label={copy.busyLabel.confirming} />
                    ) : (
                      <OperationHandOff
                        onLeave={() => void flow.enterPastClaim(pendingTag)}
                        until="sent"
                      />
                    ))}
                  {paylinkPending && !ticketBlocked && !paylinkClaiming && (
                    <PrimaryGradientButton
                      title={copy.claimPayment}
                      isDisabled={
                        busy || paylinkQuote === undefined || paylinkQuote.covers === false
                      }
                      onClick={() => void flow.settlePendingPaylink()}
                    />
                  )}
                  {(depositAdmitted || refundedFrom) && (
                    <PrimaryGradientButton title={copy.backToWallet} onClick={flow.intoWallet} />
                  )}
                  {!paylinkPending &&
                    !quoteExpired &&
                    awaitingDeposit &&
                    feeWaived &&
                    !quoteMismatch &&
                    !depositAdmitted && (
                      <PrimaryGradientButton
                        title={copy.enterLater}
                        isDisabled={busy}
                        onClick={() => void flow.enterDepositLater()}
                      />
                    )}
                </>
              )}
              {/* A paid tag is mid-purchase: leaving strands it. A free or paylink-funded one can walk away. */}
              {(feeWaived || paylinkStashed) && (
                <button
                  type="button"
                  className="zkm-btn-reset ww-deposit-actions__link"
                  onClick={flow.logOut}
                  disabled={busy}
                >
                  {copy.logOut}
                </button>
              )}
            </div>
          }
        />
      )}
    </ModalFrame>
  )

  // The invitation page stays as the backdrop behind every modal step. A ticket-funded signup
  // has no page of its own: the paylink the visitor opened stays behind its modal.
  const invitation = fromPaylink ? null : (
    <>
      {step === "invite" && (
        <>
          <ConnectPendingNotice />
          <LostRegistrationNoticeCard />
        </>
      )}
      {s.pickingName && !verifying && (
        <OwnTagSheet
          free={pastUserVerified !== undefined && pastUserVerified.tag === undefined}
          submitLabel={copy.continue}
          onVerify={() => pastUser.setOpen(true)}
          onClose={() => flow.picking(false)}
          onPick={flow.pickOwnTag}
          onLogIn={flow.logIn}
        />
      )}
      {draftTag ? (
        <ActivationDraft
          drawn={draftTag}
          chosen={s.chosenTag}
          notice={inviteNotice}
          onKeep={flow.keepDrawnTag}
          onChooseOwn={() => flow.picking(true)}
          onCreate={flow.createChosenAccount}
          onReroll={flow.rerollDrawnTag}
          onBack={flow.dropDraft}
        />
      ) : freshStart ? (
        <CreateWalletStep
          busy={s.inviteBusy}
          returning={flow.returning}
          notice={step === "invite" ? inviteNotice : undefined}
          onCreate={() => void flow.createDrawnWallet()}
          onLogIn={flow.logIn}
          onCancel={flow.cancelUnlock}
        />
      ) : (
        <InvitationStep
          tagField={tagField}
          onType={flow.typeTag}
          busy={s.inviteBusy}
          header={inviteHeader}
          notice={step === "invite" ? inviteNotice : undefined}
          resuming={resuming}
          boundGrantOwner={flow.boundGrantOwner()}
          onBoundGrant={boundGrant}
          onUnlock={(h) => void flow.unlockAccess(h)}
          onLogIn={flow.logIn}
          onCancelSignIn={flow.cancelUnlock}
        />
      )}
    </>
  )

  if (embedded) {
    return (
      <>
        {invitation}
        {modals}
      </>
    )
  }
  const landing = freshStart && !draftTag
  return (
    <InvitationChrome bare={landing} landing={landing} page={rendered.page}>
      {invitation}
      {modals}
    </InvitationChrome>
  )
}
