import { ModalFrame } from "../../ui/Modal"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom"
import type { Address, Hex } from "viem"
import {
  deriveBootstrapKey,
  isRegistrationEscalated,
  normalizeTag,
  useAccountContext,
  useAztecContext,
  useContractServiceContext,
  useConfigValue,
  type NameClaimResponse,
  type OxideResumeOutcome,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import { AUTH_TYPE, DEFAULT_CONTRACTS } from "@obsidion/sdk"
import { WALLET_TOKEN_SYMBOL, tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { mockOnboarding } from "../../dev/mockOnboarding"
import { showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent, lapTimer } from "../../lib/analytics"
import { passkeyTelemetry } from "../../lib/passkeyTelemetry"
import { useAsyncAction, useNextRoute } from "../../ui/hooks"
import {
  checkAdmission,
  hasCachedAdmission,
  registrationAdmits,
  recordDepositAdmission,
  hasDepositAdmission,
  useDepositAdmission,
} from "../identity/admission"
import { isGateCancelled, useCeremonyGate } from "../identity/ceremonyGate"
import { IosFloorNotice } from "../identity/IosFloorNotice"
import { PasskeyRefusal, refusalFor, type RefusalState } from "../identity/PasskeyRefusal"
import { GateStep } from "../identity/PhoneSteps"
import { signOut } from "../identity/signOut"
import {
  isPasskeyPolicyError,
  type PasskeyAttemptContext,
  type PasskeyAttemptHandle,
  type PasskeyRequestScope,
} from "@obsidion/passkey-web"
import { statusForAttempt } from "../../platform/auth/passkeyAttemptScope"
import {
  clearWalletIdentity,
  loadOnboardedIdentity,
  loadWalletIdentity,
  saveWalletIdentity,
} from "../identity/walletIdentity"
import {
  clearClaimStash,
  clearTicketSignup,
  peekClaimStash,
  peekTicketSignup,
} from "../paylink/claimStash"
import { linkIdentity } from "../paylink/linkIdentity"
import {
  beginTicketSignupAccount,
  completeTicketSignupAccount,
  isTicketSignupCreating,
  loadTicketSignupAccount,
  loadTicketSignupAttempt,
  restartTicketSignupAccount,
  saveTicketSignupAccount,
} from "../paylink/ticketSignupAccount"
import { reloadIfSessionSwitched } from "./sessionReload"
import {
  boundTicketSignup,
  ticketActivation,
  ticketSignupRegistration,
  ticketHoldNotice,
} from "../paylink/ticketContinuation"
import {
  claimSponsoredLink,
  viewLink,
  type SponsoredPaylinkDeps,
} from "../paylink/sponsoredPaylink"
import { obtainEmailClaimProof } from "../paylink/emailClaim"
import type { PaylinkKit } from "../paylink/usePaylinkDeps"
import { paylinkSignupQuote } from "../paylink/paylinkSignupQuote"
import { getWithdrawalStore } from "../withdraw/withdrawGateway"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { getActiveCredentialId, getActiveStorageId } from "../../platform/storage/activeStorage"
import {
  buildRetrySignDeps,
  claimTag,
  collectOnboardingKeys,
  adoptHandoff,
  getClaimStatus,
  nameGrantToken,
  NameTakenError,
  PasskeyMismatchError,
  CeremonyRequiredError,
  primeHandoffMaterial,
  resolveHandoff,
  reusePasskeyAccount,
  type ClaimTagOutcome,
  type OnboardingKeys,
  type PasskeyHints,
} from "./oxideOnboarding"
import {
  abandonPendingRegistration,
  buildWebDetectionDeps,
  cacheConfirmedNameClaim,
  getPendingStore,
  hasCustody,
  registrationTermsAreInUse,
  runDetectionTick,
} from "./webRegistration"
import { registrationBroadcastSeen } from "./registrationResume"
import { activationPromptDismissed, openActivationPrompt } from "./activationPrompt"
import { noteRegistrationDepositSeen } from "./registrationRailSync"
import { AnalyticsConsentModal } from "./AnalyticsConsentModal"
import { InvitationChrome } from "./InvitationChrome"
import { LostRegistrationNoticeCard } from "./LostRegistrationNoticeCard"
import { ConnectPendingNotice } from "../contacts/ConnectPendingNotice"
import { OnboardingSpinnerBody } from "./OnboardingCard"
import {
  claimErrorMessage,
  enterErrorMessage,
  passkeyErrorMessage,
  REGISTRATIONS_PAUSED_NOTICE,
} from "./onboardingErrorCopy"
import { passkeysSupported, UNSUPPORTED_BROWSER_MESSAGE } from "@obsidion/passkey-web"
import { formatDepositDue, formatDepositSeen, fundingAssetsLabel } from "./steps/DepositTermsRows"
import { RegistrationSheet } from "./RegistrationSheet"
import {
  assertRegistrationUnfunded,
  registrationNeedsRefund,
  useRegistrationRefunded,
} from "./registrationQuoteRecovery"
import { RegistrationRefundAction } from "./RegistrationRefundAction"
import { ManualSweepAction } from "./RegistrationDepositDetailModal"
import { canManualRegistrationSweep } from "./registrationSweep"
import { InvitationStep, type InviteNotice } from "./steps/InvitationStep"
import { AllSetModal, ClaimTagModal } from "./steps/ClaimTagModal"
import { ChooseTagStep } from "./steps/ChooseTagStep"
import { ClaimReviewStep } from "./steps/ClaimReviewStep"
import { WelcomeStep } from "./steps/WelcomeStep"
import { OnboardingCarousel } from "./steps/OnboardingCarousel"
import { useDepositWatch } from "./useDepositWatch"
import {
  depositChainLabel,
  loadRegistrationTerms,
  PAYLINK_TICKET_PAUSED_MESSAGE,
  PAYLINK_TICKET_REFUSED_MESSAGE,
  wireTermsFundTicket,
  recordRegistrationDeposit,
  clearRegistrationTerms,
  rememberReissuedClaim,
  askedTotal,
  floorExceedsAsk,
  quotedRegistrationKind,
  registrationKind,
  registrationQuote,
  saveRegistrationTerms,
  scheduleForRecord,
  signedSchedule,
  signedWithoutSchedule,
  termsUnpriced,
  useChainReadRetry,
  useDepositSkim,
  useSweepDeductions,
  useRegistrationSchedule,
  useRegistrationTerms,
} from "./registrationTerms"
import {
  reportRegistrationDepositFunded,
  reportRegistrationDepositSwept,
} from "./registrationFunnel"

type Step =
  | "invite"
  | "tag"
  | "terms"
  | "create"
  | "claim"
  | "review"
  | "allset"
  | "carousel"
  | "pending"

// Age past which a funded-but-unconfirmed claim warrants the retry lead and the urgency copy.
// Presentation only; the machine guards the claim budget. A record still waiting for its deposit
// is never "stuck": the user has to send it.
const PENDING_URGENCY_MS = 5 * 60_000
/** The pending step re-checks the claim on its own at this cadence; "Check again" checks now. */
const AUTO_CHECK_MS = 24_000
const URGENCY_TICK_MS = 30_000
// A background confirm writes the identity moments after the record close — wait it out before
// discriminating on identity presence.
const CONFIRM_SETTLE_MS = 1_500
/** How long the intro's spinner waits on the hand-off and its broadcast before showing what it has. */
const ENTRY_HOLD_MS = 25_000
// How long the "All set!" card holds before the carousel takes over.
const ALL_SET_MS = 1_400

const BUSY_LABELS = {
  passkey: "Confirm your passkey…",
  checking: "Checking your claim…",
} as const

const subscribePendingStore = (onChange: () => void) => getPendingStore().onListChanged(onChange)

const CREATE_PASSKEY: PasskeyAttemptContext = { ceremony: "create", flow: "onboarding" }
const REUSE_PASSKEY: PasskeyAttemptContext = { ceremony: "sign_in", flow: "onboarding" }
const HANDOFF_PASSKEY: PasskeyAttemptContext = { ceremony: "sign_in", flow: "handoff" }

/**
 * Signup wizard (/claim/:handle?), ULT-667: a full-bleed invitation page with
 * the signup steps as modals over it — create account (passkey, then the
 * chained claim on the same spinner), "All set!", then the onboarding carousel
 * into Home. The passkey must exist BEFORE the claim — the claimed OxideAccount
 * is CREATE2-derived from the bootstrap key, which derives from the passkey's
 * PRF — but the claim itself needs no extra click. An already-claimed handle
 * surfaces on the invitation page with a log-in lead. A failed claim drops to
 * the claim-retry modal without minting a second passkey.
 *
 * The claim returns as soon as the bundler holds the op, and the wizard's
 * chain work ends there: the L2 subscription rides the account's first
 * sponsored batch, so no setup step depends on this session. The identity is
 * saved at that point — before the carousel — so closing the tab mid-carousel
 * just skips it. An open durable record enters at the pending step. Its
 * same-tag retry — a FORCED resume tick over the record, recovering the
 * passkey first when this tab holds no in-memory keys — leads only when the
 * record says a fresh op could help (retryWarranted); a healthy in-flight
 * record leads with the status check instead. Start-over renders only while
 * abandonment can succeed.
 */
export interface OnboardingScreenProps {
  embedded?: boolean
  /** Hosted by the visitor page as the link's own signup: the stashed ticket intent is this
   *  wizard's to spend. Any other mount treats the marker as belonging to someone else. */
  ticketSignup?: boolean
  /** Landing-layout content above the invitation step (the /link paylink summary). */
  inviteHeader?: ReactNode
  /** Where closing the first step of a ticket-funded signup goes: back to the host's page. */
  onExit?: () => void
  /** The paylink services a ticket-funded signup claims its link with, from a host inside the
   *  asset layer (`PaylinkOnboardingScreen`). Ordinary onboarding runs outside that layer and
   *  passes none. */
  paylinkKit?: PaylinkKit
}

export function OnboardingScreen({
  embedded = false,
  ticketSignup = false,
  inviteHeader,
  onExit,
  paylinkKit,
}: OnboardingScreenProps) {
  // `/claim/:handle` is the only tag source that skips the invitation step's own check, and with
  // `entry=passkey` it opens straight on terms. Folded because registration hashes a tag as typed
  // while every resolver folds first, then dropped if it still cannot be claimed, so the wizard
  // falls back to asking for one.
  const { handle: routeParam } = useParams()
  const routeHandle = (routeParam === undefined ? null : normalizeTag(routeParam)) ?? undefined
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  // A route-bound grant may pass a blocklisted name, but the open availability probe still checks
  // for a live reservation before the authenticated /domain/sign request validates the grant.
  const hasRouteGrant = Boolean(routeHandle && nameGrantToken())
  // The campaign hand-off (`/claim/:handle?entry=passkey`, launch-campaign-web handoff.ts): the
  // user already holds the shared passkey, so the wizard opens on the create step with entering
  // as the lead instead of asking them to "unlock access" and create.
  const handoffRpMatches = params.get("rp") === getConfig().rpId
  const passkeyEntry = params.get("entry") === "passkey" && Boolean(routeHandle) && handoffRpMatches
  // `?resume=1`: arrived from a signup already begun (the queue card's exit), so the tag they are
  // about to type may be their own reservation. It proves nothing on its own — the claim server
  // still decides — it only stops the anonymous availability probe from refusing them first.
  const resuming = params.get("resume") === "1"
  const recoveryVisit = params.get("recovery") === "1"
  // The rest of the hand-off contract, all optional: `fee=waived` (the campaign's reservation
  // carried a fee waiver; a hint for the terms step, the claim after the passkey decides),
  // `until=<unix s>` (the reservation deadline), and `cred`/`pk` (the credential id and its raw
  // public key) so the assertion is one prompt instead of the two-assertion key recovery.
  const freeHint = params.get("fee") === "waived"
  // src=campaign is a constant cohort label the campaign hand-off appends — never a per-user id.
  const entryCohort =
    params.get("src") === "campaign" ? "campaign" : routeHandle ? "link" : "direct"
  const untilHint = Number(params.get("until")) || undefined
  const passkeyHints = handoffRpMatches
    ? {
        credentialId: params.get("cred") ?? undefined,
        pubkeyHex: params.get("pk") ?? undefined,
        expectedL2Address: params.get("l2") ?? undefined,
        policyVersion: params.get("pv") ?? undefined,
      }
    : {}
  const navigate = useNavigate()
  const config = getConfig()
  const { obsidionWallet } = useAztecContext()
  const { contractService } = useContractServiceContext()
  const { createAccount, setObsidionAccount, obsidionAccount } = useAccountContext()
  const paylinkDeps = useMemo(
    () => (paylinkKit && obsidionAccount ? { ...paylinkKit, account: obsidionAccount } : undefined),
    [paylinkKit, obsidionAccount],
  )
  const paylinkDepsRef = useRef(paylinkDeps)
  paylinkDepsRef.current = paylinkDeps
  const paylinkKitRef = useRef(paylinkKit)
  paylinkKitRef.current = paylinkKit
  const paylinkSettleRef = useRef(false)
  const next = useNextRoute()
  // Omit empty `next` so a direct /claim visit doesn't write `{ next: undefined }` into history.
  const go = (to: string) => navigate(to, { replace: true, ...(next ? { state: { next } } : {}) })
  // A leftover inbound stash still claims on Home; a paylink signup settles the claim before entry.
  /**
   * The wallet first, the proof behind it: Home paints, a name still owed its deposit raises the
   * activation sheet on arrival, and only then does a deferred broadcast start proving.
   */
  const intoWallet = () => {
    go(peekClaimStash() ? "/" : next ?? "/")
    const rec = getPendingStore().current()
    if (
      rec &&
      (rec.phase === "awaiting_deposit" || rec.phase === "funded") &&
      !activationPromptDismissed(rec)
    ) {
      openActivationPrompt()
    }
    setTimeout(startDeferredBroadcast, 0)
  }

  // Any open record lands on the pending step, whether or not its op reached the bundler: the tag
  // is unconfirmed either way, and this step is where web offers the retry, the status check, and
  // the start-over. It is also where the tag surfaces link back to. Sponsored account setup is
  // deferred to the first sponsored batch (subscribeContext), so there is no L2 step to resume.
  // The snapshot only seeds the initial step/handle — the pending surface reads the live record.
  // A hand-off names the tag and the passkey to use; a record this origin left in flight for
  // ANOTHER tag does not capture it (the record stays tracked, and is abandoned below if it can be).
  // A ticket-funded signup (the visitor chose to receive the link into a new account) runs the
  // three-step modal and is choosing a name: a leftover reservation must not skip the tag field.
  const [fromPaylink] = useState(
    () => ticketSignup && Boolean(peekTicketSignup()) && !passkeyEntry && !routeHandle,
  )
  const [ticketFragment] = useState(() => (fromPaylink ? peekTicketSignup()?.fragment : undefined))
  const readTicketAttempt = () =>
    ticketFragment ? loadTicketSignupAttempt(config.rpId, linkIdentity(ticketFragment)) : null
  const [ticketAttempt, setTicketAttempt] = useState(() => {
    try {
      return readTicketAttempt()
    } catch {
      return null
    }
  })
  const resumingTicket = ticketAttempt !== null && !isTicketSignupCreating(ticketAttempt)
  const ticketAddress = resumingTicket ? ticketAttempt.l2Address : undefined
  const [leftoverTag] = useState(() => (fromPaylink ? undefined : getPendingStore().current()?.tag))
  const ownRecord = (open: PendingRegistrationRecord | null) =>
    passkeyEntry && open && open.tag !== routeHandle ? null : open
  const [openRecord] = useState(() =>
    ticketFragment
      ? ticketSignupRegistration(ticketFragment, ticketAddress)
      : ownRecord(getPendingStore().current()),
  )
  const [mock] = useState(mockOnboarding)
  const [step, setStepState] = useState<Step>(
    () =>
      mock?.step ??
      (openRecord
        ? "pending"
        : passkeyEntry
        ? "carousel"
        : fromPaylink
        ? ticketAttempt
          ? "terms"
          : "tag"
        : "invite"),
  )
  // The step as last set, for callbacks that settle after the render they were made in.
  const stepRef = useRef(step)
  const setStepNow = (to: Step) => {
    stepRef.current = to
    setStepState(to)
  }
  /**
   * A hand-off's claim runs while the user reads the intro, and lands on its own schedule. The
   * step it asks for is held until the last slide, so the slides are never pulled out from under
   * them; every other step applies at once. The hold reads the current step, not the one the
   * caller was rendered with: an outcome that lands after the intro has moved on applies.
   */
  const heldStep = useRef<Step | undefined>(undefined)
  const setStep = (to: Step) => {
    if (stepRef.current === "carousel" && to !== "carousel" && passkeyEntry && !mock)
      heldStep.current = to
    else setStepNow(to)
  }
  // The field's text, so "" rather than null when nothing usable was handed in.
  const [handle, setHandle] = useState(
    normalizeTag(mock?.handle ?? routeHandle ?? openRecord?.tag ?? ticketAttempt?.tag ?? "") ?? "",
  )
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteNotice, setInviteNotice] = useState<InviteNotice>()
  const [modalBusy, setModalBusy] = useState(mock?.busy ?? false)
  const [createBusyPhase, setCreateBusyPhase] = useState<
    "passkey" | "claim" | "broadcast" | "paylink"
  >("passkey")
  // A hand-off past its point of no return: the account is being adopted and storage is about to
  // switch, so Cancel is withdrawn until it lands. The ref is what the handlers read.
  const [adopting, setAdopting] = useState(false)
  const adoptingRef = useRef(false)
  const markAdopting = (value: boolean) => {
    adoptingRef.current = value
    setAdopting(value)
  }
  const [modalError, setModalError] = useState<string>()
  // A policy refusal renders as its own state with a retry; anything else is `modalError` text.
  const [modalRefusal, setModalRefusal] = useState<RefusalState>()
  const retryRef = useRef<(() => void) | undefined>(undefined)
  const { gate, state: gateState, cancel: cancelGate, dismiss: dismissGate } = useCeremonyGate()
  const [busyStage, setBusyStage] = useState<keyof typeof BUSY_LABELS>()
  const [inlineNotice, setInlineNotice] = useState<string>()
  // A policy refusal on the pending step's retry, rendered with its own retry.
  const [pendingRefusal, setPendingRefusal] = useState<RefusalState>()
  const [queuedNote, setQueuedNote] = useState<string>()
  const [lastCheckedAt, setLastCheckedAt] = useState<number>()
  const [broadcastInFlight, setBroadcastInFlight] = useState(false)
  const autoRebroadcastRef = useRef(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  // The fresh NameClaim a live claim just returned — the deposit panel's deadline/waiver source.
  // In memory only, same as the session result it comes from: a resumed record (reload) has none,
  // and the panel falls back to address + the deployment's flat minimum/fee. Dev preview
  // (?mock=deposit|deposit-free|funded) seeds this directly instead of ever claiming for real.
  const [freshClaim, setFreshClaim] = useState<NameClaimResponse | undefined>(() =>
    mock?.depositPhase
      ? {
          signature: "0x00",
          nonce: "1",
          deadline: String(Math.floor(Date.now() / 1000) + (mock.expired ? -60 : 3600)),
          terms: {
            fee: String(mock.fee),
            minDeposit: String(mock.min),
            nonce: "1",
            deadline: "9999999999",
            signature: "0x00",
            reduced: mock.free === true,
          },
        }
      : undefined,
  )
  // Dev preview only: a synthetic record so the deposit panel's states render without a real claim
  // or sandbox deposit. Never written to the real store — see dev/mockOnboarding.ts.
  const [mockRecord] = useState<PendingRegistrationRecord | null>(() =>
    mock?.depositPhase
      ? {
          account: `0x${"0".repeat(38)}f1`,
          tag: mock.handle,
          nameHash: `0x${"11".repeat(32)}` as Hex,
          l2Address: `0x${"22".repeat(32)}` as Hex,
          l1ChainId: mock.wrongChain ? config.l1ChainId + 1 : config.l1ChainId,
          sipaAddress: `0x${"0".repeat(38)}c3`,
          fee: "0",
          beneficiary: `0x${"0".repeat(38)}b5`,
          depositToken: `0x${"0".repeat(38)}d4`,
          broadcast: true,
          phase: mock.depositPhase,
          retries: 0,
          startTime: Date.now(),
          ...(mock.depositPhase === "funded" ? { fundedAt: Date.now() } : {}),
        }
      : null,
  )
  const { busy, run } = useAsyncAction()
  const addressRef = useRef<string | undefined>(undefined)
  // The claim step runs after the account exists — thread the derived key material between them.
  const keysRef = useRef<OnboardingKeys | undefined>(undefined)
  // "Cancel sign-in" on a spinner stops WATCHING the in-flight op (WebAuthn and the claim POST have
  // no client-side abort): bumping the generation makes the settled op's UI routing a no-op. The
  // scope beside it is what a passkey recovery runs under, so abandoning the op also ends any
  // adoption still short of its keys, prompt or held key.
  const opGen = useRef(0)
  const opScope = useRef<AbortController | undefined>(undefined)
  const startOp = () => {
    opScope.current?.abort()
    const scope = new AbortController()
    opScope.current = scope
    return scope.signal
  }
  const abandonOp = () => {
    opGen.current++
    opScope.current?.abort()
  }
  // Leaving the screen ends whatever was running: the recovery's scope and the gate's attempt behind
  // any open prompt, so nothing commits for a screen that is gone.
  const cancelGateRef = useRef(cancelGate)
  cancelGateRef.current = cancelGate
  useEffect(
    () => () => {
      opScope.current?.abort()
      cancelGateRef.current()
    },
    [],
  )
  // Survives a reload from the durable record, so the pending step still knows which account it
  // is watching — including after a terminal close makes the record invisible to current().
  const oxideAccountRef = useRef<string | undefined>(openRecord?.account)
  // Keys recovered via the pending step's passkey reuse end at the identity write, never the
  // all-set/carousel funnel — that funnel belongs to live signup sessions.
  const recoveredRef = useRef(false)
  const retryInFlight = useRef(false)
  // A forced tick whose re-sign quoted a schedule the paylink cannot pay: the resume machine
  // treats that claim as ordinary and reports nothing, so the wrapper leaves the refusal here
  // for the tick to show once the machine has settled.
  const renewalRefusedRef = useRef(false)

  // The passkey attempts still running, each with the generation it belongs to. Whatever ends one
  // marks why before it touches the gate.
  const passkeyAttempts = useRef(new Map<PasskeyAttemptHandle, number>())
  const passkeyAttempt = <T,>(
    context: PasskeyAttemptContext,
    gen: number,
    fn: (own: PasskeyRequestScope) => Promise<T>,
  ): Promise<T> => {
    // The gate this attempt takes cancels whatever was waiting on it, so the older ones are
    // replaced, not cancelled by the user.
    markAttempts("superseded")
    const attempt = passkeyTelemetry.begin(context)
    passkeyAttempts.current.set(attempt, gen)
    return attempt.run(fn).finally(() => passkeyAttempts.current.delete(attempt))
  }
  // The manual sweep on the deposit sheet runs its own attempt; the sheet's exits speak for it too.
  const sweepAttempt = useRef<PasskeyAttemptHandle | undefined>(undefined)
  /** Every running attempt, or with `current` only those of the current generation. */
  const markAttempts = (cause: "userCancelled" | "superseded" | "unmounted", current = false) => {
    for (const [attempt, gen] of passkeyAttempts.current) {
      if (!current || gen === opGen.current) attempt[cause]()
    }
    if (!current) sweepAttempt.current?.[cause]()
  }
  useEffect(() => () => markAttempts("unmounted"), [])

  // Bumped by the invite step's own cancel — the handle-availability read has no client-side abort,
  // so this just makes a settled response a no-op instead of resolving the busy state under it.
  const inviteGen = useRef(0)

  // Live record: escape predicate, urgency clock, feedback line, and terminal routing all read
  // this, never the mount snapshot. RecordStorage emits on every field write. A dev-preview record
  // always wins — it never lives in the real store, so the live read would otherwise see nothing.
  const currentRegistration = () => {
    const store = getPendingStore()
    if (fromPaylink) {
      const pinned = oxideAccountRef.current ? store.get(oxideAccountRef.current) : null
      const matching = ticketFragment
        ? ticketSignupRegistration(ticketFragment, ticketAddress)
        : null
      // Keep this session's record through settlement or a paused-ticket fallback.
      return (
        matching ??
        (pinned &&
        pinned.tag === handle &&
        (!ticketAddress || pinned.l2Address.toLowerCase() === ticketAddress.toLowerCase())
          ? pinned
          : null)
      )
    }
    return (
      ownRecord(store.current()) ??
      (oxideAccountRef.current ? store.get(oxideAccountRef.current) : null)
    )
  }
  const liveRecord = useSyncExternalStore(subscribePendingStore, currentRegistration)
  const record = mockRecord ?? liveRecord
  useEffect(() => {
    if (record) oxideAccountRef.current = record.account
  }, [record])

  // Consent lands at the end of signup, so every onboarding event above fires behind a closed
  // gate and never leaves the device. This marks the start of the measurable session — the
  // wallet — not the start of onboarding. `asked` only goes false→true, so it fires once.
  const { value: asked, setValue: setAsked } = useConfigValue("analyticsAsked")
  const { setValue: setConsent } = useConfigValue("analyticsConsent")
  // The consent prompt is the last thing between a finished signup and the wallet.
  const [consentPending, setConsentPending] = useState(false)
  const startedAtRef = useRef<number>(performance.now())
  useEffect(() => {
    if (!asked) return
    startedAtRef.current = performance.now()
    fireEvent("onboarding_started", { has_claim_link: !!routeHandle, entry: entryCohort })
  }, [asked, routeHandle, entryCohort])

  /**
   * Signup lives on the campaign, so the wallet keeps no invitation to land on. A visit that is
   * not the campaign's hand-off and has no reservation in flight leaves for the campaign's landing
   * rather than offering a signup of its own, which is where closing a sheet used to strand people.
   * An account already entered here stays: a nameless one registers its name on this step
   * (RegisterNameCard), asserting the passkey it owns, and the campaign cannot sign that passkey
   * in. A build with no campaign (a local pair, a self-hosted wallet, the e2e) has nowhere to send
   * them, so it keeps the step.
   */
  const leaveForCampaign = (): boolean => {
    if (mock || embedded || !config.campaignUrl) return false
    try {
      window.location.assign(config.campaignUrl)
    } catch {
      return false
    }
    return true
  }
  useEffect(() => {
    // A name in the path is not an invitation to sign up: only the campaign's hand-off is, so a
    // link typed, shared or kept from an older build goes back there. A signup already in flight
    // stays — its record, its recovery and its resume are the wallet's own to finish.
    if (passkeyEntry || openRecord || recoveryVisit || resuming) return
    if (loadWalletIdentity()) return
    leaveForCampaign()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a bare visit is decided at mount
  }, [])

  const logIn = () => {
    const taken = inviteNotice?.kind === "taken" ? inviteNotice.handle : undefined
    go(taken ? `/enter?handle=${encodeURIComponent(taken)}` : "/enter")
  }

  /** "Activate account": the claim-status read gates create vs. already-claimed. */
  // ponytail: dev mock — spin briefly, then advance; no backend, no analytics.
  const mockAdvance = (to: Step) => {
    setModalBusy(true)
    setTimeout(() => {
      setModalBusy(false)
      setStep(to)
    }, 200000)
  }

  const unlockAccess = async (typedHandle: string) => {
    const chosenHandle = normalizeTag(typedHandle) ?? ""
    if (mock) {
      setHandle(chosenHandle)
      setStep("terms")
      return
    }
    setInviteNotice(undefined)
    setInviteBusy(true)
    const gen = ++inviteGen.current
    try {
      setHandle(chosenHandle)
      const elapsed = lapTimer()
      const status = await getClaimStatus(chosenHandle)
      if (gen !== inviteGen.current) return
      fireEvent("onboarding_handle_checked", { duration_ms: elapsed(), claim_status: status })
      if (status === "claimed") setInviteNotice({ kind: "taken", handle: chosenHandle })
      else {
        // Only this ticket's reservation can be abandoned when the visitor changes its tag.
        const open = currentRegistration()
        if (fromPaylink && open && open.tag !== chosenHandle && !hasCustody(open)) {
          await abandonPendingRegistration(open.account)
        }
        if (keysRef.current) {
          // Cancelled-but-completed ceremony: keys are already in memory — claim without a second click.
          setCreateBusyPhase("claim")
          setModalBusy(true)
          setStep("create")
          void claimTagStep()
        } else setStep("terms")
      }
    } catch (err) {
      if (gen !== inviteGen.current) return
      fireEvent("action_failed", { action: "unlock_access", code: failureCode(err) })
      setInviteNotice({
        kind: "error",
        message: `Couldn't verify that handle${
          err instanceof Error ? ` — ${err.message}` : ""
        }. Try again.`,
      })
    } finally {
      if (gen === inviteGen.current) setInviteBusy(false)
    }
  }

  /** Abandons the handle-availability read: a settled response after this becomes a no-op. */
  const cancelUnlock = () => {
    inviteGen.current++
    setInviteBusy(false)
  }

  /** Every ticket claim retry must use its durable account binding and loaded account stores. */
  const resumeTicketWithKeys = (keys: OnboardingKeys, previousStorageId = getActiveStorageId()) => {
    if (!fromPaylink || !ticketFragment) return false
    const ticketId = linkIdentity(ticketFragment)
    const binding = loadTicketSignupAccount(config.rpId, ticketId)
    const address = keys.account.getAddress().toString()
    if (!binding || binding.l2Address.toLowerCase() !== address.toLowerCase())
      throw new Error("This signup's account was not saved. Reopen the payment link to continue.")
    setTicketAttempt(binding)
    if (reloadIfSessionSwitched(previousStorageId, address)) {
      abandonOp()
      return true
    }
    const pending = ticketSignupRegistration(ticketFragment, address)
    if (pending) {
      oxideAccountRef.current = pending.account
      setHandle(pending.tag)
      recoveredRef.current = true
      setStep("pending")
      return true
    }
    if (!handle) {
      setStep("tag")
      return true
    }
    if (binding.tag !== handle)
      saveTicketSignupAccount(config.rpId, ticketId, { ...binding, tag: handle })
    return false
  }

  /**
   * The shared create/enter body: acquire the account keys (mint a fresh passkey, or reuse the
   * shared campaign one), then claim the handle on the same spinner. A cancelled ceremony that
   * completes anyway keeps its keys so the next click claims without a second prompt. A failed
   * claim drops to ClaimTagModal so it can be retried independently.
   */
  const acquireAndClaim = async (
    acquire: (gen: number, signal: AbortSignal) => Promise<OnboardingKeys>,
    mode: "create" | "enter",
  ) => {
    setModalError(undefined)
    setModalRefusal(undefined)
    if (keysRef.current) {
      setCreateBusyPhase("claim")
      return claimTagStep()
    }
    const gen = ++opGen.current
    const signal = startOp()
    const previousStorageId = getActiveStorageId()
    setCreateBusyPhase("passkey")
    setModalBusy(true)
    try {
      const elapsed = lapTimer()
      const keys = await acquire(gen, signal)
      keysRef.current = keys
      addressRef.current = keys.account.getAddress().toString()
      if (gen !== opGen.current) return
      if (resumeTicketWithKeys(keys, previousStorageId)) return
      if (reloadIfSessionSwitched(previousStorageId, addressRef.current)) return abandonOp()
      fireEvent("onboarding_account_created", { duration_ms: elapsed(), mode })
      setCreateBusyPhase("claim")
      await applyClaimOutcome(await claimWithAnalytics(keys))
    } catch (err) {
      if (gen !== opGen.current || isGateCancelled(err)) return
      if (fromPaylink) {
        try {
          setTicketAttempt(readTicketAttempt())
        } catch {
          /* The original error is shown below. */
        }
      }
      // The material-only attempt found no material: not an error, the tap will ask. A tap that
      // already came in is not made to wait for another.
      if (err instanceof CeremonyRequiredError) {
        if (tapPending.current) {
          tapPending.current = false
          void enterPasskeyStep()
        }
        return
      }
      if (keysRef.current) {
        fireEvent("action_failed", { action: "claim_tag", code: failureCode(err) })
        if (!steerAfterNameRefusal(err)) {
          setModalError(claimErrorMessage(err, { tag: handle, until: untilHint }))
          setStep("claim")
        }
      } else {
        fireEvent("action_failed", {
          action: mode === "create" ? "create_account" : "enter_passkey",
          code: failureCode(err),
        })
        if (isPasskeyPolicyError(err)) {
          setModalRefusal({ name: err.name, message: err.message })
        } else {
          setModalError(mode === "create" ? passkeyErrorMessage(err) : enterErrorMessage(err))
        }
      }
    } finally {
      if (gen === opGen.current) {
        setModalBusy(false)
        setCreateBusyPhase("passkey")
        // A tap kept for a prompt has nothing left to open: the attempt ended, with an account,
        // a refusal or an error, and none of those asks for one.
        tapPending.current = false
      }
    }
  }

  /**
   * A new ticket signup creates a passkey; an interrupted one recovers only its bound account.
   * Ordinary signup can reuse a nameless identity, pinned to the identity's account,
   * instead of minting a second one — the claimed name must land on the account that entered. With
   * no identity at all, a key this tab still holds for a passkey with a record (a signup that died
   * between its commit and its account record) reuses that account the same way, with no ceremony.
   */
  const createAccountStep = () => {
    if (mock) {
      setCreateBusyPhase("claim")
      return mockAdvance("allset")
    }
    const identity = loadWalletIdentity()
    const namelessAddress = identity && !identity.handle ? identity.address : undefined
    retryRef.current = createAccountStep
    return acquireAndClaim(async (gen, signal) => {
      const ticket = fromPaylink ? peekTicketSignup() : null
      if (fromPaylink && !ticket)
        throw new Error("Open your payment link again to continue signup.")
      const ticketId = ticket ? linkIdentity(ticket.fragment) : undefined
      if (ticketId) {
        const prior = loadTicketSignupAccount(config.rpId, ticketId)
        if (prior) {
          if (!obsidionWallet) throw new Error("wallet is still starting, try again in a moment")
          const keys = await passkeyAttempt(REUSE_PASSKEY, gen, (own) =>
            reusePasskeyAccount(
              obsidionWallet,
              prior.l2Address,
              { credentialId: prior.credentialId },
              gate,
              signal,
              own,
            ),
          )
          if (gen === opGen.current) setObsidionAccount(keys.account)
          return keys
        }
      }
      // Ordinary signup can recover its existing account. A new ticket signup requires creation;
      // a cached key or nameless identity alone does not select its recipient account.
      // The cache is proved against the account it names before it is handed back.
      const fromCache = async () => {
        const cached = await getAuthService()?.recoverFromCache?.()
        if (!cached?.expectedAddress) return undefined
        if (!obsidionWallet) throw new Error("wallet is still starting, try again in a moment")
        const expectedAddress = cached.expectedAddress
        const keys = await passkeyAttempt(REUSE_PASSKEY, gen, (own) =>
          reusePasskeyAccount(
            obsidionWallet,
            expectedAddress,
            { credentialId: cached.credentialId },
            gate,
            signal,
            own,
          ),
        )
        if (gen === opGen.current) setObsidionAccount(keys.account)
        return keys
      }
      // Resuming continues the signup this session committed, so its own key goes first: an
      // identity left behind by another account, named or not, must not pin the passkey to that
      // account's address.
      if (!fromPaylink && resuming) {
        const keys = await fromCache()
        if (keys) return keys
      }
      if (!fromPaylink && namelessAddress) {
        if (!obsidionWallet) throw new Error("wallet is still starting, try again in a moment")
        // The identity's own passkey is the one the session pointers name; a browser with several
        // roots must not be pinned to the newest. A session with no passkey opens the chooser; only
        // a tab with no session falls back to the root recorded for this account, and to the open
        // prompt when it holds none.
        const credentialId = getActiveCredentialId()
        const hints: PasskeyHints = getActiveStorageId()
          ? credentialId
            ? { credentialId }
            : { discover: true, chooser: true }
          : { credentialId: await getAuthService()?.rootCredentialId?.(namelessAddress) }
        const keys = await passkeyAttempt(REUSE_PASSKEY, gen, (own) =>
          reusePasskeyAccount(obsidionWallet, namelessAddress, hints, gate, signal, own),
        )
        if (gen === opGen.current) setObsidionAccount(keys.account)
        return keys
      }
      // A stored identity normally means this browser has an account already, so a fresh signup
      // must not adopt a cached key instead.
      if (!fromPaylink && !identity && !resuming) {
        const keys = await fromCache()
        if (keys) return keys
      }
      // Resuming a signup means the passkey exists; with nothing here naming its account, the
      // recovery screen is where it is found again. Creating one would mint a second credential
      // and a second account, leaving the reservation behind.
      if (!fromPaylink && resuming) {
        go(handle ? `/enter?handle=${encodeURIComponent(handle)}` : "/enter")
        // Abandon this attempt the way a cancel does, so leaving raises nothing and leaves no
        // spinner behind. Throwing is the only way out of an acquire that produces no keys.
        abandonOp()
        setModalBusy(false)
        setCreateBusyPhase("passkey")
        throw new Error("resuming through the recovery screen")
      }
      // Creation is always a ceremony, so it holds at the gate like every other flow; the route the
      // user picks opens the browser on that device.
      // A ticket-funded signup proves its golden ticket in this PXE before the NameClaim.
      if (fromPaylink && !obsidionWallet) {
        throw new Error("wallet is still starting, try again in a moment")
      }
      const account = await passkeyAttempt(CREATE_PASSKEY, gen, async (own) => {
        const { route } = await gate({ purpose: "create" })
        const ticket = ticketId ? beginTicketSignupAccount(config.rpId, ticketId, handle) : null
        if (ticket) setTicketAttempt(ticket)
        return createAccount(false, AUTH_TYPE.WEB_AUTHN, statusForAttempt(own), handle, undefined, {
          route,
          ...(ticket && ticketId
            ? {
                onAccountCreated: (created: { credentialId: string; l2Address: string }) => {
                  completeTicketSignupAccount(config.rpId, ticketId, ticket.attemptId, created)
                },
              }
            : {}),
        })
      })
      return collectOnboardingKeys(account)
    }, "create")
  }

  /**
   * "Enter with your passkey": the campaign made a passkey on the same RP, so reusing it (one
   * assertion) re-derives the SAME account here. Then the reserved handle is claimed by deposit
   * exactly like a fresh account — the reservation is held under this account's own bootstrap key.
   */
  const enterPasskeyStep = (silentOnly = false) => {
    if (mock) {
      setCreateBusyPhase("claim")
      return mockAdvance("allset")
    }
    retryRef.current = () => enterPasskeyStep()
    return acquireAndClaim(async (gen, signal) => {
      if (!obsidionWallet || !contractService) {
        throw new Error("wallet is still starting, try again in a moment")
      }
      // A silent run asks nothing, so its attempt reports nothing when it takes the bridge material
      // or refuses for want of a prompt. Only a refusal the material itself earns is worth an
      // event, and the tracker sends that one with no prompt counted.
      const resolved = await passkeyAttempt(HANDOFF_PASSKEY, gen, (own) =>
        resolveHandoff(
          obsidionWallet,
          contractService,
          config,
          passkeyHints,
          gate,
          signal,
          silentOnly,
          own,
        ),
      )
      // Cancelled while the prompt was up: the ceremony cannot be aborted, but its result can be
      // dropped. Nothing is written yet, so the next click simply asks again. Past this point
      // Cancel is withdrawn: adoption runs to the end or fails on its own.
      if (gen !== opGen.current) throw new Error("hand-off cancelled")
      markAdopting(true)
      try {
        const keys = await adoptHandoff(obsidionWallet, resolved, async () => {
          // The hand-off's passkey and tag own this origin from here: a different prior identity
          // is signed out (the passkey survives; /enter recovers it) and an in-flight record for
          // another tag that holds no deposit is abandoned. Runs while storage still points at the
          // previous account, so its records are closed where they live.
          const identity = loadWalletIdentity()
          if (identity !== null && identity.handle !== routeHandle) clearWalletIdentity()
          const open = getPendingStore().current()
          if (open && open.tag !== routeHandle && !hasCustody(open)) {
            await abandonPendingRegistration()
          }
        })
        setObsidionAccount(keys.account)
        return keys
      } finally {
        markAdopting(false)
      }
    }, "enter")
  }

  const claimWithAnalytics = (keys: OnboardingKeys) => {
    const elapsed = lapTimer()
    const lap = lapTimer()
    return claimTag(
      handle,
      keys,
      config,
      obsidionWallet,
      (stage) => fireEvent("onboarding_oxide_stage", { stage, prev_stage_ms: lap() }),
      expectedEarned,
      undefined,
      undefined,
      fromPaylink ? peekTicketSignup() : null,
    ).then((outcome) => {
      // `onboarding_tag_claimed` means CONFIRMED on-chain — an already-registered name proves it
      // here; a submitted op fires it from the detection tick once the Registry read settles, with
      // custody_to_confirmed_ms from the durable record. Custody alone gets its own event.
      if (outcome.kind === "custody" && outcome.confirmed) {
        fireEvent("onboarding_tag_claimed", { duration_ms: elapsed() })
        // The detection tick that normally writes this cache never runs for a session that saw
        // confirmation itself — its record closes with no tick in between.
        cacheConfirmedNameClaim(config, {
          account: outcome.oxideAccount,
          tag: handle,
          l2Address: keys.account.getAddress().toString(),
        })
      } else if (outcome.kind === "custody") {
        fireEvent("onboarding_tag_custody", { duration_ms: elapsed() })
      }
      return outcome
    })
  }

  /**
   * The signup is complete once the account-service holds the op: save the
   * identity NOW (before the carousel), so cancelling or closing anything from
   * here on cannot strand a claimed tag without a wallet identity.
   *
   * The handle is a parameter rather than the `handle` state so that what gets persisted is the
   * tag this completion actually claimed, not whatever the field happened to hold.
   */
  const completeSignup = (effectiveHandle: string) => {
    const rec = oxideAccountRef.current ? getPendingStore().get(oxideAccountRef.current) : null
    const stillPending = rec !== null && rec.phase !== "confirmed"
    // The persisted terms are the waiver authority; a custody/nameless completion has none.
    const completedTerms = rec ? loadRegistrationTerms(rec.account, rec.tag) : undefined
    fireEvent("onboarding_completed", {
      total_duration_ms: Math.round(performance.now() - startedAtRef.current),
      named: !!effectiveHandle,
      fee_waived: completedTerms ? completedTerms.feeWaived === true : undefined,
    })
    saveWalletIdentity({
      handle: effectiveHandle,
      address: addressRef.current!,
      claimedAt: Date.now(),
      ...(stillPending ? { pending: true } : {}),
    })
    // The intro is waiting, or gave up on this very claim: its wait enters once the broadcast has
    // settled too, however late this completion lands.
    if (enterWhenReady.current) {
      setAwaitingEntry(true)
      setStepNow("carousel")
      return
    }
    setStep("allset")
  }

  const waitlistNote = (position?: number | null) =>
    position != null
      ? `You're #${position.toLocaleString("en-US")} in line. Deposit the minimum to enter now.`
      : "You're still in line. Deposit the minimum to enter now."

  /**
   * Entry decision at completion: no wallet entry while waitlisted. A funded or confirmed
   * registration admits by itself (the paid queue-skip); otherwise the campaign is asked with a
   * bootstrap-key signature. Queued, unknown, or unreachable fails closed: the deposit panel
   * stays up with the line note (WalletGate would bounce the identity anyway), and a nameless
   * attempt steers back to the name step, since skipping the line needs a name to deposit for.
   */
  const finishSignup = async (effectiveHandle: string) => {
    const rec = oxideAccountRef.current ? getPendingStore().get(oxideAccountRef.current) : null
    if (registrationAdmits(rec?.phase ?? "", addressRef.current ?? ""))
      return completeSignup(effectiveHandle)
    let position: number | null | undefined
    if (keysRef.current) {
      const check = await checkAdmission(
        deriveBootstrapKey(keysRef.current.secretKey),
        addressRef.current ?? "",
        "onboarding",
      )
      if (check.status === "granted") return completeSignup(effectiveHandle)
      if (check.status === "queued") position = check.queuePosition
    }
    if (rec) {
      setQueuedNote(waitlistNote(position))
      startDeferredBroadcast()
      setStep("pending")
    } else {
      markAttempts("superseded")
      steerToInvite({
        kind: "error",
        message: "You're still in line. Register a name with a deposit to enter now.",
      })
    }
  }

  // Whether the user asked for the deposit address on the terms step. A waived claim skips the
  // gate only when they chose to enter first (registration-fee.md Campaign: Free names).
  const depositIntentRef = useRef(true)

  /**
   * Terms accepted: the passkey ceremony runs right away (assert the campaign's existing passkey,
   * or create one), then the claim, then the address. A laptop holds at the phone steps first; the
   * create modal only shows again if the ceremony fails and needs a retry.
   */
  /**
   * The intro's first tap: the ceremony the hand-off needs. A wallet still booting has nothing to
   * run yet, so the tap is not spent and the last slide asks again — `handoffDone` says whether an
   * account exists. A refusal falls back to the terms sheet, which carries the retry.
   */
  // The bridge's write is waited for from here, while the slides are read, so the tap that starts
  // the hand-off still counts as activation when the passkey is asked for.
  useEffect(() => {
    if (passkeyEntry && !mock) primeHandoffMaterial(passkeyHints.credentialId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the hand-off's credential is fixed by the URL
  }, [passkeyEntry, mock, passkeyHints.credentialId])

  const handoffDone = () => loadOnboardedIdentity()?.handle === handle
  /**
   * The bridge's material needs no tap. It is taken as soon as the wallet can use it, while the
   * first slide is read, so a hand-off that has it is done before the last slide. Only one that
   * needs a prompt waits for the tap that can open one.
   */
  useEffect(() => {
    // Arriving from the campaign again, on a name this browser already entered: the wallet is
    // theirs, and the deposit it still owes is the activation sheet's to ask for over Home.
    // Opening the pending step again would hold them at a gate the wallet no longer keeps.
    if (!passkeyEntry || mock || !openRecord) return
    if (loadOnboardedIdentity()?.handle !== openRecord.tag) return
    intoWallet()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the record snapshot is fixed at mount
  }, [passkeyEntry, mock])

  const silentTried = useRef(false)
  const tapPending = useRef(false)
  useEffect(() => {
    if (!passkeyEntry || mock || !obsidionWallet || !contractService) return
    if (silentTried.current || handoffTried.current || handoffDone()) return
    silentTried.current = true
    depositIntentRef.current = false
    void enterPasskeyStep(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, when the wallet is ready
  }, [passkeyEntry, mock, obsidionWallet, contractService])
  /**
   * The intro ended before the claim did. The slides give way to a spinner, and the signup enters
   * the wallet the moment it saves an identity — the thing the wallet's gate reads. Work that ends
   * with no account instead falls back to the terms sheet, which carries the prompt and its retry,
   * or to the refusal or claim error the work itself asked for while the wait was up. A wait that
   * gives up on work still running keeps `enterWhenReady`: that work's completion enters late.
   */
  const enterWhenReady = useRef(false)
  const [awaitingEntry, setAwaitingEntry] = useState(false)
  const [holdExpired, setHoldExpired] = useState(false)
  /**
   * Everything the intro waits on: work in flight, a tap still owed, or a wallet that has not
   * booted, none of which has an account yet to enter on. The deferred broadcast is not among
   * them. Its deposit address is valid before it lands, funds waiting at the counterfactual
   * address for a later tick to re-broadcast, and Home's activation hero owns everything left to
   * say from there, down to an address that never published.
   */
  const notReady = () =>
    !holdExpired &&
    (modalBusy || tapPending.current || !silentTried.current || !obsidionWallet || !contractService)
  // Nothing here is allowed to hold forever: the record is durable, and Home's activation sheet
  // carries the address and the re-broadcast from here.
  useEffect(() => {
    if (!awaitingEntry) return
    const timer = setTimeout(() => setHoldExpired(true), ENTRY_HOLD_MS)
    return () => clearTimeout(timer)
  }, [awaitingEntry])
  useEffect(() => {
    if (!awaitingEntry || notReady()) return
    setAwaitingEntry(false)
    if (handoffDone()) {
      enterWhenReady.current = false
      return finishOnboarding()
    }
    // Given up on work still running: what it decides still applies, and a completion enters.
    enterWhenReady.current = modalBusy
    const held = heldStep.current
    heldStep.current = undefined
    handoffTried.current = false
    setStepNow(held && held !== "allset" && held !== "pending" ? held : "terms")
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the op ending, read fresh
  }, [awaitingEntry, modalBusy, obsidionWallet, contractService, holdExpired])
  const handoffTried = useRef(false)
  const startHandoff = () => {
    if (handoffTried.current || handoffDone()) return
    // The material attempt may still be running, or the wallet still booting: the tap is kept, and
    // spent on the prompt the moment either says one is needed.
    if (modalBusy || !obsidionWallet || !silentTried.current) {
      tapPending.current = true
      return
    }
    handoffTried.current = true
    depositIntentRef.current = false
    void enterPasskeyStep()
  }

  /**
   * The intro's last tap lands on the wallet. A reservation still owed its deposit is chased there
   * by the activation sheet, not by a step of the wizard. Only a hand-off that never got an
   * account falls back to the terms sheet, which carries the prompt and its retry.
   */
  const finishIntro = () => {
    const held = heldStep.current
    heldStep.current = undefined
    // A refusal or a claim error still owns the screen: it is the only place to act on it.
    if (held && held !== "allset" && held !== "pending") return setStepNow(held)
    if (passkeyEntry && !mock) {
      if (held || notReady()) {
        enterWhenReady.current = true
        setAwaitingEntry(true)
        return
      }
      // Settled with no account: the sheet that can ask again.
      if (!handoffDone()) {
        handoffTried.current = false
        setStepNow("terms")
        return
      }
    }
    finishOnboarding()
  }

  const leaveTerms = (wantsDeposit: boolean) => {
    depositIntentRef.current = wantsDeposit
    setStep("create")
    if (mock) return
    // The hand-off's hint, not a verdict: the authoritative waiver rides onboarding_completed.
    fireEvent("registration_terms_accepted", {
      fee_waived: freeHint,
      deposit_intent: wantsDeposit,
    })
    if (passkeyEntry) void enterPasskeyStep()
    else void createAccountStep()
  }

  /**
   * Claim the stashed paylink into this reservation (and burn the registration slice to its SIPA).
   * `account` is required when the signing account is not yet in the React context.
   */
  const consumeStashedPaylink = async (
    fragment: string,
    account?: SponsoredPaylinkDeps["account"],
  ) => {
    const deps = paylinkDepsRef.current
    const kit = paylinkKitRef.current
    const live: SponsoredPaylinkDeps | undefined = account
      ? deps
        ? { ...deps, account }
        : kit
        ? { ...kit, account }
        : undefined
      : deps
    if (!live) throw new Error("wallet is still starting, try again in a moment")
    setCreateBusyPhase("paylink")
    const link = await viewLink(live, fragment)
    const zkProof =
      link.flavor === "email"
        ? await obtainEmailClaimProof(live.account.getAddress(), {
            paylinkType: DEFAULT_CONTRACTS.paylinkEmail,
            commitment: link.commitment,
            email: link.email,
          })
        : undefined
    await claimSponsoredLink(live, fragment, undefined, zkProof, { fundRegistration: true })
    clearClaimStash(fragment)
  }

  /**
   * Route a claim outcome: custody completes the signup; pending is resumable, never failure copy.
   * A hand-off and a reduced (earned) schedule with no deposit intent both enter now — the campaign
   * already took the name — and the activation sheet on Home asks for a deposit still owed. Only a
   * signup that chose the deposit up front waits on the wizard's own pending step.
   *
   * A ticket-funded signup waits for the SIPA broadcast (the burn must target an address the
   * relayer can see), then reviews the payment split before the one batch that claims the link and
   * funds the registration. Every other reduced (earned) signup keeps its deferred broadcast and
   * enters the wallet at once when the user chose to deposit later, reminded to deposit the signed
   * total before the claim deadline.
   */
  const applyClaimOutcome = async (outcome: ClaimTagOutcome) => {
    oxideAccountRef.current = outcome.oxideAccount
    if (outcome.kind === "custody") {
      completeSignup(handle)
      return
    }
    let ticket = fromPaylink ? peekTicketSignup() : null
    if (ticket && !wireTermsFundTicket(outcome.claim.terms)) {
      if (!outcome.ticketUnavailable) {
        await abandonPendingRegistration()
        throw new Error(PAYLINK_TICKET_REFUSED_MESSAGE)
      }
      // Tickets paused before this one was redeemed: the account is set up at the signed price,
      // and the link stays stashed for an ordinary claim on Home.
      clearTicketSignup()
      ticket = null
      fireEvent("paylink_ticket_paused")
      setInlineNotice(PAYLINK_TICKET_PAUSED_MESSAGE)
    }
    saveRegistrationTerms({
      account: outcome.oxideAccount,
      tag: handle,
      deadline: Number(outcome.claim.deadline),
      ...(outcome.claim.terms
        ? { fee: outcome.claim.terms.fee, minDeposit: outcome.claim.terms.minDeposit }
        : {}),
      feeWaived: outcome.claim.terms?.reduced === true,
      earnedExpected: expectedEarned,
      ...(ticket ? { paylinkFunded: true, paylinkId: linkIdentity(ticket.fragment) } : {}),
    })
    setFreshClaim(outcome.claim)
    if (ticket) {
      if (outcome.broadcastDone) {
        setCreateBusyPhase("broadcast")
        void outcome.startBroadcast?.()
        const published = await outcome.broadcastDone
        if (!published) {
          setStep("pending")
          if (keysRef.current && !autoRebroadcastRef.current) {
            autoRebroadcastRef.current = true
            void retryClaim()
          }
          return
        }
      }
      setStep("review")
      return
    }
    watchDeferredBroadcast(outcome.broadcastDone, outcome.startBroadcast)
    if (passkeyEntry || (outcome.claim.terms?.reduced === true && !depositIntentRef.current)) {
      await finishSignup(handle)
      return
    }
    // The pending step shows the address and reports its publishing, so the proof runs now.
    startDeferredBroadcast()
    setStep("pending")
  }

  /**
   * The review step's Claim: the one batch that claims the link into this account and burns the
   * registration slice to the SIPA, then wallet entry. Keys are still in memory from the ceremony.
   */
  const claimReviewedPaylink = () => {
    const ticket = peekTicketSignup()
    if (!ticket || paylinkSettleRef.current) return
    paylinkSettleRef.current = true
    setModalError(undefined)
    setModalBusy(true)
    const gen = ++opGen.current
    void (async () => {
      try {
        await consumeStashedPaylink(ticket.fragment, keysRef.current?.account)
        await finishSignup(handle)
      } catch (err) {
        paylinkSettleRef.current = false
        fireEvent("action_failed", { action: "paylink_settle", code: failureCode(err) })
        if (gen !== opGen.current) return
        setModalError(claimErrorMessage(err, { tag: handle, until: untilHint }))
      } finally {
        if (gen === opGen.current) setModalBusy(false)
      }
    })()
  }

  /** The review step's Close: enter with the payment unclaimed; Home leads back to the claim. */
  const closeReview = () => {
    if (modalBusy) return
    void finishSignup(handle)
  }

  /**
   * The deferred broadcast behind the revealed address: the address-side spinner runs until it
   * lands, and one silent in-session retry (keys are still in memory, no prompt) covers a
   * transient failure before the manual pill takes over.
   */
  const broadcastDoneRef = useRef<Promise<boolean> | undefined>(undefined)
  /** A deferred broadcast not yet proving: the screen starts it at the moment it picks. */
  const startBroadcastRef = useRef<(() => Promise<boolean>) | undefined>(undefined)
  const startDeferredBroadcast = () => {
    const start = startBroadcastRef.current
    if (!start) return
    startBroadcastRef.current = undefined
    setBroadcastInFlight(true)
    void start()
  }
  // Leaving the screen by any route starts it too: the proof must not wait on a page that is gone.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reads a ref and a stable setter
  useEffect(() => () => startDeferredBroadcast(), [])
  const watchDeferredBroadcast = (done?: Promise<boolean>, start?: () => Promise<boolean>) => {
    if (!done) return
    broadcastDoneRef.current = done
    // Without a start it is already proving; with one, it proves from the moment the screen picks.
    if (start) startBroadcastRef.current = start
    else setBroadcastInFlight(true)
    const settled = () => {
      if (broadcastDoneRef.current === done) broadcastDoneRef.current = undefined
      setBroadcastInFlight(false)
    }
    void done.then((ok) => {
      settled()
      if (ok || !keysRef.current || autoRebroadcastRef.current) return
      autoRebroadcastRef.current = true
      void retryClaim()
    }, settled)
  }

  /**
   * Claim retry. A cancel mid-flight only stops the spinner: the op has no
   * client-side abort, so a submission that lands anyway still routes to the
   * true outcome — the tag IS claimed, and hiding that would strand it.
   */
  const claimTagStep = async () => {
    setModalError(undefined)
    if (mock) return mockAdvance("allset")
    const keys = keysRef.current
    if (!keys) {
      setStep("create")
      return
    }
    const gen = ++opGen.current
    setModalBusy(true)
    try {
      if (resumeTicketWithKeys(keys)) return
      await applyClaimOutcome(await claimWithAnalytics(keys))
    } catch (err) {
      fireEvent("action_failed", { action: "claim_tag", code: failureCode(err) })
      if (gen !== opGen.current) return
      if (!steerAfterNameRefusal(err)) {
        setModalError(claimErrorMessage(err, { tag: handle, until: untilHint }))
        setStep("claim")
      }
    } finally {
      if (gen === opGen.current) setModalBusy(false)
    }
  }

  const cancelModalOp = () => {
    if (adoptingRef.current) return
    markAttempts("userCancelled", true)
    // Before a device is chosen, the gate rejects without starting the browser ceremony or claim.
    // Return to terms so the user can close the sheet and choose another name.
    if (step === "create" && createBusyPhase === "passkey" && gateState.kind !== "idle") {
      setStep("terms")
    }
    abandonOp()
    cancelGate()
    setModalBusy(false)
    setCreateBusyPhase("passkey")
  }

  /** Reloaded-tab completion: the record carries the identity and no wizard step remains. */
  const enterWithRecordIdentity = (rec: PendingRegistrationRecord) => {
    saveWalletIdentity({
      handle: rec.tag,
      address: rec.l2Address,
      claimedAt: Date.now(),
      ...(rec.phase !== "confirmed" ? { pending: true } : {}),
    })
    // All navigations in this screen replace: onboarding panes must never be back targets once in
    // the wallet (useBack pops history), and a pushed /enter hop would keep /claim behind it.
    // A deposit grants access, but cannot recreate missing passkey metadata. Recover the
    // existing account instead of sending it to WalletGate, which bounces it back to /claim.
    if (!loadOnboardedIdentity()) go(`/enter?handle=${encodeURIComponent(rec.tag)}`)
    else intoWallet()
  }

  /** Back to the invitation page, dropping a `/claim/:handle` pin so the input is editable. */
  const steerToInvite = (notice?: InviteNotice) => {
    // Every way back to the invitation ends what the sheet was running: no gate waiting behind it,
    // no adoption still short of its keys, and no refusal from the last attempt hiding the next
    // one's actions.
    abandonOp()
    cancelGate()
    setModalBusy(false)
    setCreateBusyPhase("passkey")
    setModalRefusal(undefined)
    // Nothing to say and nothing to show: the campaign owns signup. A notice has to land
    // somewhere, so the step stays to carry it.
    if (!notice && leaveForCampaign()) return
    setInviteNotice(notice)
    setStep(fromPaylink ? "tag" : "invite")
    if (pathname.startsWith("/claim")) go(resuming ? "/claim?resume=1" : "/claim")
  }
  /** The user's own close of a sheet: back to the invitation, the running attempt cancelled. */
  const closeToInvite = () => {
    markAttempts("userCancelled")
    steerToInvite()
  }

  const takenNotice = (tag: string): InviteNotice => ({ kind: "taken", handle: tag })

  /**
   * The name went to someone else: nothing of this attempt carries over. Keys and identity leave
   * the session so the next tag starts from a fresh passkey, and the landing says what happened.
   */
  const lossHandledFor = useRef<string | undefined>(undefined)
  /**
   * A name the server refused sends the user back to the field with the reason, keys still in
   * hand: the retry modal would resubmit the same name, which reaches the same refusal.
   */
  const steerAfterNameRefusal = (err: unknown): boolean => {
    if (!(err instanceof NameTakenError)) return false
    setModalBusy(false)
    markAttempts("superseded")
    steerToInvite({ kind: "error", message: claimErrorMessage(err) })
    return true
  }

  const restartAfterLoss = (tag: string) => {
    // The direct path and the store listener can both see the same loss; one restart is enough.
    if (lossHandledFor.current === tag) return
    lossHandledFor.current = tag
    markAttempts("superseded")
    abandonOp()
    setModalBusy(false)
    keysRef.current = undefined
    recoveredRef.current = false
    void signOut({ keepPointers: true }).catch((e) => showReportableError(e, "onboarding:sign-out"))
    const account = oxideAccountRef.current
    if (account && !registrationTermsAreInUse(account, tag)) clearRegistrationTerms(account, tag)
    steerToInvite(takenNotice(tag))
  }
  const failedNotice: InviteNotice = {
    kind: "error",
    message: "The claim could not be completed. Activate account to try again.",
  }

  /**
   * Route a tick outcome for the record the tick was pinned to. Only the machine's own typed
   * outcome may write an identity; a close observed via the pinned record's phase is routed
   * fail-closed — phase `confirmed` covers needs_recovery too, so that branch discriminates on
   * identity presence and never fabricates one. Terminal phase is consulted before any
   * stored-hash success heuristic. Returns false while the registration is still pending.
   */
  const routeSettledOutcome = (
    outcome: OxideResumeOutcome,
    pinned: PendingRegistrationRecord,
  ): boolean => {
    if (outcome === "needs_recovery") {
      go("/enter")
      return true
    }
    if (outcome === "taken") {
      restartAfterLoss(pinned.tag)
      return true
    }
    if (outcome === "failed") {
      markAttempts("superseded")
      steerToInvite(failedNotice)
      return true
    }
    const latest = getPendingStore().get(pinned.account)
    if (outcome === "confirmed") {
      if (keysRef.current && !recoveredRef.current) completeSignup(handle)
      else enterWithRecordIdentity(latest ?? pinned)
      return true
    }
    if (latest?.phase === "failed_taken") {
      restartAfterLoss(pinned.tag)
      return true
    }
    if (latest?.phase === "failed_terminal") {
      markAttempts("superseded")
      steerToInvite(failedNotice)
      return true
    }
    if (latest?.phase === "confirmed") {
      const identity = loadWalletIdentity()
      if (identity && identity.handle === latest.tag) intoWallet()
      else go("/enter")
      return true
    }
    return false
  }

  /**
   * The forced resume tick — the machine decides between detection, in-window replay, and
   * re-sign (e.g. a reverted op from an expired NameClaim deadline requesting a fresh one); the
   * UI never destroys the record's custody bookmarks. Sign-deps stay lazy: the machine invokes
   * them only when a tick actually reaches the re-sign branch, and only a test-mode
   * account-service can satisfy the gate today (see `buildRetrySignDeps`).
   */
  const forcedTick = async (rec: PendingRegistrationRecord) => {
    setBusyStage("checking")
    const deps = await buildWebDetectionDeps(config, {
      ...(obsidionWallet
        ? { broadcastSeen: (r) => registrationBroadcastSeen(r, config, obsidionWallet) }
        : {}),
      getSignDeps: async () => {
        if (!keysRef.current) return null
        const signDeps = await buildRetrySignDeps(rec.tag, keysRef.current, config, obsidionWallet)
        // A re-issued claim carries a new deadline (and maybe a waiver); the terms shown follow it.
        // A paylink-funded signup keeps its link either way: fundable, the continuation goes on;
        // not, the link is blocked on this registration until a later quote waives the tag again
        // or the registration is abandoned. The machine reads such a claim as ordinary, so the
        // refusal is kept aside for the tick to report.
        const { accountService } = signDeps
        return {
          ...signDeps,
          accountService: {
            signDomain: async (...args: Parameters<typeof accountService.signDomain>) => {
              const claim = await accountService.signDomain(...args)
              if (rememberReissuedClaim(rec, claim).ticketRefused) renewalRefusedRef.current = true
              return claim
            },
          },
        }
      },
    })
    const outcome = await runDetectionTick(deps, {
      force: true,
      expectedRecord: { account: rec.account, nameHash: rec.nameHash },
    })
    if (routeSettledOutcome(outcome, rec)) return
    if (renewalRefusedRef.current) {
      renewalRefusedRef.current = false
      setInlineNotice(PAYLINK_TICKET_REFUSED_MESSAGE)
    }
    setNowMs(Date.now())
    setLastCheckedAt(Date.now())
  }

  /**
   * Primary recovery: reuse the passkey when this tab holds no in-memory keys (its own
   * user-activation window, verified against the record's l2Address before anything commits),
   * then a forced tick over the open record.
   */
  const retryClaim = () => {
    // Guarded BEFORE run: a second click must not toggle the shared busy state off mid-flight.
    const rec = currentRegistration()
    if (!rec || retryInFlight.current) return
    retryInFlight.current = true
    return run(
      async () => {
        try {
          setInlineNotice(undefined)
          setPendingRefusal(undefined)
          if (!keysRef.current) {
            if (!obsidionWallet) throw new Error("wallet not ready — try again in a moment")
            setBusyStage("passkey")
            let keys: OnboardingKeys
            const previousStorageId = getActiveStorageId()
            try {
              const signal = startOp()
              keys = await passkeyAttempt(REUSE_PASSKEY, opGen.current, (own) =>
                reusePasskeyAccount(
                  obsidionWallet,
                  rec.l2Address,
                  fromPaylink && resumingTicket
                    ? { credentialId: ticketAttempt.credentialId }
                    : passkeyHints,
                  gate,
                  signal,
                  own,
                ),
              )
            } catch (err) {
              if (isGateCancelled(err)) return
              if (err instanceof PasskeyMismatchError) {
                setInlineNotice(
                  "That isn't the passkey this claim was started with — try again with the passkey you signed up with.",
                )
                return
              }
              if (
                err instanceof Error &&
                (err.name === "NotAllowedError" || err.name === "AbortError")
              ) {
                setInlineNotice(
                  "Couldn't find your passkey on this device — use the device you signed up on, or check status here.",
                )
                return
              }
              if (isPasskeyPolicyError(err)) {
                fireEvent("action_failed", { action: "pending_retry", code: failureCode(err) })
                setPendingRefusal({ name: err.name, message: err.message })
                return
              }
              throw err
            }
            if (reloadIfSessionSwitched(previousStorageId, rec.l2Address)) return
            setObsidionAccount(keys.account)
            keysRef.current = keys
            addressRef.current = keys.account.getAddress().toString()
            recoveredRef.current = true
          }
          // An issued address may already have been paid, even before local detection catches up.
          // Resume its committed payment; never replace it to satisfy a new campaign quote.
          await forcedTick(rec)
        } finally {
          retryInFlight.current = false
          setBusyStage(undefined)
        }
      },
      "pending_retry",
      "registration:deposit",
    )
  }

  /**
   * An existing reservation plus a stashed paylink: claim the link into that SIPA instead of
   * asking for an L1 send. Recovers the passkey when this tab has no keys (the click is the
   * WebAuthn gesture).
   */
  const settlePendingPaylink = () => {
    const rec = record
    if (!rec || rec.phase !== "awaiting_deposit" || paylinkSettleRef.current) return
    // Decided at the click, not the render: lapsed terms, an address still unpublished or a burn
    // already out are sent to their own step before the batch spends the note.
    const ticket = ticketActivation(
      rec,
      loadRegistrationTerms(rec.account, rec.tag),
      getWithdrawalStore().list(),
    )
    if (!ticket) return
    if (ticket.state !== "ready") {
      setInlineNotice(ticketHoldNotice(ticket.state, rec.tag))
      return
    }
    const fragment = ticket.stash.fragment
    paylinkSettleRef.current = true
    return run(
      async () => {
        try {
          setInlineNotice(undefined)
          if (!keysRef.current && (!paylinkDepsRef.current || fromPaylink)) {
            if (!obsidionWallet) throw new Error("wallet is still starting, try again in a moment")
            setBusyStage("passkey")
            const previousStorageId = getActiveStorageId()
            const keys = await passkeyAttempt(REUSE_PASSKEY, opGen.current, (own) =>
              reusePasskeyAccount(
                obsidionWallet,
                rec.l2Address,
                fromPaylink && resumingTicket
                  ? { credentialId: ticketAttempt.credentialId }
                  : passkeyHints,
                gate,
                undefined,
                own,
              ),
            )
            if (reloadIfSessionSwitched(previousStorageId, rec.l2Address)) return
            setObsidionAccount(keys.account)
            keysRef.current = keys
            addressRef.current = keys.account.getAddress().toString()
          }
          if (!addressRef.current) addressRef.current = rec.l2Address
          await consumeStashedPaylink(fragment, keysRef.current?.account)
          await finishSignup(rec.tag)
        } catch (err) {
          paylinkSettleRef.current = false
          if (isGateCancelled(err)) return
          throw err
        } finally {
          setBusyStage(undefined)
        }
      },
      "paylink_settle",
      "paylink:claim",
    )
  }

  /**
   * The signed quote ran out before any deposit. A name the registry already shows as someone
   * else's is a loss; otherwise the record is marked un-broadcast so the forced tick re-signs a
   * fresh claim (the claim server lets the same key take over its own lapsed reservation) and
   * re-publishes the same address. A reservation another key holds surfaces as `taken` from that tick.
   */
  const refreshExpiredQuote = () => {
    const rec = currentRegistration()
    if (!rec || retryInFlight.current) return
    return run(
      async () => {
        setInlineNotice(undefined)
        setBusyStage("checking")
        const status = await getClaimStatus(rec.tag)
        if (status === "claimed") {
          await getPendingStore().close(rec.account, "failed_taken")
          restartAfterLoss(rec.tag)
          return
        }
        await getPendingStore().upsert(rec.account, { broadcast: false })
      },
      "reregister_check",
      "registration:deposit",
    )?.then(() => {
      if (currentRegistration()?.broadcast === false) return retryClaim()
    })
  }

  /** Secondary: a forced detection tick (no sign half) settles what the chain and bundler know. */
  const shouldStayInRecovery = (pending: PendingRegistrationRecord) =>
    recoveryVisit &&
    pending.phase === "funded" &&
    (hasDepositAdmission(pending) || pending.replaced?.refunded === true)

  // The Check status pill and the auto-tick are also the way back to a chain read that gave up.
  // `chainReadPending` is a ref so each press reads the current value, not the one at build time.
  const [readAttempt, setReadAttempt] = useState(0)
  const chainReadPending = useRef(false)
  const retryReads = useCallback(() => setReadAttempt((attempt) => attempt + 1), [])

  const checkPendingStatus = () => {
    if (chainReadPending.current) setReadAttempt((attempt) => attempt + 1)
    // The pin is captured at click time — deps construction awaits network work, and a record
    // that became current meanwhile must not be driven by this stale click.
    const rec = currentRegistration()
    if (!rec) return
    return run(
      async () => {
        const outcome = await runDetectionTick(await buildWebDetectionDeps(config), {
          force: true,
          expectedRecord: { account: rec.account, nameHash: rec.nameHash },
        })
        if (routeSettledOutcome(outcome, rec)) return
        const latest = getPendingStore().get(rec.account)
        // Deposit landed: the wizard can end — a reloaded tab enters on the record's identity.
        if (latest && hasCustody(latest) && !shouldStayInRecovery(latest)) {
          if (keysRef.current && !recoveredRef.current) {
            completeSignup(handle)
            return
          }
          enterWithRecordIdentity(latest)
          return
        }
        setNowMs(Date.now())
        setLastCheckedAt(Date.now())
      },
      "check_pending",
      "registration:deposit",
    )
  }

  // Background closes (the detection loop or a concurrent tick) land here; our own tick routes
  // first, and the step change clears the settle timer. `confirmed` covers needs_recovery too, so
  // without wizard keys the branch discriminates on identity presence — never a fabricated one.
  // Instant access (E4, registration-fee.md Campaign): `funded` enters exactly like `confirmed` — a
  // deposit above the minimum activates the moment it's seen, without waiting for the relayer's
  // sweep. Skipped in a dev preview (`mock`), which must never navigate the screen it demonstrates.
  useEffect(() => {
    if (step !== "pending" || !record || mock) return
    if (record.sweptAt !== undefined) {
      reportRegistrationDepositSwept(
        record.account,
        record.sweptAt - (record.fundedAt ?? record.startTime),
      )
    }
    // A record that closed while the retry waited at the phone steps needs no ceremony any more; a
    // retry past its prompt finishes, and its keys reach the wallet the record now enters.
    if (record.phase !== "awaiting_deposit") {
      markAttempts("superseded")
      dismissGate()
    }
    if (record.phase === "failed_taken") {
      restartAfterLoss(record.tag)
      return
    }
    if (record.phase === "failed_terminal") {
      steerToInvite(failedNotice)
      return
    }
    if (record.phase !== "confirmed" && record.phase !== "funded") return
    if (shouldStayInRecovery(record)) return
    if (keysRef.current && !recoveredRef.current) {
      completeSignup(handle)
      return
    }
    if (record.phase === "funded") {
      enterWithRecordIdentity(record)
      return
    }
    const timer = setTimeout(() => {
      const identity = loadWalletIdentity()
      if (identity && identity.handle === record.tag) intoWallet()
      else go("/enter")
    }, CONFIRM_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [step, record, navigate, next, mock, recoveryVisit])

  // Coarse clock behind the urgency copy and the feedback line's relative timestamp.
  useEffect(() => {
    if (step !== "pending") return
    const timer = setInterval(() => setNowMs(Date.now()), URGENCY_TICK_MS)
    return () => clearInterval(timer)
  }, [step])

  /**
   * The single exit from signup into the wallet. Consent is asked here and nowhere earlier: by
   * this point the account exists, so the question lands on someone who has finished rather than
   * over the page they arrived on. Everything the gate would have covered has already run, so a
   * grant here starts reporting from the wallet onward, not from onboarding.
   */
  const finishOnboarding = () => (asked ? intoWallet() : setConsentPending(true))

  // "All set!" holds briefly, then the carousel — except embedded surfaces (the /request pane),
  // which return straight to their flow instead of hijacking it with the carousel. Either way the
  // next thing after it is the exit above.
  useEffect(() => {
    if (step !== "allset") return
    const timer = setTimeout(() => {
      if (embedded) finishOnboarding()
      else setStep("carousel")
    }, ALL_SET_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- finishOnboarding is stable per render
  }, [step, embedded, next, asked])

  // The whole pending surface pins the record's tag; the typed/route handle is only a fallback.
  const pendingTag = record?.tag ?? handle
  /**
   * This browser has completed onboarding — for this name or any other — so the wallet is already
   * theirs to open: the sheet reports what the name still owes, it does not hold anyone. Closing it
   * must never land on the invitation, which is the signup for someone with no account: that is the
   * loop where a passkey is touched, the sheet appears, and closing it returns to /claim.
   */
  const alreadyEntered = loadOnboardedIdentity() !== null
  const wrongChain = record !== null && record.l1ChainId !== config.l1ChainId
  const openPending =
    record !== null && (record.phase === "awaiting_deposit" || record.phase === "funded")
  const custodyHeld = openPending && hasCustody(record)
  const awaitingDeposit = openPending && record.phase === "awaiting_deposit"
  const pendingUrgent =
    openPending &&
    (custodyHeld || !record.broadcast) &&
    nowMs - record.startTime > PENDING_URGENCY_MS
  // The deadline and signed schedule outlive the in-memory claim through the persisted terms, so a
  // reload still shows them. A fresh claim outranks the stored copy of one.
  const terms = useRegistrationTerms(record?.account, record?.tag)
  const depositAdmitted = useDepositAdmission(record)
  const refunded = useRegistrationRefunded(record)
  // What this address replaced, off its own record: a refunded predecessor, and whether one took
  // the account's one-shot broadcast, in which case only a manual sweep finishes this one.
  const refundedFrom = record?.replaced?.refunded ? record.replaced.sipaAddress : undefined
  const broadcastSpent = record?.replaced?.broadcastSpent === true
  const readChain = (step === "terms" || step === "pending") && !mock
  const readRelayerFee = useDepositSkim(config, readChain, readAttempt)
  const relayerFee = mock ? mock.fee : readRelayerFee
  const restartAfterRefund = async (keys: OnboardingKeys) => {
    if (!record) return
    keysRef.current = keys
    addressRef.current = record.l2Address
    recoveredRef.current = true
    setObsidionAccount(keys.account)
    depositIntentRef.current = true
    await applyClaimOutcome(
      await claimTag(record.tag, keys, config, obsidionWallet, undefined, true, record),
    )
  }
  const replaceAtEarnedPrice = async (keys: OnboardingKeys) => {
    if (!record) return
    // A broadcast still proving may yet take the rail; whether it did decides how the replacement
    // registers, so it settles first and the record is re-read.
    await broadcastDoneRef.current
    const current = getPendingStore().get(record.account)
    if (!current) return
    await assertRegistrationUnfunded(current, config)
    keysRef.current = keys
    addressRef.current = current.l2Address
    recoveredRef.current = true
    setObsidionAccount(keys.account)
    depositIntentRef.current = true
    try {
      await applyClaimOutcome(
        await claimTag(
          current.tag,
          keys,
          config,
          obsidionWallet,
          undefined,
          true,
          undefined,
          current,
        ),
      )
    } catch (err) {
      if (!(err instanceof NameTakenError)) throw err
      await getPendingStore().close(current.account, "failed_taken")
      restartAfterLoss(current.tag)
    }
  }
  const expectedEarned = freeHint || terms?.earnedExpected === true || depositAdmitted
  useEffect(() => {
    if (!freeHint || !record) return
    const saved = loadRegistrationTerms(record.account, record.tag)
    if (saved?.earnedExpected) return
    // The hint records an expectation, never a schedule: a waiver is the signature's to name.
    saveRegistrationTerms({
      account: record.account,
      tag: record.tag,
      deadline: 0,
      ...saved,
      earnedExpected: true,
    })
  }, [freeHint, record])
  const signedTerms = freshClaim?.terms ?? terms
  // The signed quote is the waiver's authority: the live claim, else the copy stored at claim time.
  // A reload has neither, and "no quote" must never read as "you pay" — the hand-off's hint is the
  // last thing standing, and a campaign link that promised a free tag still says so. A stored
  // record without a signed schedule (an expectation or deposit stamp) is not a quote either.
  const signedWaiver =
    freshClaim?.terms !== undefined
      ? freshClaim.terms.reduced === true
      : terms?.fee !== undefined
      ? terms.feeWaived === true
      : undefined
  // An unpriced quote cannot waive a fee it never priced.
  const feeWaived = !termsUnpriced(signedTerms) && (signedWaiver ?? expectedEarned)
  // A stamped record carries deadline 0: no deadline known, which is not a lapsed one.
  const claimDeadline = freshClaim ? Number(freshClaim.deadline) : terms?.deadline || undefined
  // The chain read is only worth making where the controller's immutables would price this
  // registration; elsewhere the prompt quotes the ask alone.
  const readChainSchedule = readChain && signedWithoutSchedule(terms)
  const chainAmounts = useRegistrationSchedule(
    config,
    readChainSchedule,
    readAttempt,
    readRelayerFee,
  )
  const quoteLive = terms?.deadline === undefined || terms.deadline * 1000 > nowMs
  const claimQuote = freshClaim?.terms && signedSchedule(freshClaim.terms)
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
  // A ticket-funded claim waiting on this tab: the link pays for the registration. The hosted
  // wizard owns the marker outright; a pending reservation only the link its terms name.
  const ticketStash = fromPaylink ? peekTicketSignup() : boundTicketSignup(terms)
  const paylinkStashed = ticketStash !== null
  // Bound but refused: no claim, no L1 send, the refusal on the sheet until renewed or abandoned.
  const ticketBlocked = paylinkStashed && terms?.paylinkBlocked === true
  const liveDeductions = useSweepDeductions(
    config,
    record?.depositToken,
    readChain || paylinkStashed,
    readAttempt,
  )
  const sweepDeductions = mock ? { fpcCut: mock.cut } : liveDeductions
  // Only a genuinely unread figure is pending: a deployment that priced nothing has answered.
  const chainReadPendingNow =
    (readChainSchedule && chainAmounts === undefined) ||
    sweepDeductions === undefined ||
    relayerFee === undefined
  useEffect(() => {
    chainReadPending.current = chainReadPendingNow
  }, [chainReadPendingNow])
  // The terms step has no Check pill, so the cadence is its only way back to a read that gave up.
  useChainReadRetry(chainReadPendingNow, retryReads)
  // The ticket signup's split: the signed schedule, else the one the service advertised before
  // the ticket was spent, priced at the portal's live cut on both legs. Unpriced until that cut
  // and the sweep fee are read; `covers` is the real check once the witness read the note.
  const ticketSchedule = ticketStash
    ? amounts ?? {
        fee: BigInt(ticketStash.schedule.fee),
        min: BigInt(ticketStash.schedule.minDeposit),
      }
    : undefined
  const paylinkQuote =
    ticketStash && ticketSchedule && sweepDeductions !== undefined
      ? paylinkSignupQuote({
          ...(ticketStash.amount !== undefined ? { paylink: BigInt(ticketStash.amount) } : {}),
          schedule: ticketSchedule,
          cuts: { withdrawalCut: sweepDeductions.fpcCut, depositCut: sweepDeductions.fpcCut },
          sweepFee: relayerFee,
        })
      : undefined
  const chainLabel = depositChainLabel(config)
  const earnedAskLabel = formatDepositDue(
    askedTotal("earned_tag"),
    tokenDecimalsForNetwork(config.network),
  )
  // Fast L1 feedback: the deposit shows as received the moment it lands, and one forced tick
  // promotes the record right away instead of waiting for the detection cadence. A funded record
  // is watched too, while unswept: its refund action reads what the address holds now.
  const watchedDeposit = useDepositWatch(
    config,
    openPending && !wrongChain && !mock && record && canManualRegistrationSweep(record)
      ? { token: record.depositToken as Address, address: record.sipaAddress as Address }
      : null,
  )
  // The preview seeds what the address holds, so its panel, celebration and title agree.
  const depositSeen = mock ? mock.received ?? 0n : watchedDeposit
  // Seen here first: the rail carries it from now on.
  useEffect(() => {
    if (!mock && record && depositSeen > 0n) {
      void noteRegistrationDepositSeen(record.sipaAddress, depositSeen)
    }
  }, [mock, record, depositSeen])
  const depositSeenAny = awaitingDeposit && depositSeen > 0n
  // Only an earned tag has a cheaper price to restart at; a paid deposit is watched, not refunded.
  const needsRefund =
    record !== null &&
    expectedEarned &&
    registrationNeedsRefund(
      record,
      terms,
      depositAdmitted || refunded || depositSeenAny || record.fundedAt !== undefined,
      relayerFee,
      sweepDeductions?.fpcCut,
    )
  // `quoteMismatch` below is what tells the user when a waived tag ends up quoted as standard.
  const quotedKind = quotedRegistrationKind(feeWaived, amounts, sweepDeductions?.fpcCut)
  const pendingQuote =
    quotedKind === undefined
      ? undefined
      : registrationQuote(amounts, quotedKind, sweepDeductions?.fpcCut)
  // Celebration is reserved for a deposit the chain would accept; a shorter one keeps the panel,
  // which prices the top-up to the asked figure. An unread floor is no verdict, so the panel holds.
  const depositReceived =
    depositSeenAny && pendingQuote?.floor !== undefined && depositSeen >= pendingQuote.floor
  const nudgedRef = useRef(false)
  useEffect(() => {
    if (!depositSeenAny || !record || mock) return
    reportRegistrationDepositFunded(record.sipaAddress, Date.now() - record.startTime)
    recordRegistrationDeposit(record.account, record.tag, depositSeen)
    if (nudgedRef.current || busy) return
    nudgedRef.current = true
    void checkPendingStatus()
  }, [depositSeenAny, depositSeen, record, busy, mock])
  // A deposit covering the campaign's promised total buys pending access even if the signer
  // returned a higher quote. Keep the original terms and phase for sweep/recovery inside the app.
  useEffect(() => {
    if (step !== "pending" || !expectedEarned || !record || wrongChain || mock) return
    if (
      !hasDepositAdmission(record) &&
      !recordDepositAdmission(record, depositSeen, sweepDeductions?.fpcCut)
    )
      return
    if (recoveryVisit) return
    if (keysRef.current && !recoveredRef.current) completeSignup(record.tag)
    else enterWithRecordIdentity(record)
  }, [
    step,
    expectedEarned,
    record,
    wrongChain,
    mock,
    depositSeen,
    recoveryVisit,
    sweepDeductions?.fpcCut,
  ])

  // The step checks itself: the same tick the Check status pill runs, every AUTO_CHECK_MS while
  // nothing else is running, so a sweep or confirmation is noticed without a click.
  const busyRef = useRef(busy)
  busyRef.current = busy
  useEffect(() => {
    if (step !== "pending" || !openPending || wrongChain || mock) return
    const timer = setInterval(() => {
      if (busyRef.current) return
      void checkPendingStatus()
    }, AUTO_CHECK_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- checkPendingStatus reads live state
  }, [step, openPending, wrongChain, mock])
  // Wall clock against the claim's chain-time deadline. Custody keeps the machine's own recovery.
  const quoteExpired =
    awaitingDeposit &&
    !depositAdmitted &&
    !custodyHeld &&
    !depositSeenAny &&
    claimDeadline !== undefined &&
    nowMs > claimDeadline * 1000
  // A signed quote the campaign's promise disagrees with: an address holding a deposit is watched,
  // never replaced. A record without a quote has nothing to disagree with.
  const signedQuote = claimQuote ?? signedSchedule(terms)
  const earnedQuoteDiffers =
    expectedEarned &&
    signedQuote !== undefined &&
    (!feeWaived || floorExceedsAsk(signedQuote, "earned_tag", sweepDeductions?.fpcCut) === true)
  const quoteMismatch = earnedQuoteDiffers && !quoteExpired
  // An old-price address nothing ever reached has no deposit to watch or refund: the earned quote
  // replaces the address outright.
  const replaceUnfunded =
    earnedQuoteDiffers &&
    !needsRefund &&
    !depositAdmitted &&
    !depositSeenAny &&
    !custodyHeld &&
    awaitingDeposit &&
    record?.fundedAt === undefined
  const lapseReportedRef = useRef(false)
  useEffect(() => {
    if (!quoteExpired || lapseReportedRef.current || mock) return
    lapseReportedRef.current = true
    fireEvent("registration_lapsed", { phase: record?.phase ?? "none" })
  }, [quoteExpired, record, mock])
  const paylinkPending = paylinkStashed && awaitingDeposit && !wrongChain && !quoteExpired
  const pendingTitle = (() => {
    if (needsRefund && !wrongChain) return `Recover deposit for @${pendingTag}`
    if (depositAdmitted && !wrongChain) return `Deposit received for @${pendingTag}`
    if ((custodyHeld || depositReceived) && !wrongChain)
      return `Deposit received for @${pendingTag}`
    if (quoteExpired && !wrongChain) return `Refresh the deposit for @${pendingTag}`
    // A waived tag is being activated, not bought; a paid one is buying its way off the waitlist.
    // A paylink-funded reservation is claimed, not bought with an L1 send.
    if (awaitingDeposit && !wrongChain) {
      return paylinkStashed || feeWaived ? "Activate account" : "Get instant access"
    }
    return `Claiming @${pendingTag}…`
  })()
  const pendingBody = (() => {
    if (wrongChain) {
      return "This claim was started on a different network. Open the wallet on that network to finish it."
    }
    if (needsRefund) {
      return refunded
        ? "The original deposit was recovered. Request a new address at the earned price, then fund that address. Do not send more to the old address."
        : depositAdmitted
        ? "Your wallet is open. The old deposit address cannot use the earned price. Recover its funds before requesting a new address."
        : "The old deposit address cannot use the earned price. Recover its funds before requesting a new address. Do not send more to it."
    }
    if (depositAdmitted) {
      return "Your deposit opened the wallet. Registration is still pending. Check its status or retry if needed. Do not send another deposit."
    }
    if (pendingUrgent) {
      return `@${pendingTag} is taking longer than usual. It is still reserved and still being confirmed.`
    }
    if (custodyHeld || depositReceived) {
      return "Your deposit is in. The name is being confirmed on-chain and you can enter the wallet now."
    }
    if (replaceUnfunded) {
      return "The earned price differs from this registration's original quote. Nothing was sent to the original address, so request a new one at the earned price."
    }
    if (quoteMismatch) {
      return "The earned price differs from this registration's original quote. We are checking the existing deposit. Do not send another deposit."
    }
    if (quoteExpired) {
      return `The deposit amount for @${pendingTag} needs a refresh. Refresh it to get the current amount and deposit address.`
    }
    if (registrationsPaused) {
      return `@${pendingTag} is held for you. No deposit is needed right now.`
    }
    if (awaitingDeposit && paylinkStashed && record?.broadcast === false) {
      return `@${pendingTag} is reserved. Your deposit address is being published; the payment claims once it is.`
    }
    if (awaitingDeposit && paylinkStashed) {
      return `@${pendingTag} is reserved. This payment funds the account — confirm to claim it.`
    }
    if (awaitingDeposit) {
      return `@${pendingTag} is reserved for you. Send the deposit to the address below and the tag is yours when the deposit arrives on zk.money.`
    }
    return "Your claim is being confirmed. This can take a moment."
  })()
  // A claim the background driver cannot finish on its own: never published, escalated, or aged
  // past the point where waiting is the answer.
  const retryWarranted =
    openPending &&
    !wrongChain &&
    !quoteExpired &&
    !needsRefund &&
    !replaceUnfunded &&
    !broadcastSpent &&
    (!record.broadcast || isRegistrationEscalated(record, nowMs) || pendingUrgent)
  const checkNote = (() => {
    if (record === null) return undefined
    if (broadcastInFlight) return "Publishing your deposit address…"
    const minutes =
      lastCheckedAt === undefined ? undefined : Math.floor((nowMs - lastCheckedAt) / 60_000)
    return (
      <>
        {!busy &&
          minutes !== undefined &&
          `Checked ${minutes < 1 ? "just now" : `${minutes}m ago`} · `}
        <button
          type="button"
          className="zkm-btn-reset ww-send-to__link"
          aria-label="Check again"
          onClick={checkPendingStatus}
          disabled={busy}
        >
          {busy ? "Checking…" : "Check again"}
        </button>
        {retryWarranted && !pendingRefusal && (
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-send-to__link"
            onClick={retryClaim}
            disabled={busy}
          >
            {busy && busyStage ? BUSY_LABELS[busyStage] : "Retry"}
          </button>
        )}
      </>
    )
  })()
  const enterDepositLater = () => {
    if (!record) return
    if (keysRef.current) return void finishSignup(handle)
    // Record-only session (reloaded tab): no key to sign an admission check with, so entry
    // rides the cached grant or the paid skip; otherwise the line note explains the wait.
    if (registrationAdmits(record.phase, record.l2Address)) return enterWithRecordIdentity(record)
    setQueuedNote(waitlistNote())
  }
  /**
   * The way out of the deposit screen that abandons nothing: keys and identity leave this session
   * (the passkey, the record and the terms signed for it survive, so the watcher keeps running,
   * a paylink still bound to the record stays bound, and /enter or a later visit resumes), and the
   * invitation landing is back for another tag or another passkey.
   */
  const logOut = () => {
    markAttempts("userCancelled")
    abandonOp()
    setModalBusy(false)
    keysRef.current = undefined
    recoveredRef.current = false
    void signOut({ keepPointers: true }).catch((e) => showReportableError(e, "onboarding:sign-out"))
    if (record && !registrationTermsAreInUse(record.account, record.tag))
      clearRegistrationTerms(record.account, record.tag)
    steerToInvite()
  }
  // Rendered beside every terminal step, including the carousel, which returns early.
  const consentModal = consentPending ? (
    <AnalyticsConsentModal
      onChoose={(granted) => {
        setConsentPending(false)
        void (async () => {
          await setConsent(granted)
          await setAsked(true)
          fireEvent("onboarding_started", { has_claim_link: !!routeHandle, entry: entryCohort })
          intoWallet()
        })()
      }}
    />
  ) : null

  // Once reserved, the deposit gate is dismissible only with admission or a waiver.
  // Before the ceremony starts, anyone can return to the invitation and choose another tag.
  const gateDismissible = hasCachedAdmission() || expectedEarned || feeWaived || Boolean(mock?.free)
  // The terms frame quotes the hand-off's hints; the claim after the passkey is what decides.
  const termsFree = expectedEarned || Boolean(mock?.free)
  const termsBusy = step === "create" && modalBusy
  // Cancel hides a spinner without aborting its request; only the initial terms gain a new exit.
  const termsDismissible = !termsBusy && (step === "terms" || gateDismissible)
  // `termsFree` steers copy only; the kind the total is quoted at comes from the signature.
  const termsKind = quotedKind
  const termsQuote =
    termsKind === undefined
      ? undefined
      : registrationQuote(amounts, termsKind, sweepDeductions?.fpcCut)
  const termsTotalLabel =
    termsQuote === undefined
      ? undefined
      : formatDepositDue(termsQuote.total, tokenDecimalsForNetwork(config.network))

  // The ceremony's own surface, shared by the terms sheet and the ticket signup's welcome step:
  // refusals and errors above, then the CTA or whatever the ceremony shows in its place.
  const termsNotices = (
    <>
      {step === "terms" && registrationsPaused && (
        <p className="ww-deposit-feedback" data-testid="registrations-paused">
          {REGISTRATIONS_PAUSED_NOTICE}
        </p>
      )}
      {fromPaylink && isTicketSignupCreating(ticketAttempt) && !termsBusy && (
        <p className="ww-invite-modal-error" role="alert">
          The previous attempt did not finish saving this signup. No ticket was redeemed. Creating
          another passkey starts a new account; the previous passkey may remain in your password
          manager.
        </p>
      )}
      {step === "create" && <IosFloorNotice />}
      {step === "create" && modalRefusal && (
        <PasskeyRefusal
          error={modalRefusal}
          onRetry={() => retryRef.current?.()}
          busy={modalBusy}
          testId="create-refused"
          retryTestId="create-retry"
          exits={
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-invite-pill"
              data-testid="create-start-over"
              onClick={logOut}
            >
              Start over
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
  const termsActions =
    termsBusy && gateState.kind === "awaiting-action" ? (
      <GateStep state={gateState} onCancel={cancelModalOp} />
    ) : termsBusy ? (
      <OnboardingSpinnerBody
        label={
          adopting
            ? "Finishing sign-in..."
            : createBusyPhase === "broadcast"
            ? "Publishing your deposit address..."
            : createBusyPhase === "paylink"
            ? "Claiming your payment..."
            : createBusyPhase === "claim"
            ? fromPaylink
              ? "Using your paylink..."
              : "Preparing deposit address..."
            : passkeyEntry || resumingTicket
            ? "Confirming with your passkey..."
            : "Creating your passkey..."
        }
        cancelLabel="Cancel"
        onCancel={adopting ? undefined : cancelModalOp}
      />
    ) : modalRefusal && !refusalFor(modalRefusal).retry ? null : (
      // A refusal another attempt cannot fix leaves only its exit.
      <div className="ww-deposit-actions">
        <PrimaryGradientButton
          title={
            fromPaylink
              ? isTicketSignupCreating(ticketAttempt)
                ? "Create another passkey"
                : resumingTicket
                ? "Continue with your passkey"
                : "Create account with passkey"
              : termsTotalLabel
              ? `Deposit ${termsTotalLabel}`
              : "Deposit to register"
          }
          isDisabled={!passkeysSupported()}
          onClick={() => {
            if (ticketFragment && isTicketSignupCreating(ticketAttempt)) {
              try {
                restartTicketSignupAccount(
                  config.rpId,
                  linkIdentity(ticketFragment),
                  ticketAttempt.attemptId,
                )
                setTicketAttempt(null)
              } catch (err) {
                try {
                  setTicketAttempt(readTicketAttempt())
                } catch {
                  /* Show the restart error. */
                }
                setModalError(enterErrorMessage(err))
                setStep("create")
                return
              }
            }
            leaveTerms(!fromPaylink)
          }}
        />
        {termsFree && !fromPaylink && (
          <button
            type="button"
            className="zkm-btn-reset ww-deposit-actions__link"
            onClick={() => leaveTerms(false)}
            disabled={!passkeysSupported()}
          >
            I&apos;ll do this later
          </button>
        )}
      </div>
    )

  const modals = step !== "invite" && (
    // Close through the card's X only; outside clicks and Escape must leave onboarding open.
    <ModalFrame label="Account setup">
      {/* One frame from the terms through the ceremony + claim: the same sheet the address
          lands in, so nothing swaps out under the user mid-registration. */}
      {(step === "terms" || step === "create") &&
        (fromPaylink ? (
          <WelcomeStep
            tag={handle}
            resuming={resumingTicket}
            onClose={termsDismissible ? closeToInvite : undefined}
            notices={termsNotices}
            actions={termsActions}
          />
        ) : (
          <RegistrationSheet
            tag={handle}
            title={termsFree ? "Activate account" : "Get instant access"}
            deadline={untilHint}
            onClose={termsDismissible ? closeToInvite : undefined}
            // One thing at a time, as on the pending step: the terms stand aside while the passkey
            // runs, and come back under the deposit address the claim returns.
            payment={
              step === "create" || registrationsPaused
                ? undefined
                : {
                    chainLabel,
                    total: termsQuote?.total,
                    fee: termsQuote?.fee,
                    sweepFee: relayerFee,
                    fpcCut: sweepDeductions?.fpcCut,
                    floor: termsQuote?.floor,
                    scheduleUnavailable,
                    kind: termsKind ?? registrationKind(termsFree),
                    tokenSymbol: mock?.tokenSymbol ?? WALLET_TOKEN_SYMBOL,
                    fundingAssets: fundingAssetsLabel(config.network),
                    tokenDecimals: tokenDecimalsForNetwork(config.network),
                  }
            }
            notices={termsNotices}
            actions={termsActions}
          />
        ))}
      {step === "tag" && (
        <ChooseTagStep
          initialHandle={handle || undefined}
          busy={inviteBusy}
          notice={inviteNotice}
          resuming={resuming || leftoverTag !== undefined}
          allowBlocked={hasRouteGrant}
          onClaim={(h) => void unlockAccess(h)}
          onLogIn={logIn}
          onCancel={cancelUnlock}
          onClose={() => onExit?.()}
        />
      )}
      {step === "review" && (
        <ClaimReviewStep
          quote={paylinkQuote}
          tokenSymbol={WALLET_TOKEN_SYMBOL}
          tokenDecimals={tokenDecimalsForNetwork(config.network)}
          memo={ticketStash?.memo}
          busy={modalBusy}
          error={modalError}
          onClaim={claimReviewedPaylink}
          onClose={closeReview}
        />
      )}
      {step === "claim" && (
        <ClaimTagModal
          handle={handle}
          busy={modalBusy}
          error={modalError}
          onClaim={() => void claimTagStep()}
          onCancel={cancelModalOp}
          onClose={closeToInvite}
        />
      )}
      {step === "allset" && <AllSetModal />}
      {step === "pending" && (
        <RegistrationSheet
          tag={pendingTag}
          title={pendingTitle}
          deadline={claimDeadline}
          note={pendingBody}
          onClose={
            depositAdmitted || refundedFrom || alreadyEntered
              ? intoWallet
              : gateDismissible || paylinkStashed
              ? closeToInvite
              : undefined
          }
          payment={
            // One "scan this code" at a time: the deposit address steps aside for the phone steps.
            // A stashed paylink funds the SIPA — never offer an L1 send beside it.
            !paylinkPending &&
            !ticketBlocked &&
            openPending &&
            !wrongChain &&
            !quoteExpired &&
            !depositAdmitted &&
            !needsRefund &&
            !quoteMismatch &&
            !registrationsPaused &&
            record &&
            gateState.kind !== "awaiting-action"
              ? {
                  address: record.sipaAddress as Address,
                  token: record.depositToken as Address,
                  chainId: record.l1ChainId,
                  chainLabel,
                  total: pendingQuote?.total,
                  fee: pendingQuote?.fee,
                  sweepFee: relayerFee,
                  fpcCut: sweepDeductions?.fpcCut,
                  floor: pendingQuote?.floor,
                  scheduleUnavailable,
                  kind: quotedKind ?? registrationKind(feeWaived),
                  tokenSymbol: mock?.tokenSymbol ?? WALLET_TOKEN_SYMBOL,
                  fundingAssets: fundingAssetsLabel(config.network),
                  tokenDecimals: tokenDecimalsForNetwork(config.network),
                  received: depositSeenAny ? depositSeen : undefined,
                  funded: record.phase === "funded",
                  checkNote,
                }
              : undefined
          }
          settlement={
            paylinkPending && !ticketBlocked
              ? {
                  quote: paylinkQuote,
                  tokenSymbol: WALLET_TOKEN_SYMBOL,
                  tokenDecimals: tokenDecimalsForNetwork(config.network),
                }
              : undefined
          }
          notices={
            <>
              {registrationsPaused && !wrongChain && (
                <>
                  <p className="ww-deposit-feedback" data-testid="registrations-paused">
                    {REGISTRATIONS_PAUSED_NOTICE}
                  </p>
                  <p className="ww-deposit-feedback">{checkNote}</p>
                </>
              )}
              {gateState.kind === "awaiting-action" && (
                <GateStep
                  state={gateState}
                  onCancel={() => {
                    markAttempts("userCancelled", true)
                    cancelGate()
                  }}
                />
              )}
              {(quoteMismatch || replaceUnfunded || depositAdmitted || needsRefund) &&
                record &&
                !wrongChain && (
                  <section aria-label="Existing deposit status">
                    <p>Original deposit address</p>
                    <code style={{ overflowWrap: "anywhere" }}>{record.sipaAddress}</code>
                    {depositSeenAny && (
                      <p>
                        Deposit detected:{" "}
                        {formatDepositSeen(depositSeen, tokenDecimalsForNetwork(config.network))}
                      </p>
                    )}
                    {custodyHeld && <p>Your deposit is being processed.</p>}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8 }}>
                      {checkNote}
                    </div>
                  </section>
                )}
              {(needsRefund || replaceUnfunded) && record && !wrongChain && (
                <RegistrationRefundAction
                  record={record}
                  unfunded={!needsRefund}
                  holdsFunds={depositSeen > 0n}
                  onRestart={needsRefund ? restartAfterRefund : replaceAtEarnedPrice}
                />
              )}
              {broadcastSpent && record && !wrongChain && canManualRegistrationSweep(record) && (
                <section aria-label="Complete earned registration">
                  <p>
                    {custodyHeld || depositReceived || depositAdmitted
                      ? "The new address has received your deposit. Choose Sweep manually to finish registration."
                      : `${
                          refundedFrom ? "The original deposit was refunded. " : ""
                        }Fund this new address with the earned ${earnedAskLabel} total, then choose Sweep manually to finish registration.`}{" "}
                    The connected Ethereum wallet pays gas.
                  </p>
                  <ManualSweepAction record={record} attempt={sweepAttempt} />
                </section>
              )}
              {paylinkPending && !ticketBlocked && (
                <p className="ww-deposit-feedback">{checkNote}</p>
              )}
              {pendingRefusal && (
                <PasskeyRefusal
                  error={pendingRefusal}
                  onRetry={() => void retryClaim()}
                  busy={busy}
                  testId="pending-refused"
                  retryTestId="pending-retry"
                  exits={
                    <button
                      type="button"
                      className="zkm-btn-reset zkm-pressable ww-invite-pill"
                      data-testid="pending-log-out"
                      onClick={logOut}
                      disabled={busy}
                    >
                      Log out
                    </button>
                  }
                />
              )}
              {inlineNotice && <span className="ww-deposit-feedback">{inlineNotice}</span>}
              {ticketBlocked && inlineNotice !== PAYLINK_TICKET_REFUSED_MESSAGE && (
                <span className="ww-deposit-feedback">{PAYLINK_TICKET_REFUSED_MESSAGE}</span>
              )}
              {queuedNote && <span className="ww-deposit-feedback">{queuedNote}</span>}
            </>
          }
          actions={
            <div className="ww-deposit-actions">
              {openPending && !wrongChain && (
                <>
                  {quoteExpired && !replaceUnfunded && (
                    <PrimaryGradientButton
                      title={busy && busyStage ? BUSY_LABELS[busyStage] : "Refresh deposit amount"}
                      isDisabled={busy}
                      onClick={refreshExpiredQuote}
                    />
                  )}
                  {paylinkPending && !ticketBlocked && busy && (
                    <OnboardingSpinnerBody
                      label={
                        busyStage === "passkey"
                          ? "Confirming with your passkey..."
                          : "Claiming your payment..."
                      }
                    />
                  )}
                  {paylinkPending && !ticketBlocked && !busy && (
                    <PrimaryGradientButton
                      title="Claim your payment"
                      isDisabled={
                        paylinkQuote === undefined ||
                        paylinkQuote.covers === false ||
                        record?.broadcast === false
                      }
                      onClick={() => void settlePendingPaylink()}
                    />
                  )}
                  {(depositAdmitted || refundedFrom) && (
                    <PrimaryGradientButton title="Back to wallet" onClick={intoWallet} />
                  )}
                  {!paylinkPending &&
                    !quoteExpired &&
                    awaitingDeposit &&
                    feeWaived &&
                    !quoteMismatch &&
                    !depositAdmitted && (
                      <PrimaryGradientButton
                        title="Enter now, deposit later"
                        isDisabled={busy}
                        onClick={enterDepositLater}
                      />
                    )}
                </>
              )}
              {/* A paid tag is mid-purchase: leaving strands it. A free or paylink-funded one can walk away. */}
              {(feeWaived || paylinkStashed) && (
                <button
                  type="button"
                  className="zkm-btn-reset ww-deposit-actions__link"
                  onClick={logOut}
                  disabled={busy}
                >
                  Log out
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
          <LostRegistrationNoticeCard onlyTag={passkeyEntry ? routeHandle : undefined} />
        </>
      )}
      <InvitationStep
        initialHandle={routeHandle ?? openRecord?.tag ?? undefined}
        busy={inviteBusy}
        header={inviteHeader}
        notice={step === "invite" ? inviteNotice : undefined}
        checkAvailability={step === "invite" && !passkeyEntry}
        allowBlocked={hasRouteGrant}
        resuming={resuming}
        onUnlock={(h) => void unlockAccess(h)}
        onLogIn={logIn}
        onCancelSignIn={cancelUnlock}
      />
    </>
  )

  if (embedded) {
    return (
      <>
        {invitation}
        {modals}
        {consentModal}
      </>
    )
  }
  if (step === "carousel") {
    return (
      <InvitationChrome topBar={false}>
        {awaitingEntry ? (
          <div className="ww-carousel" data-testid="handoff-entering">
            <OnboardingSpinnerBody label="Setting up your wallet..." />
          </div>
        ) : (
          <OnboardingCarousel
            handle={handle}
            onDone={finishIntro}
            onStart={passkeyEntry ? startHandoff : undefined}
          />
        )}
        {/* A laptop's ceremony holds for a tap it can only ask for on screen, and the intro is the
            whole screen here. The ask is the registration sheet, as on the create step, so it is a
            card on a backdrop and not steps drawn over the slide's text. */}
        {gateState.kind === "awaiting-action" && (
          <ModalFrame label="Account setup">
            <RegistrationSheet
              tag={handle}
              title="Confirm it's you"
              onClose={cancelModalOp}
              actions={<GateStep state={gateState} onCancel={cancelModalOp} />}
            />
          </ModalFrame>
        )}
        {consentModal}
      </InvitationChrome>
    )
  }
  return (
    <InvitationChrome>
      {invitation}
      {modals}
      {consentModal}
    </InvitationChrome>
  )
}
