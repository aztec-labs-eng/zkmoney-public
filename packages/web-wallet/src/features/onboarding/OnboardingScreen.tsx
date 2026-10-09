import { leavePage } from "../../platform/storage/walletStorage"
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
  depositOwed,
  fundsIn,
  isRegistrationEscalated,
  normalizeTag,
  TxInFlightError,
  useAccountContext,
  useAztecContext,
  useContractServiceContext,
  useConfigValue,
  type OxideResumeOutcome,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import { AUTH_TYPE, DEFAULT_CONTRACTS } from "@obsidion/sdk"
import { WALLET_TOKEN_SYMBOL, tokenDecimalsForNetwork } from "@obsidion/core/constants"
import type { NameClaimResponse, SignInRoute } from "@obsidion/core/types"
import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { mockOnboarding } from "../../dev/mockOnboarding"
import { showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent, lapTimer } from "../../lib/analytics"
import { reportHandoffAdopted } from "../../lib/handoffHealth"
import { passkeyTelemetry } from "../../lib/passkeyTelemetry"
import { useHoldEndpoints } from "../../ui/endpointsHold"
import { useAsyncAction, useNextRoute } from "../../ui/hooks"
import {
  checkAdmission,
  hasCachedAdmission,
  registrationAdmits,
  recordDepositAdmission,
  hasDepositAdmission,
  useDepositAdmission,
} from "../identity/admission"
import { oweCampaignClaimNotice } from "../identity/campaignClaimNotice"
import { isGateCancelled, routeForHints, useCeremonyGate } from "../identity/ceremonyGate"
import { IosFloorNotice } from "../identity/IosFloorNotice"
import {
  PasskeyRefusal,
  isPasskeyNotOffered,
  refusalFor,
  type RefusalState,
  type RouteRefusal,
} from "../identity/PasskeyRefusal"
import { GateStep, PasskeyWarn, PhoneSteps } from "../identity/PhoneSteps"
import { signOut } from "../identity/signOut"
import {
  PHONE_STEPS_COPY,
  currentDevicePosture,
  currentOpenInBrowserHref,
  inAppBrowserRefusal,
  isPasskeyPolicyError,
  passkeyWritten,
  type PasskeyAttemptContext,
  type PasskeyAttemptHandle,
  type PasskeyRequestScope,
  type PhoneReach,
} from "@obsidion/passkey-web"
import { statusForAttempt } from "../../platform/auth/passkeyAttemptScope"
import { InAppBrowserNotice } from "../identity/InAppBrowserNotice"
import { walletInAppUpFront } from "../identity/inAppUpFront"
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
  updateTicketSignup,
} from "../paylink/claimStash"
import { linkIdentity } from "../paylink/linkIdentity"
import { endClaim, startClaim } from "../paylink/runningClaims"
import { OperationHandOff } from "../operations/OperationHandOff"
import {
  beginTicketSignupAccount,
  completeTicketSignupAccount,
  isTicketSignupCreating,
  loadTicketSignupAccount,
  loadTicketSignupAttempt,
  restartTicketSignupAccount,
  saveTicketSignupAccount,
} from "../paylink/ticketSignupAccount"
import { reloadIfSessionSwitched, takeOnboardingResume } from "./sessionReload"
import {
  boundTicketSignup,
  pendingTicketRegistration,
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
import { useRegistrationSpeed } from "../paylink/registrationProverTip"
import { SpeedRow } from "../withdraw/speedChoice"
import { belowTicketThresholdCopy, ticketEligibility } from "../paylink/ticketThreshold"
import { getWithdrawalStore } from "../withdraw/withdrawGateway"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { getActiveCredentialId, getActiveStorageId } from "../../platform/storage/activeStorage"
import {
  buildRetrySignDeps,
  checkpointRegistrationTerms,
  claimTag,
  collectOnboardingKeys,
  adoptHandoff,
  getClaimStatus,
  nameGrantToken,
  NameTakenError,
  PasskeyMismatchError,
  CeremonyRequiredError,
  resolveHandoff,
  reusePasskeyAccount,
  type ClaimTagOutcome,
  type OnboardingKeys,
  type PasskeyHints,
} from "./oxideOnboarding"
import { clearNameGrant, scopeNameGrant } from "./nameGrant"
import { routeGrantIsCurrent } from "./nameAvailability"
import {
  abandonPendingRegistration,
  buildWebDetectionDeps,
  cacheConfirmedNameClaim,
  getPendingStore,
  hasCustody,
  registrationAddressPublished,
  registrationTermsAreInUse,
  runDetectionTick,
} from "./webRegistration"
import { activationPromptDismissed, openActivationPrompt } from "./activationPrompt"
import { noteRegistrationDepositSeen } from "./registrationRailSync"
import { useRegistrationStage } from "./openRegistration"
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
import {
  formatDepositDue,
  formatDepositSeen,
  formatTokenAmount,
  swapAssetsLabel,
} from "./steps/DepositTermsRows"
import { broadcastSettled, getBroadcastLedger } from "../broadcasts/broadcasts"
import { runUserFlow } from "../provingGate"
import { useOweRegistrationBroadcast } from "../broadcasts/useOweRegistrationBroadcast"
import { RegistrationSheet, type RegistrationCheck } from "./RegistrationSheet"
import {
  assertRegistrationUnfunded,
  registrationNeedsRefund,
  useRegistrationRefunded,
} from "./registrationQuoteRecovery"
import { RegistrationRefundAction } from "./RegistrationRefundAction"
import { ManualSweepAction } from "./RegistrationDepositDetailModal"
import { useSipaProcessing } from "../deposit/sipaProcessing"
import { depositTokensFor } from "../deposit/loadDepositFacts"
import { heldDepositLine } from "../deposit/processingCopy"
import { canManualRegistrationSweep } from "./registrationSweep"
import { InvitationStep, type InviteNotice } from "./steps/InvitationStep"
import { AllSetModal, ClaimTagModal } from "./steps/ClaimTagModal"
import { ChooseTagStep } from "./steps/ChooseTagStep"
import { PaylinkSignupRows } from "./steps/PaylinkSignupRows"
import { WelcomeStep } from "./steps/WelcomeStep"
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
  claimTerms,
  floorExceedsAsk,
  quotedRegistrationKind,
  registrationKind,
  registrationQuote,
  reservedUntil,
  commitRegistrationProverTip,
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
import { firstWalletEntry } from "./walletEntry"
import {
  reportRegistrationDepositFunded,
  reportRegistrationDepositSwept,
} from "./registrationFunnel"

function warnQuietCheck(err: unknown): undefined {
  console.warn("[onboarding] status check failed; the next one retries:", err)
  return undefined
}

type Step = "invite" | "tag" | "terms" | "create" | "claim" | "allset" | "entering" | "pending"

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
/** How long an earned-price replacement waits on the old address's broadcast. */
const REPLACE_SETTLE_MS = 60_000
// Proposed copy, pending review.
const REPLACE_WAITING_MESSAGE =
  "The original address is still being published. Try again in a few minutes."
/** How long the hand-off's setup spinner waits for the wallet to boot. */
const ENTRY_HOLD_MS = 25_000
// How long the "All set!" card holds before the wallet.
const ALL_SET_MS = 1_400

const BUSY_LABELS = {
  passkey: "Confirm your passkey…",
  checking: "Checking your claim…",
  claiming: "Claiming your payment…",
} as const

const subscribePendingStore = (onChange: () => void) => getPendingStore().onListChanged(onChange)

const CREATE_PASSKEY: PasskeyAttemptContext = { ceremony: "create", flow: "onboarding" }
const REUSE_PASSKEY: PasskeyAttemptContext = { ceremony: "sign_in", flow: "onboarding" }
const HANDOFF_PASSKEY: PasskeyAttemptContext = { ceremony: "sign_in", flow: "handoff" }

/**
 * Signup wizard (/claim/:handle?), ULT-667: a full-bleed invitation page with
 * the signup steps as modals over it — create account (passkey, then the
 * chained claim on the same spinner), "All set!", then Home. The passkey
 * must exist BEFORE the claim — the claimed OxideAccount is CREATE2-derived
 * from the bootstrap key, which derives from the passkey's PRF — but the
 * claim itself needs no extra click. An already-claimed handle surfaces on
 * the invitation page with a log-in lead. A failed claim drops to the
 * claim-retry modal without minting a second passkey.
 *
 * The claim returns as soon as the bundler holds the op, and the wizard's
 * chain work ends there: the L2 subscription rides the account's first
 * sponsored batch, so no setup step depends on this session. The identity is
 * saved at that point, so closing the tab on "All set!" loses nothing. An open
 * durable record enters at the pending step. Its same-tag retry — a FORCED
 * resume tick over the record, recovering the passkey first when this tab
 * holds no in-memory keys — leads only when the record says a fresh op could
 * help (retryWarranted); a healthy in-flight record leads with the status
 * check instead. Start-over renders only while abandonment can succeed.
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
  const [, refreshGrant] = useState(0)
  const { pathname, state } = useLocation()
  const [params] = useSearchParams()
  // A route grant keeps the link here; the availability probe validates it before passing the blocklist.
  const routeGrantToken = routeHandle ? nameGrantToken(routeHandle) : undefined
  const hasRouteGrant = Boolean(routeGrantToken)
  const routeGrant =
    routeHandle && routeGrantToken ? { handle: routeHandle, token: routeGrantToken } : undefined
  // The campaign hand-off (`/claim/:handle?entry=passkey`, launch-campaign-web handoff.ts): the
  // user already holds the shared passkey, so the wizard opens on the create step with entering
  // as the lead instead of asking them to "unlock access" and create.
  const handoffRpMatches = params.get("rp") === getConfig().rpId
  const passkeyEntry = params.get("entry") === "passkey" && Boolean(routeHandle) && handoffRpMatches
  // A session-switch reload landed back on the wizard mid hand-off. The mark is consumed here on any
  // wizard mount (a non-passkey reload takes it too) so it never lingers to mislead a later
  // hand-off in the same tab. Read once.
  const resumedRef = useRef<boolean | undefined>(undefined)
  if (resumedRef.current === undefined) resumedRef.current = takeOnboardingResume() && passkeyEntry
  const resumed = resumedRef.current ?? false
  // Only a resume onto a NEW account enters from the spinner: the onboarded identity, if any, names
  // a different tag. A resume onto the account this browser already holds takes the fast path below.
  const resumeNewAccount = resumed && loadOnboardedIdentity()?.handle !== routeHandle
  // `?resume=1`: arrived from a signup already begun (the queue card's exit), so the tag they are
  // about to type may be their own reservation. It proves nothing on its own — the claim server
  // still decides — it only stops the anonymous availability probe from refusing them first.
  const resuming = params.get("resume") === "1"
  const boundGrantOwner =
    resuming && (state as { boundGrantOwner?: string } | null)?.boundGrantOwner === routeHandle
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
  // `choose=1` (a reminder email's claim link): the campaign cannot say whose passkey this is, so
  // the user picks one and no key this browser holds answers, as on `/enter?choose=1`.
  const passkeyHints: PasskeyHints = !handoffRpMatches
    ? {}
    : params.get("choose") === "1"
    ? { discover: true, chooser: true }
    : {
        credentialId: params.get("cred") ?? undefined,
        pubkeyHex: params.get("pk") ?? undefined,
        expectedL2Address: params.get("l2") ?? undefined,
        policyVersion: params.get("pv") ?? undefined,
      }
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
  /** The claim was sent and the signup entered: its end is the bell's to report. */
  const claimHandedOff = useRef(false)
  const [claimLeft, setClaimLeft] = useState(false)
  const beginClaim = () => {
    claimHandedOff.current = false
    setClaimLeft(false)
  }
  const next = useNextRoute()
  // Omit empty `next` so a direct /claim visit doesn't write `{ next: undefined }` into history.
  const go = (to: string) => navigate(to, { replace: true, ...(next ? { state: { next } } : {}) })
  // A leftover inbound stash still claims on Home, unless a signup's own claim is spending it.
  /**
   * Home paints, and a name still owed its deposit raises the activation sheet on arrival, which owes
   * its broadcast. A name a payment link funds raises nothing: Home claims the link itself and the
   * hero carries it.
   */
  const intoWallet = () => {
    go(peekClaimStash() ? "/" : next ?? "/")
    const rec = getPendingStore().current()
    if (
      rec &&
      (rec.phase === "awaiting_deposit" || rec.phase === "funded") &&
      !activationPromptDismissed(rec) &&
      !pendingTicketRegistration()
    ) {
      openActivationPrompt()
    }
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
        ? "entering"
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
   * A hand-off's claim runs behind the setup spinner and lands on its own schedule. The step it asks
   * for is held until the spinner's wait settles; every other step applies at once. The hold reads
   * the current step, not the one the caller was rendered with.
   */
  const heldStep = useRef<Step | undefined>(undefined)
  const setStep = (to: Step) => {
    if (stepRef.current === "entering" && to !== "entering" && passkeyEntry && !mock)
      heldStep.current = to
    else setStepNow(to)
  }
  // The field's text, so "" rather than null when nothing usable was handed in.
  const [handle, setHandle] = useState(
    normalizeTag(mock?.handle ?? routeHandle ?? openRecord?.tag ?? ticketAttempt?.tag ?? "") ?? "",
  )
  const [inviteBusy, setInviteBusy] = useState(false)
  // Embedded, the pill is in the host page's frame, out of reach of a prop.
  useHoldEndpoints(inviteBusy)
  const [inviteNotice, setInviteNotice] = useState<InviteNotice>()
  // A hand-off opens on the setup spinner. Busy is seeded so its wait holds for the no-tap attempt
  // the wallet's boot starts, instead of reading a stale idle on that first commit.
  const entersFromSpinner = resumeNewAccount || (passkeyEntry && !mock && !openRecord)
  const [modalBusy, setModalBusy] = useState(mock?.busy ?? entersFromSpinner)
  const [createBusyPhase, setCreateBusyPhase] = useState<"passkey" | "claim" | "paylink">("passkey")
  // A hand-off past its point of no return: the account is being adopted and storage is about to
  // switch, so Cancel is withdrawn until it lands. The ref is what the handlers read.
  const [adopting, setAdopting] = useState(false)
  const adoptingRef = useRef(false)
  const markAdopting = (value: boolean) => {
    adoptingRef.current = value
    setAdopting(value)
  }
  const [modalError, setModalError] = useState<string>()
  // A refusal renders as its own state, with a retry where it has one; anything else is
  // `modalError` text.
  const [modalRefusal, setModalRefusal] = useState<RouteRefusal>()
  const retryRef = useRef<(() => void) | undefined>(undefined)
  const { gate, state: gateState, cancel: cancelGate, dismiss: dismissGate } = useCeremonyGate()
  // The route the ticket signup's own passkey sheet picked, when that sheet took the tap: the gate
  // then holds no sheet of its own.
  const unheldGate = useRef<SignInRoute | undefined>(undefined)
  // The ticket signup's passkey CTA is held; its actions read this, so a retry holds too.
  const ticketHeldRef = useRef(false)
  const [busyStage, setBusyStage] = useState<keyof typeof BUSY_LABELS>()
  const [inlineNotice, setInlineNotice] = useState<string>()
  // A policy refusal on the pending step's retry, rendered with its own retry.
  const [pendingRefusal, setPendingRefusal] = useState<RefusalState>()
  const [queuedNote, setQueuedNote] = useState<string>()
  // An identity save that failed, kept as the entry to try again once storage answers. The effects
  // that enter on their own stand down from then on: only the retry enters, once.
  const [identityRetry, setIdentityRetry] = useState<() => Promise<void>>()
  const entryRetryRef = useRef(false)
  const [lastCheckedAt, setLastCheckedAt] = useState<number>()
  // The pill's own read of the address is out.
  const [reading, setReading] = useState(false)
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
          hold: { deadline: String(Math.floor(Date.now() / 1000) + 7 * 86_400) },
          terms: {
            fee: String(mock.fee),
            minDeposit: String(mock.min),
            nonce: "1",
            deadline: "9999999999",
            signature: "0x00",
            reduced: mock.free === true,
            ticket: false,
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
  // "Cancel sign-in" on a spinner stops WATCHING the in-flight op (the account deploy and the claim
  // POST have no client-side abort): bumping the generation makes the settled op's UI routing a
  // no-op. The scope beside it is what a passkey creation or recovery runs under, so abandoning the
  // op also closes an open passkey prompt and ends any adoption still short of its keys or held key.
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
  // Leaving the screen ends whatever was running: the op's scope and the gate's attempt behind any
  // open prompt, so nothing commits for a screen that is gone.
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
  // all-set funnel — that funnel belongs to live signup sessions.
  const recoveredRef = useRef(false)
  const retryInFlight = useRef(false)
  // A forced tick whose re-sign quoted a schedule the paylink cannot pay: the resume machine
  // treats that claim as ordinary and reports nothing, so the wrapper leaves the refusal here
  // for the tick to show once the machine has settled.
  const renewalRefusedRef = useRef(false)

  // The passkey attempts still running, each with the generation it belongs to. Whatever ends one
  // marks why before it touches the gate.
  const passkeyAttempts = useRef(new Map<PasskeyAttemptHandle, number>())
  // Which kind of attempt ran last, so a failure can tell a reuse from a create or a hand-off.
  const lastAttempt = useRef<PasskeyAttemptContext | undefined>(undefined)
  const passkeyAttempt = <T,>(
    context: PasskeyAttemptContext,
    gen: number,
    fn: (own: PasskeyRequestScope, attempt: PasskeyAttemptHandle) => Promise<T>,
  ): Promise<T> => {
    // The gate this attempt takes cancels whatever was waiting on it, so the older ones are
    // replaced, not cancelled by the user.
    markAttempts("superseded")
    lastAttempt.current = context
    const attempt = passkeyTelemetry.begin(context)
    passkeyAttempts.current.set(attempt, gen)
    return attempt
      .run((own) => fn(own, attempt))
      .finally(() => passkeyAttempts.current.delete(attempt))
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

  // Consent is asked at the end of signup, so a first signup's steps, this start included, fire
  // behind a closed gate and never leave the device; the answer reports from wallet_entered on.
  const { value: asked, setValue: setAsked } = useConfigValue("analyticsAsked")
  const { setValue: setConsent } = useConfigValue("analyticsConsent")
  // The consent prompt is the last thing between a finished signup and the wallet.
  const [consentPending, setConsentPending] = useState(false)
  const startedAtRef = useRef<number>(performance.now())
  useEffect(() => {
    startedAtRef.current = performance.now()
    fireEvent("onboarding_started", { has_claim_link: !!routeHandle, entry: entryCohort })
  }, [routeHandle, entryCohort])
  /** Every signup exit into the wallet; the entry is reported for the account's first one only. */
  const enterWallet = () => {
    const address = loadWalletIdentity()?.address
    const report = () =>
      fireEvent("wallet_entered", { has_claim_link: !!routeHandle, entry: entryCohort })
    if (address === undefined) report()
    else void firstWalletEntry(address).then((first) => first && report())
    intoWallet()
  }

  /** Fresh signup starts on the campaign; grants, active registrations and entered accounts stay here. */
  const leaveForCampaign = (): boolean => {
    if (mock || embedded || hasRouteGrant || !config.campaignUrl) return false
    try {
      void leavePage(config.campaignUrl)
    } catch {
      return false
    }
    return true
  }
  useEffect(() => {
    if (passkeyEntry || openRecord || recoveryVisit || resuming) return
    if (loadWalletIdentity()) return
    leaveForCampaign()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- retry only when the route grant is cleared
  }, [hasRouteGrant])
  const checkRouteGrant = Boolean(
    routeHandle &&
      routeGrantToken &&
      !mock &&
      !embedded &&
      !passkeyEntry &&
      !openRecord &&
      !recoveryVisit &&
      !resuming &&
      !loadWalletIdentity() &&
      config.campaignUrl,
  )
  useEffect(() => {
    if (!checkRouteGrant || !routeHandle || !routeGrantToken) return
    let active = true
    void routeGrantIsCurrent(routeHandle, routeGrantToken)
      .then((current) => {
        if (!active) return
        if (current) scopeNameGrant(routeHandle, routeGrantToken)
        else {
          clearNameGrant(routeHandle, routeGrantToken)
          refreshGrant((revision) => revision + 1)
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [checkRouteGrant, routeHandle, routeGrantToken])

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
    lastAttempt.current = undefined
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
      // Its own scope ended it, as when the screen left: whatever it threw, nothing failed.
      if (signal.aborted) return
      if (fromPaylink) {
        try {
          setTicketAttempt(readTicketAttempt())
        } catch {
          /* The original error is shown below. */
        }
      }
      // The material-only attempt found no material: not an error, the terms sheet will ask.
      if (err instanceof CeremonyRequiredError) return
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
        // Only a fresh create or hand-off can start again in another browser: a reuse, or any
        // attempt in a browser that holds an account, needs an account that browser doesn't have.
        const portable =
          (lastAttempt.current === CREATE_PASSKEY || lastAttempt.current === HANDOFF_PASSKEY) &&
          !loadWalletIdentity()
        const unusable = portable ? inAppBrowserRefusal(err) : undefined
        const leftover = passkeyWritten(err)
        if (unusable) {
          setModalRefusal({ ...unusable, cause: err, leftover })
          // Held while a hand-off's spinner waits, so the wait ends on the card rather than the terms.
          setStep("create")
        } else if (isPasskeyPolicyError(err)) {
          setModalRefusal({ name: err.name, message: err.message, leftover })
        } else if (leftover) {
          // A passkey was saved before this failed, so the card that links the cleanup shows it.
          const { name } = err as { name?: unknown }
          setModalRefusal({
            name: typeof name === "string" ? name : "Error",
            message: passkeyErrorMessage(err),
            cause: err,
            leftover,
          })
        } else {
          setModalError(mode === "create" ? passkeyErrorMessage(err) : enterErrorMessage(err))
        }
      }
    } finally {
      if (gen === opGen.current) {
        setModalBusy(false)
        setCreateBusyPhase("passkey")
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
    if (ticketHeldRef.current) return
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
      const account = await passkeyAttempt(CREATE_PASSKEY, gen, async (own, attempt) => {
        const { route, reach } = await gate({ purpose: "create", unheld: unheldGate.current })
        // A route means a laptop creation, the only gate that checks for a phone.
        if (route) attempt.notePhoneReach(reach)
        const ticket = ticketId
          ? await beginTicketSignupAccount(config.rpId, ticketId, handle)
          : null
        if (ticket) setTicketAttempt(ticket)
        return createAccount(false, AUTH_TYPE.WEB_AUTHN, statusForAttempt(own), handle, undefined, {
          route,
          signal,
          ...(ticket && ticketId
            ? {
                onAccountCreated: (created: { credentialId: string; l2Address: string }) =>
                  completeTicketSignupAccount(config.rpId, ticketId, ticket.attemptId, created),
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
      // A silent run asks nothing, so its attempt reports nothing when it takes the hand-off material
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
        // Counted only for the attempt still current once the adoption lands, and only for a
        // campaign hand-off: another `entry=passkey` link is not one.
        if (
          gen === opGen.current &&
          !signal.aborted &&
          passkeyEntry &&
          entryCohort === "campaign"
        ) {
          reportHandoffAdopted(resolved.keySource)
        }
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
        // Nor does it owe the campaign's claim notice.
        void oweCampaignClaimNotice({
          l2Address: keys.account.getAddress().toString(),
          tag: handle,
        })
      } else if (outcome.kind === "custody") {
        fireEvent("onboarding_tag_custody", { duration_ms: elapsed() })
      }
      return outcome
    })
  }

  /**
   * The signup is complete once the account-service holds the op: save the
   * identity NOW, so cancelling or closing anything from here on cannot
   * strand a claimed tag without a wallet identity.
   *
   * The handle is a parameter rather than the `handle` state so that what gets persisted is the
   * tag this completion actually claimed, not whatever the field happened to hold.
   */
  const completeSignup = async (effectiveHandle: string) => {
    const rec = oxideAccountRef.current ? getPendingStore().get(oxideAccountRef.current) : null
    const stillPending = rec !== null && rec.phase !== "confirmed"
    // The persisted terms are the waiver authority; a custody/nameless completion has none.
    const completedTerms = rec ? loadRegistrationTerms(rec.account, rec.tag) : undefined
    fireEvent("onboarding_completed", {
      total_duration_ms: Math.round(performance.now() - startedAtRef.current),
      named: !!effectiveHandle,
      fee_waived: completedTerms ? completedTerms.feeWaived === true : undefined,
    })
    // Nothing advances until the identity is saved; a failure keeps this screen.
    try {
      await saveWalletIdentity({
        handle: effectiveHandle,
        address: addressRef.current!,
        claimedAt: Date.now(),
        ...(stillPending ? { pending: true } : {}),
      })
    } catch (e) {
      entryRetryRef.current = true
      const retry = () => completeSignup(effectiveHandle)
      setIdentityRetry(() => retry)
      showReportableError(e, "onboarding:identity", {
        retry: { label: "Retry entering wallet", run: () => void retry() },
      })
      return
    }
    setIdentityRetry(undefined)
    if (rec?.phase === "confirmed") clearNameGrant(effectiveHandle)
    // The setup spinner is waiting, or gave up on this very claim: its wait enters however late
    // this completion lands.
    if (enterWhenReady.current) {
      setAwaitingEntry(true)
      setStepNow("entering")
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
  // A saved identity: a wait that enters on one still being written could land with none.
  const handoffDone = () => loadOnboardedIdentity({ saved: true })?.handle === handle
  useEffect(() => {
    // Arriving from the campaign again, on a name this browser already entered: the wallet is
    // theirs, and the deposit it still owes is the activation sheet's to ask for over Home.
    // Opening the pending step again would hold them at a gate the wallet no longer keeps.
    if (!passkeyEntry || mock || !openRecord) return
    if (loadOnboardedIdentity()?.handle !== openRecord.tag) return
    intoWallet()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the record snapshot is fixed at mount
  }, [passkeyEntry, mock])

  /** The hand-off material needs no tap, so it is taken as soon as the wallet can use it. */
  const silentTried = useRef(false)
  useEffect(() => {
    if (!passkeyEntry || mock || !obsidionWallet || !contractService) return
    if (silentTried.current || handoffDone()) return
    silentTried.current = true
    depositIntentRef.current = false
    void enterPasskeyStep(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, when the wallet is ready
  }, [passkeyEntry, mock, obsidionWallet, contractService])
  /**
   * The setup spinner enters the wallet the moment the signup saves an identity — the thing the
   * wallet's gate reads. It waits out the hand-off's own work however long it runs; work that ends
   * with no account falls back to the terms sheet, which carries the prompt and its retry, or to the
   * refusal or claim error the work itself asked for. Only a wallet that never boots is given up on.
   */
  const enterWhenReady = useRef(entersFromSpinner)
  const [awaitingEntry, setAwaitingEntry] = useState(entersFromSpinner)
  const [holdExpired, setHoldExpired] = useState(false)
  /**
   * Everything the spinner waits on: work in flight, or a wallet that has not booted, neither of
   * which has an account yet to enter on. The address's broadcast is not among them: the sheet that
   * shows the address owes it.
   */
  const notReady = () =>
    modalBusy || (!holdExpired && (!silentTried.current || !obsidionWallet || !contractService))
  // A wallet that never boots is not waited on forever.
  useEffect(() => {
    if (!awaitingEntry) return
    const timer = setTimeout(() => setHoldExpired(true), ENTRY_HOLD_MS)
    return () => clearTimeout(timer)
  }, [awaitingEntry])
  useEffect(() => {
    if (!awaitingEntry) return
    if (handoffDone()) {
      setAwaitingEntry(false)
      enterWhenReady.current = false
      return finishOnboarding()
    }
    if (notReady()) return
    setAwaitingEntry(false)
    enterWhenReady.current = false
    const held = heldStep.current
    heldStep.current = undefined
    // A claim that needs its deposit lands on the pending step, which shows the address; only work
    // that ended with no account falls back to the terms sheet and its passkey prompt.
    setStepNow(held && held !== "allset" ? held : "terms")
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the op ending, read fresh
  }, [awaitingEntry, modalBusy, obsidionWallet, contractService, holdExpired])

  // An app's built-in browser is told before the first prompt, and no passkey action starts there.
  const inAppHold = walletInAppUpFront(config.rpId) !== undefined

  const leaveTerms = (wantsDeposit: boolean) => {
    if (ticketHeldRef.current || inAppHold) return
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
    const link = await viewLink(live, fragment)
    const zkProof =
      link.flavor === "email"
        ? await obtainEmailClaimProof(live.account.getAddress(), {
            paylinkType: DEFAULT_CONTRACTS.paylinkEmail,
            commitment: link.commitment,
            email: link.email,
          })
        : undefined
    // Home offers no prompt for a link this claim is spending, even once the wizard has gone.
    startClaim(fragment)
    try {
      await claimSponsoredLink(live, fragment, undefined, zkProof, { fundRegistration: true })
    } catch (err) {
      // The node has the batch: offering the link again would spend it twice.
      if (err instanceof TxInFlightError) clearClaimStash(fragment)
      throw err
    } finally {
      endClaim(fragment)
    }
    clearClaimStash(fragment)
  }

  /**
   * Once, when the claim is sent or lands, whichever is first: the signup does not wait on the
   * chain, and the wallet does not start its own work while this page proves. A claim that fails
   * after that is the bell's to report, and Home offers the link again.
   */
  const enterPastClaim = (tag: string) => {
    if (claimHandedOff.current) return
    claimHandedOff.current = true
    setClaimLeft(true)
    setModalBusy(false)
    return finishSignup(tag)
  }

  /**
   * Route a claim outcome: custody completes the signup; pending is resumable, never failure copy.
   * A hand-off and a reduced (earned) schedule with no deposit intent both enter now — the campaign
   * already took the name — and the activation sheet on Home asks for a deposit still owed. Only a
   * signup that chose the deposit up front waits on the wizard's own pending step.
   *
   * A ticket-funded signup enters at once too: Home owes the SIPA's broadcast, then claims the link
   * and funds the registration in one batch once it lands, and the bell carries the claim. Every
   * other reduced (earned) signup enters the wallet at once when the user chose to deposit later,
   * reminded to deposit the signed total before the claim deadline.
   */
  const applyClaimOutcome = async (outcome: ClaimTagOutcome) => {
    oxideAccountRef.current = outcome.oxideAccount
    if (outcome.kind === "custody") {
      await completeSignup(handle)
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
    saveRegistrationTerms(
      checkpointRegistrationTerms(outcome.oxideAccount, handle, outcome.claim, {
        earnedExpected: expectedEarned,
        ticket,
      }),
    )
    setFreshClaim(outcome.claim)
    if (
      ticket ||
      passkeyEntry ||
      (outcome.claim.terms?.reduced === true && !depositIntentRef.current)
    ) {
      await finishSignup(handle)
      return
    }
    setStep("pending")
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

  const cancelEntering = () => {
    silentTried.current = true
    cancelModalOp()
  }

  /** Reloaded-tab completion: the record carries the identity and no wizard step remains. */
  const enterWithRecordIdentity = async (rec: PendingRegistrationRecord) => {
    try {
      await saveWalletIdentity({
        handle: rec.tag,
        address: rec.l2Address,
        claimedAt: Date.now(),
        ...(rec.phase !== "confirmed" ? { pending: true } : {}),
      })
    } catch (e) {
      entryRetryRef.current = true
      const retry = () => enterWithRecordIdentity(rec)
      setIdentityRetry(() => retry)
      showReportableError(e, "onboarding:identity", {
        retry: { label: "Retry entering wallet", run: () => void retry() },
      })
      return
    }
    setIdentityRetry(undefined)
    if (rec.phase === "confirmed") clearNameGrant(rec.tag)
    // All navigations in this screen replace: onboarding panes must never be back targets once in
    // the wallet (useBack pops history), and a pushed /enter hop would keep /claim behind it.
    // A deposit grants access, but cannot recreate missing passkey metadata. Recover the
    // existing account instead of sending it to WalletGate, which bounces it back to /claim.
    if (!loadOnboardedIdentity()) go(`/enter?handle=${encodeURIComponent(rec.tag)}`)
    else enterWallet()
  }

  /** Back to the invitation page, retaining the name on a grant link. */
  const steerToInvite = (notice?: InviteNotice) => {
    // Every way back to the invitation ends what the sheet was running: no gate waiting behind it,
    // no adoption still short of its keys, and no refusal from the last attempt hiding the next
    // one's actions.
    abandonOp()
    cancelGate()
    setModalBusy(false)
    setCreateBusyPhase("passkey")
    setModalRefusal(undefined)
    // A notice and a grant link stay here; other fresh signups return to the campaign.
    if (!notice && leaveForCampaign()) return
    setInviteNotice(notice)
    setStep(fromPaylink ? "tag" : "invite")
    if (pathname.startsWith("/claim")) {
      let invitePath = resuming ? "/claim?resume=1" : "/claim"
      if (hasRouteGrant && routeHandle) {
        invitePath = `/claim/${encodeURIComponent(routeHandle)}${resuming ? "?resume=1" : ""}`
      }
      go(invitePath)
    }
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
    const account = oxideAccountRef.current
    // Steering can leave for the campaign, so it waits until the sign-out is saved.
    void signOut({ keepPointers: true, localOnly: true }).then(
      () => {
        if (account && !registrationTermsAreInUse(account, tag))
          clearRegistrationTerms(account, tag)
        steerToInvite(takenNotice(tag))
      },
      (e) => showReportableError(e, "onboarding:sign-out"),
    )
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
      getSignDeps: async () => {
        if (!keysRef.current) return null
        const signDeps = await buildRetrySignDeps(rec.tag, keysRef.current, config)
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
              if (isPasskeyNotOffered(err)) {
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
    beginClaim()
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
          setBusyStage("claiming")
          await consumeStashedPaylink(fragment, keysRef.current?.account)
          await enterPastClaim(rec.tag)
        } catch (err) {
          paylinkSettleRef.current = false
          if (isGateCancelled(err)) return
          // Handed off, so the bell reports it; a queued signup still here can claim again.
          if (claimHandedOff.current) return beginClaim()
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

  const checkPendingStatus = (quiet = false) => {
    if (chainReadPending.current) setReadAttempt((attempt) => attempt + 1)
    // The pin is captured at click time — deps construction awaits network work, and a record
    // that became current meanwhile must not be driven by this stale click.
    const rec = currentRegistration()
    if (!rec) return
    return run(
      async () => {
        const tick = buildWebDetectionDeps(config).then((deps) =>
          runDetectionTick(deps, {
            force: true,
            expectedRecord: { account: rec.account, nameHash: rec.nameHash },
          }),
        )
        const outcome = await (quiet ? tick.catch(warnQuietCheck) : tick)
        if (!outcome || routeSettledOutcome(outcome, rec)) return
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
    if (step !== "pending" || !record || mock || entryRetryRef.current) return
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
   * The exit into the wallet from a signup this tab ran. Consent is asked here and nowhere
   * earlier: by this point the account exists, so the question lands on someone who has finished
   * rather than over the page they arrived on. Everything the gate would have covered has already
   * run, so a grant here starts reporting from the wallet onward, not from onboarding.
   */
  const finishOnboarding = () => (asked ? enterWallet() : setConsentPending(true))

  // "All set!" holds briefly, then the exit above.
  useEffect(() => {
    if (step !== "allset") return
    const timer = setTimeout(finishOnboarding, ALL_SET_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- finishOnboarding is stable per render
  }, [step, next, asked])

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
  const stage = useRegistrationStage(record)
  const openPending =
    record !== null &&
    stage !== null &&
    (depositOwed(stage) || stage === "funding" || fundsIn(stage))
  const custodyHeld = openPending && fundsIn(stage)
  // A capacity blocker on the address outranks "being processed", in the words its stated reason uses.
  const { shown: sweepHold } = useSipaProcessing(record?.sipaAddress)
  const sweepBlocker = sweepHold?.blocker
  const awaitingDeposit = openPending && !fundsIn(stage)
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
  /**
   * A broadcast of the old address already proving or sent may yet take the rail, and whether it
   * did decides how the replacement registers. It is waited out, for a bounded time, before the
   * replacement runs as a user flow, in which the ledger starts no other attempt; one still
   * undecided then stops the replacement, to be asked for again.
   */
  const replaceAtEarnedPrice = async (keys: OnboardingKeys) => {
    if (!record) return
    const inFlight = () => {
      const job = getBroadcastLedger().get(record.sipaAddress)
      return job?.state === "proving" || job?.state === "sent" ? job : undefined
    }
    const owed = inFlight()
    if (owed) {
      await Promise.race([
        broadcastSettled(owed.address),
        new Promise((resolve) => setTimeout(resolve, REPLACE_SETTLE_MS)),
      ])
    }
    return runUserFlow(async () => {
      if (inFlight()) throw new Error(REPLACE_WAITING_MESSAGE)
      return replaceOnce(keys)
    })
  }
  const replaceOnce = async (keys: OnboardingKeys) => {
    if (!record) return
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
  const claimDeadline = freshClaim ? claimTerms(freshClaim).deadline : terms?.deadline || undefined
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
  const ticketCuts =
    sweepDeductions === undefined
      ? undefined
      : { withdrawalCut: sweepDeductions.fpcCut, depositCut: sweepDeductions.fpcCut }
  // Before the terms exist the stash holds the tip, and the terms take it once signed.
  const ticketSpeed = useRegistrationSpeed({
    active: !mock && ticketStash !== null,
    node: obsidionWallet?.node,
    noteAmount: ticketStash?.amount !== undefined ? BigInt(ticketStash.amount) : undefined,
    schedule: ticketSchedule,
    cuts: ticketCuts,
    initialSpeed: ticketStash?.speed ?? terms?.speed,
    onCommit: (tip, speed) => {
      updateTicketSignup({ proverTip: tip.toString(), speed })
      if (terms) commitRegistrationProverTip(terms.account, terms.tag, tip, speed)
    },
    commitKey: terms ? `${terms.account}:${terms.tag}` : undefined,
  })
  const ticketProverTip = mock ? 0n : ticketSpeed.proverTip
  const paylinkQuote =
    ticketStash && ticketSchedule && ticketCuts && ticketProverTip !== undefined
      ? paylinkSignupQuote({
          ...(ticketStash.amount !== undefined ? { paylink: BigInt(ticketStash.amount) } : {}),
          schedule: ticketSchedule,
          cuts: ticketCuts,
          sweepFee: relayerFee,
          proverTip: ticketProverTip,
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
  const depositSeen = mock ? mock.received ?? 0n : watchedDeposit.balance
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
    void checkPendingStatus(true)
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
    if (recoveryVisit || entryRetryRef.current) return
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
      void checkPendingStatus(true)
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
  // The pending step's own claim, not a status check sharing the busy flag.
  const paylinkClaiming = busy && (busyStage === "passkey" || busyStage === "claiming")
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
  const retryButton = (className: string) =>
    retryWarranted && !pendingRefusal ? (
      <button
        type="button"
        className={`zkm-btn-reset zkm-pressable ${className}`}
        onClick={retryClaim}
        disabled={busy}
      >
        {busy && busyStage ? BUSY_LABELS[busyStage] : "Retry"}
      </button>
    ) : undefined
  const checkNote = (() => {
    if (record === null) return undefined
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
          onClick={() => checkPendingStatus()}
          disabled={busy}
        >
          {busy ? "Checking…" : "Check again"}
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
          lastCheckedAt,
          busy: busy || reading,
          onCheck: () => {
            void checkPendingStatus()
            setReading(true)
            void watchedDeposit.read().finally(() => setReading(false))
          },
          action: retryButton("ww-deposit-sheet__check"),
        }
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
    // Steering can leave for the campaign, so it waits until the sign-out is saved.
    void signOut({ keepPointers: true }).then(
      () => {
        if (record && !registrationTermsAreInUse(record.account, record.tag))
          clearRegistrationTerms(record.account, record.tag)
        steerToInvite()
      },
      (e) => showReportableError(e, "onboarding:sign-out"),
    )
  }
  // Rendered beside every terminal step, including the setup spinner, which returns early.
  const consentModal = consentPending ? (
    <AnalyticsConsentModal
      onChoose={(granted) => {
        setConsentPending(false)
        void (async () => {
          await setConsent(granted)
          await setAsked(true)
          enterWallet()
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
  const refusalRow = modalRefusal && refusalFor(modalRefusal)
  const inAppRefusal = !!refusalRow?.openInBrowser
  // The in-app card with no retry: nothing more can be created in this browser.
  const inAppDeadEnd = inAppRefusal && !refusalRow?.retry
  // Open in browser is the one bright action while this device has a browser to go to.
  const ctaStyle =
    inAppRefusal && currentOpenInBrowserHref(window.location.href) ? "dark" : "gradient"
  // The card takes the idle sheet. A running attempt keeps its spinner, the hand-off's silent one
  // included, since what it lands needs no prompt here.
  const inAppWait = inAppHold && modalBusy
  const inAppCard = inAppHold && !modalBusy && !(step === "create" && modalRefusal)
  // The sheet's button stays beside a refusal card only where it is not a second retry: the in-app
  // card borrows it as its retry, and a payment-link signup starts another passkey with it.
  const refusalKeepsActions = !!refusalRow?.retry && (inAppRefusal || fromPaylink)

  // The ceremony's own surface, shared by the terms sheet and the ticket signup's welcome step:
  // refusals and errors above, then the CTA or whatever the ceremony shows in its place.
  const termsNotices = (
    <>
      {inAppCard && (
        <InAppBrowserNotice
          reportContext="onboarding"
          testId="create-in-app-notice"
          exits={
            termsDismissible && (
              <button
                type="button"
                className="zkm-btn-reset zkm-pressable ww-invite-pill"
                data-testid="create-in-app-back"
                onClick={closeToInvite}
              >
                Back
              </button>
            )
          }
        />
      )}
      {step === "terms" && registrationsPaused && (
        <p className="ww-deposit-feedback" data-testid="registrations-paused">
          {REGISTRATIONS_PAUSED_NOTICE}
        </p>
      )}
      {fromPaylink &&
        isTicketSignupCreating(ticketAttempt) &&
        !termsBusy &&
        !inAppDeadEnd &&
        !inAppCard && (
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
          // The sheet's own button is the in-app card's retry: it also restarts an interrupted
          // payment-link signup.
          onRetry={inAppRefusal ? undefined : () => retryRef.current?.()}
          busy={modalBusy}
          reportContext="onboarding"
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
  const gateHeld = termsBusy && gateState.kind === "awaiting-action"
  // A fresh ticket signup on a laptop is the creation sheet itself, shown once: what comes next, the
  // split, the phone and the key. A phone's own passkey needs no route, so its card keeps the CTA.
  const ticketSheet =
    fromPaylink &&
    !!ticketStash &&
    !resumingTicket &&
    !isTicketSignupCreating(ticketAttempt) &&
    currentDevicePosture() === "laptop"
  // The sheet names the device the passkey can live on from the browser's own answer, the one
  // the gate will probe again before the ceremony. Its routes wait for that answer, so a phone
  // pick is never turned into a key after the tap.
  const [sheetReach, setSheetReach] = useState<PhoneReach>()
  useEffect(() => {
    if (!ticketSheet) return
    const probe = getAuthService()?.probePhoneReach?.()
    if (!probe) {
      setSheetReach("unknown")
      return
    }
    let live = true
    probe
      .then((reach) => {
        if (live) setSheetReach(reach ?? "unknown")
      })
      .catch(() => {
        if (live) setSheetReach("unknown")
      })
    return () => {
      live = false
    }
  }, [ticketSheet])
  // What the payment link's signup keeps and what the account costs, before the passkey is made:
  // the claim on Home commits to this split with no review of its own, so the signup waits for
  // the split to be priced and refuses a payment that cannot cover the account.
  const ticketUnpriced =
    fromPaylink &&
    !!ticketStash &&
    (paylinkQuote === undefined || paylinkQuote.tagWaived === undefined)
  const ticketUncovered = fromPaylink && !!ticketStash && paylinkQuote?.covers === false
  // A new passkey spends the ticket next, so it needs the note at or above the threshold. A bound
  // account resumes what it committed; its redeem checks the live threshold before spending.
  const ticketThreshold =
    fromPaylink && ticketStash && !resumingTicket
      ? ticketEligibility(ticketStash.amount, ticketStash.threshold)
      : undefined
  const ticketHeld =
    ticketUnpriced ||
    ticketUncovered ||
    (ticketThreshold !== undefined && ticketThreshold !== "eligible")
  ticketHeldRef.current = ticketHeld
  const ticketSplit =
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
            Couldn&apos;t check this payment&apos;s amount. Go back to the payment and try again.
          </p>
        )}
        {ticketUncovered && (
          <p className="ww-invite-modal-error" role="alert">
            This payment cannot cover the account deposit.
          </p>
        )}
      </>
    ) : undefined
  const termsActions =
    termsBusy && gateState.kind === "awaiting-action" ? (
      <GateStep state={gateState} onCancel={cancelModalOp} details={ticketSplit} />
    ) : termsBusy || inAppWait ? (
      <OnboardingSpinnerBody
        label={
          adopting
            ? "Finishing sign-in…"
            : createBusyPhase === "claim"
            ? fromPaylink
              ? "Using your paylink…"
              : "Preparing deposit address…"
            : passkeyEntry || resumingTicket
            ? "Confirming with your passkey…"
            : "Creating your passkey…"
        }
        cancelLabel="Cancel"
        onCancel={adopting ? undefined : cancelModalOp}
      />
    ) : (refusalRow && !refusalKeepsActions) || inAppCard ? null : ticketSheet ? (
      // A refusal or the in-app card leaves only what the card itself offers.
      <PhoneSteps
        reach={sheetReach ?? "unknown"}
        details={ticketSplit}
        disabled={!passkeysSupported() || ticketHeld || !sheetReach}
        onChoose={(hints) => {
          unheldGate.current = routeForHints(hints)
          leaveTerms(false)
        }}
      />
    ) : (
      <div className="ww-deposit-actions">
        {/* A laptop reads this on its sheet; a phone has no sheet, so it reads it with its button. */}
        {currentDevicePosture() === "phone" && (
          <PasskeyWarn testId="passkey-loss-notice">
            <p>{PHONE_STEPS_COPY.loss.line}</p>
          </PasskeyWarn>
        )}
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
          buttonStyle={ctaStyle}
          isDisabled={!passkeysSupported() || ticketHeld}
          onClick={() => {
            if (ticketHeld) return
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
            unheldGate.current = undefined
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

  // One "scan this code" at a time: the deposit address steps aside for the phone steps. A stashed
  // paylink funds the SIPA — never offer an L1 send beside it.
  const pendingAddressShown =
    step === "pending" &&
    !paylinkPending &&
    !ticketBlocked &&
    openPending &&
    !wrongChain &&
    !quoteExpired &&
    !depositAdmitted &&
    !needsRefund &&
    !quoteMismatch &&
    !registrationsPaused &&
    !!record &&
    gateState.kind !== "awaiting-action"
  // A payment link funds the address instead, so the pending step claims into it: that needs it
  // published too.
  useOweRegistrationBroadcast(
    mock ? null : record,
    pendingAddressShown ||
      (step === "pending" && paylinkPending && !quoteMismatch && !needsRefund && !replaceUnfunded),
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
            gated={gateHeld || (ticketSheet && !termsBusy) || inAppCard}
            busy={termsBusy && !gateHeld}
            split={ticketSplit}
            onClose={termsDismissible ? closeToInvite : undefined}
            notices={termsNotices}
            actions={termsActions}
          />
        ) : (
          <RegistrationSheet
            tag={handle}
            title={termsFree ? "Activate account" : "Get instant access"}
            reservedUntil={reservedUntil({ deadline: untilHint ?? 0 }, nowMs)}
            onClose={termsDismissible ? closeToInvite : undefined}
            // One thing at a time, as on the pending step: the terms stand aside while the passkey
            // runs, and come back under the deposit address the claim returns.
            payment={
              step === "create" || registrationsPaused || inAppCard
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
                    network: config.network,
                    swapAssets: swapAssetsLabel(config.network),
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
          grant={routeGrant}
          boundGrantOwner={boundGrantOwner}
          onBoundGrant={(tag) => go(`/enter?handle=${encodeURIComponent(tag)}&bound=1`)}
          onClaim={(h) => void unlockAccess(h)}
          onLogIn={logIn}
          onCancel={cancelUnlock}
          onClose={() => onExit?.()}
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
          reservedUntil={reservedUntil(freshClaim ? claimTerms(freshClaim) : terms, nowMs)}
          note={pendingBody}
          onClose={
            depositAdmitted || refundedFrom || alreadyEntered
              ? intoWallet
              : gateDismissible || paylinkStashed
              ? closeToInvite
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
                  total: pendingQuote?.total,
                  fee: pendingQuote?.fee,
                  sweepFee: relayerFee,
                  fpcCut: sweepDeductions?.fpcCut,
                  floor: pendingQuote?.floor,
                  scheduleUnavailable,
                  kind: quotedKind ?? registrationKind(feeWaived),
                  tokenSymbol: mock?.tokenSymbol ?? WALLET_TOKEN_SYMBOL,
                  network: config.network,
                  swapAssets: swapAssetsLabel(config.network),
                  tokenDecimals: tokenDecimalsForNetwork(config.network),
                  received: depositSeenAny ? depositSeen : undefined,
                  receivedToken: !depositSeenAny
                    ? undefined
                    : mock
                    ? depositTokensFor(config.network).find((t) => t.symbol === mock.tokenSymbol)
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
                    {custodyHeld && (
                      <p>{heldDepositLine(sweepHold) ?? "Your deposit is being processed."}</p>
                    )}
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
                    {(custodyHeld || depositReceived || depositAdmitted) && sweepBlocker
                      ? sweepBlocker.kind === "capacity"
                        ? "The new address has received your deposit. Sweep manually finishes registration once network capacity is available."
                        : "The new address has received your deposit, but it is too large to sweep."
                      : custodyHeld || depositReceived || depositAdmitted
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
              {identityRetry && (
                <PrimaryGradientButton
                  title="Retry entering wallet"
                  isDisabled={busy}
                  onClick={() => void identityRetry()}
                />
              )}
              {openPending && !wrongChain && (
                <>
                  {quoteExpired && !replaceUnfunded && (
                    <PrimaryGradientButton
                      title={busy && busyStage ? BUSY_LABELS[busyStage] : "Refresh deposit amount"}
                      isDisabled={busy}
                      onClick={refreshExpiredQuote}
                    />
                  )}
                  {paylinkPending &&
                    !ticketBlocked &&
                    paylinkClaiming &&
                    !claimLeft &&
                    (busyStage === "passkey" ? (
                      <OnboardingSpinnerBody label="Confirming with your passkey…" />
                    ) : (
                      <OperationHandOff
                        onLeave={() => void enterPastClaim(pendingTag)}
                        until="sent"
                      />
                    ))}
                  {paylinkPending && !ticketBlocked && !paylinkClaiming && (
                    <PrimaryGradientButton
                      title="Claim your payment"
                      isDisabled={
                        busy ||
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
        grant={routeGrant}
        resuming={resuming}
        boundGrantOwner={boundGrantOwner}
        onBoundGrant={(tag) => go(`/enter?handle=${encodeURIComponent(tag)}&bound=1`)}
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
  if (step === "entering") {
    return (
      <InvitationChrome topBar={false}>
        <div className="ww-entering" data-testid="handoff-entering">
          <OnboardingSpinnerBody
            label="Setting up your wallet…"
            // Past the hold, work still running may never settle: the visitor can stop it, and the
            // terms sheet's passkey prompt is the way on from there. A silent attempt not yet
            // started never starts after it.
            cancelLabel="Cancel"
            onCancel={holdExpired && !adopting ? cancelEntering : undefined}
          />
        </div>
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
