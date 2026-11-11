/** The signup screen's flow: its state, its commands, and the record exits it reacts to. */
import type { NavigateFunction } from "react-router-dom"
import type { Hex } from "viem"
import {
  broadcastJob,
  broadcastSettled,
  createAccount,
  currentRegistration as latestOpenRegistration,
  latestRegistration,
  memoryStore,
  normalizeTag,
  selectPendingExit,
  TxInFlightError,
  valueOf,
  WalletError,
  within,
  type PendingRegistrationRecord,
  type RegistrationRoute,
} from "@obsidion/front-core"
import { bestEffort, bestEffortSync } from "@obsidion/core/errors"
import { Network } from "@obsidion/core/constants"
import type { NameClaimResponse } from "@obsidion/core/types"
import { AUTH_TYPE, DEFAULT_CONTRACTS } from "@obsidion/sdk"
import {
  currentDevicePosture,
  isPasskeyPolicyError,
  passkeysSupported,
  type PasskeyAttemptContext,
  type PasskeyAttemptHandle,
  type PasskeyRequestScope,
  type SheetReopen,
  type SignUpChoice,
} from "@obsidion/passkey-web"
import { errorMessage } from "../../../errors/catalog"
import { showReportableError } from "../../../errors/errorModal"
import {
  failureCode,
  fireEvent,
  fireOnboardingEvent,
  lapTimer,
  reportLanding,
} from "../../../lib/analytics"
import { passkeyTelemetry } from "../../../lib/passkeyTelemetry"
import { firstInTab } from "../../../lib/trafficSource"
import { statusForAttempt } from "../../../platform/auth/passkeyAttemptScope"
import { hasOpeningBreadcrumb } from "../../../platform/auth/WebPasskeyIdentityMap"
import {
  collectOnboardingKeys,
  enteredIdentity,
  saveIdentity,
  type OnboardingKeys,
} from "../../../session/account"
import { chainOf, handOffAccount, signedInAccount, type Session } from "../../../session/session"
import { reloadIfSessionSwitched } from "../../../session/sessionReload"
import { isGateCancelled, PHONE_CREATION, type CeremonyGate } from "../../identity/ceremonyGate"
import { isPasskeyNotOffered } from "../../identity/PasskeyRefusal"
import { PasskeyMismatchError, reusePasskeyAccount } from "../../identity/passkeyAccount"
import { signOut } from "../../identity/signOut"
import { walletInAppUpFront } from "../../identity/inAppUpFront"
import { markNewAccountHere } from "../../migration/upgradeLock"
import {
  clearClaimStash,
  clearTicketSignup,
  peekClaimStash,
  peekTicketSignup,
  RECEIVE_TO_ACCOUNT,
  updateTicketSignup,
  type TicketSignupStash,
} from "../../paylink/claimStash"
import { tabStash } from "../../../platform/storage/tabStash"
import { obtainEmailClaimProof } from "../../paylink/emailClaim"
import { linkIdentity } from "../../paylink/linkIdentity"
import { openStashedLink } from "../../paylink/linkStatus"
import {
  afterGate,
  type RegistrationSpeed,
  type SpeedDecision,
} from "../../paylink/registrationProverTip"
import {
  claimSponsoredLink,
  viewLink,
  type SponsoredPaylinkDeps,
} from "../../paylink/sponsoredPaylink"
import { ticketActivation, ticketSignupRegistration } from "../../paylink/ticketContinuation"
import {
  beginTicketSignupAccount,
  boundToTicketSignup,
  completeTicketSignupAccount,
  isTicketSignupCreating,
  loadTicketSignupAccount,
  loadTicketSignupAttempt,
  restartTicketSignupAccount,
  saveTicketSignupAccount,
} from "../../paylink/ticketSignupAccount"
import type { PaylinkKit } from "../../paylink/usePaylinkDeps"
import { expectsEarned, hasDepositAdmission } from "../../registration/admission"
import { drawTag, routeGrantIsCurrent, tagField } from "../../registration/nameAvailability"
import { grantPastUser, PastUserAlreadyUsedError } from "../../registration/pastUserClaim"
import { buildRetrySignDeps } from "../../registration/registrationDeps"
import {
  commitRegistrationProverTip,
  feeField,
  loadRegistrationTerms,
  rememberReissuedClaim,
  wireTermsFundTicket,
} from "../../registration/registrationTerms"
import type { ChosenTag } from "../../registration/signupStash"
import {
  abandonPendingRegistration,
  buildWebDetectionDeps,
  cacheConfirmedNameClaim,
  closeRegistration,
  hasCustody,
  loadedRegistrations,
  runDetectionTick,
} from "../../registration/webRegistration"
import {
  claimTag,
  getClaimStatus,
  isRegistrationStage,
  NameTakenError,
  type ClaimTagOutcome,
  type LinkDeposit,
} from "../oxideOnboarding"
import { prewarmGoldenTicket } from "../goldenTicket"
import { classifyCreateFailure, type CreateAttempt } from "./createFailure"
import copy from "./OnboardingScreen.copy"
import {
  signupTransition,
  type InviteNote,
  type SignupEvent,
  type SignupState,
} from "./signupTransition"

/** Failures passkey_ceremony reports, which onboarding_failed leaves to it. */
const PASSKEY_STEP_CODE = /^(passkey_|signin_|popup_blocked$)/
const CREATE_PASSKEY: PasskeyAttemptContext = { ceremony: "create", flow: "onboarding" }
const REUSE_PASSKEY: PasskeyAttemptContext = { ceremony: "sign_in", flow: "onboarding" }
/** How long an earned-price replacement waits on the old address's broadcast. */
const REPLACE_SETTLE_MS = 60_000

/** What the flow calls out to; tests stand in for any of them. */
export const SIGNUP_IO = {
  telemetry: () => passkeyTelemetry,
  fire: fireEvent,
  fireOnboarding: fireOnboardingEvent,
  landing: reportLanding,
  report: showReportableError,
  createAccount,
  claimTag,
  getClaimStatus,
  drawTag,
  grantIsCurrent: routeGrantIsCurrent,
  reuse: reusePasskeyAccount,
  viewLink,
  claimLink: claimSponsoredLink,
  ticketActivation,
}

/** A dev build's `?mock=` preview, which fakes every backend step (`dev/mockOnboarding.ts`). */
export interface OnboardingMock {
  step: "create" | "claim" | "pending"
  busy: boolean
  handle: string
  /** Set only for the deposit-panel previews: a synthetic record, never the chain's. */
  depositPhase?: "awaiting_deposit" | "funded"
  free?: boolean
  expired?: boolean
  /** The schedule the previews quote, and a deposit already at the address, in base units. */
  min: bigint
  fee: bigint
  received?: bigint
  tokenSymbol: string
}

export interface SignupDeps {
  /** The session the screen opened under. */
  session: Session
  io?: Partial<typeof SIGNUP_IO>
  /** The page's preview, in a dev build that asked for one. */
  mock?: OnboardingMock | null
}

/** The screen's latest render: what the flow reads when it acts, not when it opened. */
export interface SignupInputs {
  navigate: NavigateFunction
  gate: { gate: CeremonyGate; cancel(): void; dismiss(): void }
  /** The ticket signup's hold and speed, from the paylink's hooks. */
  ticketHeld: boolean
  ticketSpeed?: Pick<RegistrationSpeed, "decision" | "settle">
  embedded: boolean
  draftTag?: string
  ticketSignup: boolean
  paylinkKit?: PaylinkKit
  /** The tag `/claim/:handle` names, folded. */
  routeHandle?: string
  pathname: string
  params: URLSearchParams
  /** The owner `/enter` checked a bound grant for. */
  boundGrantOwner?: string
  next?: string
}

/** A `paid` marker's link, with the tip its split committed: it pays the deposit it covers. */
function linkDeposit(marker: TicketSignupStash | null): LinkDeposit | undefined {
  if (!marker?.paid || marker.amount === undefined) return undefined
  return {
    fragment: marker.fragment,
    amount: BigInt(marker.amount),
    proverTip: BigInt(marker.proverTip ?? 0),
    ...(marker.speed ? { speed: marker.speed } : {}),
    ...(marker.withdrawalFee !== undefined ? { withdrawalFee: marker.withdrawalFee } : {}),
    ...(marker.senderTag ? { senderTag: marker.senderTag } : {}),
  }
}

/** Dev preview only: a claim and record the deposit panel renders, never written anywhere. */
function previewOf(
  mock: OnboardingMock | null,
  l1ChainId: number,
): {
  claim: NameClaimResponse | undefined
  record: PendingRegistrationRecord | null
} {
  if (!mock?.depositPhase) return { claim: undefined, record: null }
  const now = Math.floor(Date.now() / 1000)
  return {
    claim: {
      signature: "0x00",
      nonce: "1",
      deadline: String(now + (mock.expired ? -60 : 3600)),
      hold: { deadline: String(now + 7 * 86_400) },
      terms: {
        fee: String(mock.fee),
        minDeposit: String(mock.min),
        nonce: "1",
        deadline: "9999999999",
        signature: "0x00",
        reduced: mock.free === true,
        ticket: false,
      },
    },
    record: {
      account: `0x${"0".repeat(38)}f1`,
      tag: mock.handle,
      nameHash: `0x${"11".repeat(32)}` as Hex,
      l2Address: `0x${"22".repeat(32)}` as Hex,
      l1ChainId,
      sipaAddress: `0x${"0".repeat(38)}c3`,
      fee: "0",
      beneficiary: `0x${"0".repeat(38)}b5`,
      depositToken: `0x${"0".repeat(38)}d4`,
      broadcast: true,
      phase: mock.depositPhase,
      retries: 0,
      startTime: Date.now(),
      ...(mock.depositPhase === "funded" ? { fundedAt: Date.now() } : {}),
    } satisfies PendingRegistrationRecord,
  }
}

export function openSignupFlow(deps: SignupDeps, latest: () => SignupInputs) {
  const io = { ...SIGNUP_IO, ...deps.io }
  // What the signup is decides at open; the rest is read as it acts.
  const inputs = latest()
  const { draftTag, routeHandle, params } = inputs
  const { config } = deps.session.page
  const { signup, pastUser, claims } = deps.session
  /** The session commands run under: the screen's, then whatever each hand-off returns. */
  let session = deps.session

  const fromPaylink = inputs.ticketSignup && Boolean(peekTicketSignup(tabStash)) && !routeHandle
  const ticketFragment = fromPaylink ? peekTicketSignup(tabStash)?.fragment : undefined
  const readTicketAttempt = () =>
    ticketFragment
      ? loadTicketSignupAttempt(session, config.rpId, linkIdentity(ticketFragment))
      : null
  const ticketAttempt = (() => {
    try {
      return readTicketAttempt()
    } catch {
      return null
    }
  })()
  const resumedTicket = ticketAttempt !== null && !isTicketSignupCreating(ticketAttempt)
  const resuming = params.get("resume") === "1"
  const recoveryVisit = params.get("recovery") === "1"
  const entryCohort = routeHandle ? "link" : "direct"
  const mock = deps.mock ?? null
  const preview = previewOf(mock, config.l1ChainId)
  const openRecord = ticketFragment
    ? ticketSignupRegistration(
        session,
        ticketFragment,
        resumedTicket ? ticketAttempt.l2Address : undefined,
      )
    : latestOpenRegistration(loadedRegistrations(session.registrations))
  const hasRouteGrant = () => {
    const tag = latest().routeHandle
    return Boolean(tag && signup.grantToken(tag))
  }
  // A visitor with nothing here yet: no account, no record, no link naming a tag.
  const freshStart =
    !mock &&
    !inputs.embedded &&
    !fromPaylink &&
    !routeHandle &&
    !openRecord &&
    !resuming &&
    !recoveryVisit &&
    !hasRouteGrant() &&
    !session.identity.get().value
  // A tag settled on before a reload: a kept draw or a past user's pick is still the drawn offer.
  const chosen = draftTag ? signup.state.get().chosenTag : undefined
  const restored =
    chosen && (chosen.route === "paid" || chosen.tag === draftTag) ? chosen : undefined
  // "Create Account", tapped while the wallet started: busy from the first frame.
  const startedBeforeBoot = freshStart && session.page.preBoot.taps.get().create

  const state = memoryStore<SignupState>({
    step:
      mock?.step ??
      (openRecord ? "pending" : fromPaylink ? (ticketAttempt ? "terms" : "tag") : "invite"),
    handle:
      normalizeTag(
        restored?.tag ??
          draftTag ??
          mock?.handle ??
          routeHandle ??
          openRecord?.tag ??
          ticketAttempt?.tag ??
          "",
      ) ?? "",
    route: restored?.route ?? (draftTag ? "random" : undefined),
    chosenTag: restored?.tag,
    pickingName: false,
    inviteBusy: startedBeforeBoot,
    modalBusy: mock?.busy ?? false,
    busyPhase: "passkey",
    busy: 0,
    retrying: false,
    reading: false,
    entryFailed: false,
    claimLeft: false,
    freshClaim: preview.claim,
    oxideAccount: openRecord?.account,
    ticketAttempt,
    recovered: false,
  })
  const dispatch = (event: SignupEvent) => state.set(signupTransition(state.get(), event))
  const s = () => state.get()

  /** The tag step's field, or the invitation's, which shows without a draw or a fresh start. */
  const typed = memoryStore(
    normalizeTag(fromPaylink ? s().handle : routeHandle ?? openRecord?.tag ?? "") ?? "",
  )
  const tagInput = tagField(deps.session.page, typed, { signup, routeHandle }, state, ({ step }) =>
    step === "invite" ? !draftTag && !freshStart : step === "tag",
  )
  /** A return to the tag step shows the tag the signup holds, as the step's first showing does. */
  let shownStep = s().step
  const reseedTag = () => {
    const { step, handle } = s()
    if (step === "tag" && shownStep !== "tag") typed.set(handle)
    shownStep = step
  }

  /** Each command's abort: a newer run of it, the user's cancel, or the screen leaving ends it. */
  let invite = new AbortController()
  let draw = new AbortController()
  let op = new AbortController()
  const restart = (c: AbortController) => (c.abort(), new AbortController())
  let fastRefusals = 0
  let attempted: CreateAttempt | undefined
  let lastAttempt: PasskeyAttemptContext | undefined
  /** The option the ticket signup's own sheet picked: the gate then holds no sheet of its own. */
  let unheld: { choice: SignUpChoice; supported: readonly string[] } | undefined
  /** How the next creation's sheet opens: a refusal's way back, or a closed prompt's. */
  let reopen: { openOn: SignUpChoice; reopened?: SheetReopen } | undefined
  let restartId: string | undefined
  let createAttempts = 0
  let completed = false
  let failedEntry: (() => Promise<void>) | undefined
  let paylinkSettling = false
  let renewalRefused = false
  let startedAt = performance.now()
  const attempts = new Map<PasskeyAttemptHandle, AbortController>()
  /** The manual sweep on the deposit sheet runs its own attempt; the sheet's exits speak for it. */
  const sweepAttempt = { current: undefined as PasskeyAttemptHandle | undefined }

  const abandonOp = () => {
    op = restart(op)
    fastRefusals = 0
  }
  /** Every running attempt, or with `current` only those of the running op. */
  const markAttempts = (cause: "userCancelled" | "superseded" | "unmounted", current = false) => {
    for (const [attempt, of] of attempts) if (!current || of === op) attempt[cause]()
    if (!current) sweepAttempt.current?.[cause]()
  }
  const passkeyAttempt = <T>(
    context: PasskeyAttemptContext,
    fn: (scope: PasskeyRequestScope, attempt: PasskeyAttemptHandle) => Promise<T>,
  ): Promise<T> => {
    // The gate this attempt takes cancels whatever was waiting on it: the older ones are replaced.
    markAttempts("superseded")
    lastAttempt = context
    const attempt = io.telemetry().begin(context)
    attempts.set(attempt, op)
    return attempt.run((scope) => fn(scope, attempt)).finally(() => attempts.delete(attempt))
  }
  const handOff = (keys: OnboardingKeys) => (session = handOffAccount(session, keys.account))
  const reuse = (
    address: string,
    hints: Parameters<typeof reusePasskeyAccount>[3],
    signal?: AbortSignal,
  ) => {
    const wallet = valueOf(session.wallet)
    if (!wallet) throw new WalletError("wallet.notReady")
    return passkeyAttempt(REUSE_PASSKEY, (scope) =>
      io.reuse(
        wallet,
        { session, accounts: () => signedInAccount(session) },
        address,
        hints,
        latest().gate.gate,
        signal,
        scope,
      ),
    )
  }

  const go = (to: string) =>
    latest().navigate(to, {
      replace: true,
      ...(latest().next ? { state: { next: latest().next } } : {}),
    })
  // A leftover inbound stash still claims on Home, unless a signup's own claim is spending it.
  const intoWallet = () => go(peekClaimStash(tabStash) ? "/" : latest().next ?? "/")
  /** Every signup exit into the wallet; the entry is reported for the account's first one only. */
  const enterWallet = () => {
    const report = () =>
      io.fireOnboarding("wallet_entered", { entry: fromPaylink ? "ticket" : entryCohort })
    if (session.identity.get().value?.address === undefined) report()
    // Only the account's first entry reports; a mark that cannot be read is not a first.
    else
      void bestEffort(
        "unknown",
        session.accountRecord?.apply({ type: "entered" }) ?? Promise.resolve(undefined),
      ).then((first) => first && report())
    intoWallet()
  }

  /** The record the pending step shows: a dev preview's, else the live one this signup watches. */
  const record = (): PendingRegistrationRecord | null => {
    if (preview.record) return preview.record
    const records = loadedRegistrations(session.registrations)
    const { oxideAccount, handle, ticketAttempt } = s()
    const pinned = oxideAccount ? latestRegistration(records, oxideAccount) : null
    if (!fromPaylink) return latestOpenRegistration(records) ?? pinned
    const address =
      ticketAttempt && !isTicketSignupCreating(ticketAttempt) ? ticketAttempt.l2Address : undefined
    const matching = ticketFragment
      ? ticketSignupRegistration(session, ticketFragment, address)
      : null
    // Keep this session's record through settlement or a paused-ticket fallback.
    return (
      matching ??
      (pinned &&
      pinned.tag === handle &&
      (!address || pinned.l2Address.toLowerCase() === address.toLowerCase())
        ? pinned
        : null)
    )
  }
  const inAppHold = () => walletInAppUpFront(session.device.get(), config.rpId) !== undefined
  /** The pending step prices the record's own route; the terms step and the claim, the tag's. */
  const expectedEarned = () => {
    const rec = record()
    if (s().step === "pending" && rec && !mock) return expectsEarned(rec)
    const terms = rec ? loadRegistrationTerms(session.registrations, rec.account, rec.tag) : null
    const { route } = s()
    return (
      terms?.earnedExpected === true ||
      (rec !== null && hasDepositAdmission(session.sipaDeposits, rec)) ||
      route === "random" ||
      route === "past_user"
    )
  }

  /** The pending step's commands: failures open the error modal and reach analytics. */
  const run = async (fn: () => Promise<void>, action: string, context: string) => {
    dispatch({ type: "busy", delta: 1 })
    try {
      await fn()
    } catch (e) {
      io.report(e, context)
      io.fire("action_failed", { action, code: failureCode(e) })
    } finally {
      dispatch({ type: "busy", delta: -1 })
    }
  }

  // ponytail: dev mock — spin briefly, then advance; no backend, no analytics.
  const mockAdvance = () => {
    op = restart(op)
    const { signal } = op
    dispatch({ type: "claiming" })
    const timer = setTimeout(() => {
      dispatch({ type: "opEnded" })
      enterWallet()
    }, 200000)
    signal.addEventListener("abort", () => clearTimeout(timer))
  }

  const logIn = () => {
    const note = s().inviteNote
    const taken = note?.kind === "taken" ? note.handle : undefined
    go(taken ? `/enter?handle=${encodeURIComponent(taken)}` : "/enter")
  }

  /** "Activate account": the claim-status read gates create vs. already-claimed. */
  const unlockAccess = async (typedHandle: string) => {
    const handle = normalizeTag(typedHandle) ?? ""
    if (mock) {
      dispatch({ type: "settled", handle, route: s().route, chosen: s().chosenTag })
      return dispatch({ type: "to", step: "terms" })
    }
    invite = restart(invite)
    const { signal } = invite
    dispatch({ type: "checking", handle })
    try {
      const status = await io.getClaimStatus(session.page, handle)
      if (signal.aborted) return
      io.fireOnboarding("onboarding_handle_checked", {
        status: status === "claimed" ? "taken" : "available",
      })
      if (status !== "claimed") {
        // Only this ticket's reservation can be abandoned when the visitor changes its tag.
        const open = record()
        if (fromPaylink && open && open.tag !== handle && !hasCustody(open))
          await abandonPendingRegistration(session, open.account)
      }
      dispatch({ type: "checked", taken: status === "claimed" })
      if (status === "claimed") return
      if (s().keys) void claimTagStep()
      // On a phone the tag step's claim button is the passkey's button: the welcome step runs it.
      else if (fromPaylink && currentDevicePosture() === "phone" && passkeysSupported())
        void continueSignup()
    } catch (err) {
      if (signal.aborted) return
      io.fire("action_failed", { action: "unlock_access", code: failureCode(err) })
      dispatch({ type: "inviteFailed", note: { kind: "unverified", error: err } })
    }
  }

  /** Abandons the handle-availability read: a settled response after this becomes a no-op. */
  const cancelUnlock = () => {
    invite = restart(invite)
    dispatch({ type: "inviteSettled" })
  }

  /** An open stashed link, which a signup started here picks its name on instead of a draw. */
  const stashedLinkOpen = () => {
    const wallet = valueOf(session.wallet)
    const contractService = valueOf(session.contractService)
    return fromPaylink || !wallet || !contractService
      ? Promise.resolve(null)
      : openStashedLink({ session, wallet, contractService })
  }
  /** The link's own signup, which pays for the name when the link can. */
  const toLinkSignup = (fragment: string) =>
    latest().navigate(`/link#${fragment}`, { replace: true, state: RECEIVE_TO_ACCOUNT })

  /** The settled tag, kept for the tab; a draw still in flight changes nothing after it. */
  const choose = (chosen: ChosenTag | undefined, handle = s().handle) => {
    draw = restart(draw)
    signup.setChosenTag(chosen)
    dispatch({ type: "settled", route: chosen?.route ?? s().route, handle, chosen: chosen?.tag })
  }

  /** "Create Account": the claim server draws the tag, and the passkey and claim run at once. */
  const createDrawnWallet = async () => {
    invite = restart(invite)
    const { signal } = invite
    dispatch({ type: "checking", handle: s().handle })
    io.fireOnboarding("onboarding_create_attempted", {
      attempt: ++createAttempts === 1 ? "1" : "2+",
    })
    try {
      const linked = await stashedLinkOpen()
      if (signal.aborted) return
      if (linked) return toLinkSignup(linked)
      const { tag, grantToken } = await io.drawTag(session.page)
      if (signal.aborted) return
      io.fireOnboarding("onboarding_tag_drawn")
      signup.stashDrawnGrant(tag, grantToken)
      // Home holds the keep-or-choose, and the passkey runs from there.
      signup.setDrawnOffer(tag)
      latest().navigate("/")
    } catch (err) {
      if (signal.aborted) return
      const code = failureCode(err)
      io.fire("action_failed", { action: "draw_tag", code })
      io.fireOnboarding("onboarding_failed", { step: "draw", code })
      return dispatch({ type: "inviteFailed", note: { kind: "drawFailed" } })
    } finally {
      if (!signal.aborted) dispatch({ type: "inviteSettled" })
    }
  }

  /** Swaps the shown tag for another draw, dropping any kept or picked one. */
  const rerollDrawnTag = async () => {
    draw = restart(draw)
    const { signal } = draw
    try {
      const { tag, grantToken } = await io.drawTag(session.page)
      if (signal.aborted) return
      io.fireOnboarding("onboarding_tag_drawn", { shuffle: true })
      signup.stashDrawnGrant(tag, grantToken)
      signup.setDrawnOffer(tag)
      signup.setChosenTag(undefined)
      dispatch({ type: "settled", route: s().route, handle: s().handle })
    } catch (err) {
      io.fire("action_failed", { action: "draw_tag", code: failureCode(err) })
    }
  }

  /** Keeps the drawn tag: the passkey and the claim run under it. */
  const keepDrawnTag = () => {
    const drawn = latest().draftTag
    // A past user's pick became the draft, so a reload keeps it free.
    const route = drawn && pastUser.state.get().verified?.tag === drawn ? "past_user" : "random"
    choose(drawn ? { tag: drawn, route } : undefined, normalizeTag(drawn || "") ?? "")
  }

  /** Home's passkey step: the passkey and the claim run under the chosen tag. */
  const createChosenAccount = () => {
    // A shuffle still in flight would replace the grant the claim spends.
    draw = restart(draw)
    // An in-app browser holds at the terms sheet, which explains why no passkey can start.
    if (inAppHold()) return dispatch({ type: "to", step: "terms" })
    dispatch({ type: "to", step: "create" })
    void createAccountStep()
  }

  /** The visitor's own tag: free when a past user's proof earns its grant, else paid. */
  const pickOwnTag = async (name: string) => {
    const verified = pastUser.state.get().verified
    const free = verified !== undefined && verified.tag === undefined
    if (free) {
      try {
        signup.stashDrawnGrant(name, await grantPastUser(session.page, verified, name))
      } catch (err) {
        // A spent proof never earns a grant: the pick falls back to the paid price.
        if (!(err instanceof PastUserAlreadyUsedError)) throw err
        pastUser.claimedAtGrant()
        return
      }
      pastUser.setVerified({ ...verified, tag: name })
      // The drawn tag's grant is gone: the pick is what a reload resumes.
      signup.setDrawnOffer(name)
    }
    choose({ tag: name, route: free ? "past_user" : "paid" }, name)
    io.fireOnboarding("name_route_chosen", { route: free ? "past_user" : "pay" })
  }

  /** Every ticket claim retry must use its durable account binding and loaded account stores. */
  const resumeTicketWithKeys = async (keys: OnboardingKeys, before = session) => {
    if (!fromPaylink || !ticketFragment) return false
    const ticketId = linkIdentity(ticketFragment)
    const binding = loadTicketSignupAccount(session, config.rpId, ticketId)
    const address = keys.account.getAddress().toString()
    if (!binding || binding.l2Address.toLowerCase() !== address.toLowerCase())
      throw new WalletError("onboarding.signupUnsaved")
    dispatch({ type: "ticketAttempt", attempt: binding })
    if (reloadIfSessionSwitched(before, address)) {
      abandonOp()
      return true
    }
    const pending = ticketSignupRegistration(session, ticketFragment, address)
    const { handle } = s()
    if (pending) {
      dispatch({ type: "resumed", account: pending.account, handle: pending.tag })
      return true
    }
    if (!handle) {
      dispatch({ type: "to", step: "tag" })
      return true
    }
    if (binding.tag !== handle)
      await saveTicketSignupAccount(session, config.rpId, ticketId, { ...binding, tag: handle })
    return false
  }

  /**
   * Acquires the account keys, then claims the tag on the same spinner. Keys a cancelled ceremony
   * still made are kept, so the next click claims with no second prompt.
   */
  const acquireAndClaim = async (acquire: (signal: AbortSignal) => Promise<OnboardingKeys>) => {
    if (s().keys) return claimTagStep()
    op = restart(op)
    const ran = op
    const { signal } = ran
    const before = session
    lastAttempt = undefined
    // A pick the screen's own sheet took carries its warning in; every other run starts clean.
    dispatch({ type: "creating", keepWarning: unheld !== undefined })
    try {
      const elapsed = lapTimer()
      const keys = await acquire(signal)
      const address = keys.account.getAddress().toString()
      dispatch({ type: "keys", keys, address, recovered: s().recovered })
      if (ran !== op) return
      fastRefusals = 0
      const { handle, route } = s()
      const claimRoute = handle ? (fromPaylink ? "ticket" : route) : undefined
      // Sent before a ticket resume or session reload can leave the page: the request outlives it.
      io.fireOnboarding("onboarding_account_created", {
        duration_ms: elapsed(),
        mode: lastAttempt === CREATE_PASSKEY ? "create" : "enter",
        route: claimRoute,
      })
      if ((await resumeTicketWithKeys(keys, before)) || ran !== op || signal.aborted) return
      if (reloadIfSessionSwitched(before, address)) return abandonOp()
      dispatch({ type: "claiming" })
      await claimAndApply(keys, claimRoute)
      // Kept at signup: the tag is settled, so its address may be broadcast.
      const claimed = route === "random" || route === "past_user" ? record() : null
      if (claimed) await session.confirmTag(claimed)
      // The account is entered: Home stops hosting the signup and opens on it.
      if (
        latest().draftTag &&
        enteredIdentity(session.identity.get(), session.device.get().passkeyMap, config.rpId)
      )
        signup.setDrawnOffer(undefined)
      signup.setTagDraft("")
      signup.setChosenTag(undefined)
    } catch (err) {
      if (ran !== op || isGateCancelled(err) || signal.aborted) return
      // An unreadable attempt leaves the original error, shown below.
      if (fromPaylink)
        bestEffortSync(
          () => dispatch({ type: "ticketAttempt", attempt: readTicketAttempt() }),
          undefined,
        )
      const code = failureCode(err)
      if (s().keys) return claimFailed(err)
      io.fire("action_failed", { action: "create_account", code })
      if (!PASSKEY_STEP_CODE.test(code))
        io.fireOnboarding("onboarding_failed", { step: "account", code })
      const creating = lastAttempt === CREATE_PASSKEY
      // Only a fresh create can start again in another browser: a reuse, or any attempt in a
      // browser that holds an account, needs an account that browser doesn't have.
      const classified = classifyCreateFailure(err, {
        attempted: creating ? attempted : undefined,
        portable: creating && !session.identity.get().value,
        fastRefusals,
      })
      attempted = undefined
      fastRefusals = classified.fastRefusals
      const { failure } = classified
      if (failure.kind === "refusal")
        dispatch({ type: "createFailed", refusal: failure.refusal, toCreate: failure.toCreate })
      else if (failure.kind === "error") dispatch({ type: "createFailed", error: failure.error })
      else if (failure.kind === "reopen") {
        restartId = failure.restart
        reopen = { openOn: failure.openOn, reopened: failure.reopened }
        void createAccountStep()
      }
    } finally {
      if (ran === op) dispatch({ type: "opEnded" })
    }
  }

  /** A claim that failed after the keys: a refused name steers back, anything else can retry. */
  const claimFailed = (err: unknown, current = true) => {
    const code = failureCode(err)
    io.fire("action_failed", { action: "claim_tag", code })
    io.fireOnboarding("onboarding_failed", { step: "claim", code })
    if (current && !steerAfterNameRefusal(err)) dispatch({ type: "claimFailed", error: err })
  }

  /** The split's decision at the user's last tap; work after the tap never reads a newer quote. */
  let tapped: SpeedDecision | undefined
  const onTap =
    <A extends unknown[], R>(command: (...args: A) => R) =>
    (...args: A): R => {
      tapped = latest().ticketSpeed?.decision
      return command(...args)
    }
  /** A tap's speed: the stash keeps it until the terms take it, then the terms. */
  const commitTicketSpeed = async (decided: SpeedDecision | undefined) => {
    if (!decided) return
    const { tip, speed, withdrawalFee } = decided
    updateTicketSignup(tabStash, { proverTip: tip.toString(), speed, ...feeField(withdrawalFee) })
    const rec = record()
    if (rec)
      await commitRegistrationProverTip(session.registrations, rec, tip, speed, withdrawalFee)
  }

  /**
   * A new ticket signup creates a passkey; an interrupted one recovers only its bound account.
   * Ordinary signup reuses a nameless identity's account, or the account of a key this tab still
   * holds, instead of minting a second one.
   */
  const createAccountStep = () => {
    if (mock) return mockAdvance()
    // The attempt a closed prompt left `creating` is restarted by this pick. A held payment opens
    // no sheet, so the way back to one is dropped.
    const restarting = restartId
    restartId = undefined
    if (latest().ticketHeld) {
      reopen = undefined
      return
    }
    if (fromPaylink) {
      tapped ??= latest().ticketSpeed?.settle()
      void bestEffort("unknown", commitTicketSpeed(tapped))
    }
    const identity = session.identity.get().value
    const namelessAddress = identity && !identity.handle ? identity.address : undefined
    const { handle } = s()
    return acquireAndClaim(async (signal) => {
      const ticket = fromPaylink ? peekTicketSignup(tabStash) : null
      if (fromPaylink && !ticket) throw new WalletError("onboarding.linkMissing")
      const ticketId = ticket ? linkIdentity(ticket.fragment) : undefined
      const adopt = async (address: string, hints: Parameters<typeof reusePasskeyAccount>[3]) => {
        const keys = await reuse(address, hints, signal)
        if (!signal.aborted) handOff(keys)
        return keys
      }
      if (ticketId && !restarting) {
        const prior = loadTicketSignupAccount(session, config.rpId, ticketId)
        if (prior) {
          // A bound ticket signs in: the sheet's pick and its warning were for a creation.
          unheld = undefined
          dispatch({ type: "warning" })
          return adopt(prior.l2Address, { credentialId: prior.credentialId })
        }
      }
      // A cached key is proved against the account it names before it is handed back.
      const fromCache = async () => {
        const cached = await session.auth.recoverFromCache()
        if (!cached?.expectedAddress) return undefined
        // A key a payment link's signup made belongs to that link's signup, named for its tag.
        if (!fromPaylink && boundToTicketSignup(session, config.rpId, cached.credentialId))
          return undefined
        return adopt(cached.expectedAddress, { credentialId: cached.credentialId })
      }
      // Resuming continues this session's signup, so its own key goes before any identity.
      if (!fromPaylink && resuming) {
        const keys = await fromCache()
        if (keys) return keys
      }
      if (!fromPaylink && namelessAddress) {
        // The session's own passkey, else the chooser; a tab with no session takes the record
        // that opened this account.
        const { credentialId, storageId } = session.device.get()
        return adopt(
          namelessAddress,
          storageId
            ? credentialId
              ? { credentialId }
              : { discover: true, chooser: true }
            : { credentialId: await session.auth.rootCredentialId(namelessAddress) },
        )
      }
      // A stored identity means an account here already: a fresh signup adopts no cached key.
      if (!fromPaylink && !identity && !resuming) {
        const keys = await fromCache()
        if (keys) return keys
      }
      // A resumed signup's passkey exists: with nothing here naming it, /enter finds it again.
      if (!fromPaylink && resuming) {
        go(handle ? `/enter?handle=${encodeURIComponent(handle)}` : "/enter")
        // Abandoned as a cancel is, so leaving raises nothing and leaves no spinner.
        abandonOp()
        dispatch({ type: "opEnded" })
        throw new WalletError("aborted", "resuming through the recovery screen")
      }
      // A ticket-funded signup proves its golden ticket in this PXE before the NameClaim.
      const wallet = valueOf(session.wallet)
      if (fromPaylink && !wallet) throw new WalletError("wallet.notReady")

      const account = await passkeyAttempt(CREATE_PASSKEY, async (scope, attempt) => {
        // A sheet's pick and a way back to it each serve one gate call.
        const pick = unheld
        unheld = undefined
        const back = reopen
        reopen = undefined
        const { choice, route, reach, creation } = await latest().gate.gate({
          purpose: "create",
          ...(pick ? { unheld: pick } : {}),
          ...back,
        })
        const gated = fromPaylink ? afterGate(tapped, latest().ticketSpeed?.decision) : tapped
        if (gated !== tapped) {
          tapped = gated
          void bestEffort("unknown", commitTicketSpeed(gated))
        }
        // A route means a laptop creation, the only gate that checks for a phone.
        if (route) attempt.notePhoneReach(reach)
        const tried: CreateAttempt = { choice, route, reach, creation }
        attempted = tried
        if (ticketId && restarting) {
          await restartTicketSignupAccount(session, config.rpId, ticketId, restarting)
          dispatch({ type: "ticketAttempt", attempt: null })
        }
        const begun = ticketId
          ? await beginTicketSignupAccount(session, config.rpId, ticketId, handle)
          : null
        if (begun) {
          dispatch({ type: "ticketAttempt", attempt: begun })
          tried.ticketAttemptId = begun.attemptId
        }
        session.auth.useLaptopCreation(creation ?? PHONE_CREATION, choice)
        // Counted when the creation is asked for: a held sheet or a refused ticket restart is none.
        if (fromPaylink) {
          io.fireOnboarding("onboarding_create_attempted", {
            attempt: ++createAttempts === 1 ? "1" : "2+",
            entry: "ticket",
          })
        }
        if (!wallet) throw new WalletError("wallet.missing")
        const built = await io.createAccount(
          { wallet, authService: session.auth, accounts: () => signedInAccount(session) },
          AUTH_TYPE.WEB_AUTHN,
          statusForAttempt(scope),
          handle,
          {
            prod: config.network !== Network.SANDBOX,
            route,
            signal,
            ...(begun && ticketId
              ? {
                  onAccountCreated: (created: { credentialId: string; l2Address: string }) =>
                    completeTicketSignupAccount(
                      session,
                      config.rpId,
                      ticketId,
                      begun.attemptId,
                      created,
                    ),
                }
              : {}),
          },
        )
        session = handOffAccount(session, built)
        return built
      })
      dispatch({ type: "keys", created: account.getAddress().toString(), recovered: s().recovered })
      return collectOnboardingKeys(session, account)
    })
  }

  /** Claims the tag in the session the keys were handed to, then routes the outcome. */
  const claimAndApply = async (
    keys: OnboardingKeys,
    route?: RegistrationRoute,
    replacing?: { refunded?: PendingRegistrationRecord; replaced?: PendingRegistrationRecord },
  ) => {
    const wallet = valueOf(session.wallet)
    if (!wallet) throw new WalletError("wallet.notReady")
    if (fromPaylink) await commitTicketSpeed(tapped)
    const ticketMarker = fromPaylink ? peekTicketSignup(tabStash) : null
    const elapsed = lapTimer()
    const lap = lapTimer()
    dispatch({ type: "stage" })
    // Every key this screen holds was handed to the session it claims in.
    handOff(keys)
    const { handle } = s()
    const tag = replacing?.refunded?.tag ?? replacing?.replaced?.tag ?? handle
    const outcome = await io.claimTag(
      session,
      tag,
      keys,
      config,
      wallet,
      replacing
        ? undefined
        : (stage) => {
            dispatch({ type: "stage", stage })
            if (isRegistrationStage(stage))
              io.fireOnboarding("onboarding_oxide_stage", { stage, prev_stage_ms: lap() })
          },
      replacing ? true : expectedEarned(),
      replacing?.refunded,
      replacing?.replaced,
      replacing ? null : ticketMarker?.paid ? null : ticketMarker,
      replacing ? undefined : linkDeposit(ticketMarker),
      route,
    )
    // Confirmed on-chain only: a submitted op's is the detection tick's to report.
    if (outcome.kind === "custody" && !replacing) {
      io.fireOnboarding("onboarding_tag_claimed", { duration_ms: elapsed() })
      // No detection tick runs for a record that closes here, so this caches the claim.
      cacheConfirmedNameClaim(session.nameClaims, session.page, {
        account: outcome.oxideAccount,
        tag: handle,
        l2Address: keys.account.getAddress().toString(),
      })
    }
    await applyClaimOutcome(outcome)
  }

  /** Every claim outcome enters: Home asks for a deposit still owed, and claims a ticket's link. */
  const applyClaimOutcome = async (outcome: ClaimTagOutcome) => {
    dispatch({ type: "claimed", account: outcome.oxideAccount })
    if (outcome.kind === "custody") return enter(s().handle, true)
    const ticket = fromPaylink ? peekTicketSignup(tabStash) : null
    if (ticket?.paid) {
      // A link that cannot cover the name's own price is claimed on Home as any other.
      if (!outcome.depositLink) clearTicketSignup(tabStash)
    } else if (ticket && !wireTermsFundTicket(outcome.claim.terms)) {
      if (!outcome.ticketUnavailable) {
        await abandonPendingRegistration(session)
        throw new WalletError("registration.ticketRefused")
      }
      // Tickets paused: the signed price stands, and Home claims the link as any other.
      clearTicketSignup(tabStash)
      io.fire("paylink_ticket_paused")
      dispatch({ type: "note", note: { kind: "ticketPaused" } })
    }
    dispatch({ type: "claimed", account: outcome.oxideAccount, claim: outcome.claim })
    return enter(s().handle, true)
  }

  /**
   * Saves the identity, then enters. A `live` signup reports its completion once. A failed save
   * keeps the screen, and only its retry enters.
   */
  const enter = async (tag: string, live: boolean): Promise<void> => {
    const { oxideAccount, address: keysAddress } = s()
    const pinned = oxideAccount
      ? latestRegistration(loadedRegistrations(session.registrations), oxideAccount)
      : null
    const rec = live ? pinned : record()
    const address = (live ? keysAddress : undefined) ?? record()?.l2Address
    if (!address) return
    if (live && !completed) {
      completed = true
      io.fireOnboarding("onboarding_completed", {
        total_duration_ms: Math.round(performance.now() - startedAt),
        named: !!tag,
      })
    }
    const confirmed = rec?.phase === "confirmed"
    try {
      await saveIdentity(session.page, {
        handle: tag,
        address,
        claimedAt: Date.now(),
        ...(rec && !confirmed ? { pending: true } : {}),
      })
    } catch (e) {
      failedEntry = () => enter(tag, live)
      dispatch({ type: "entry", failed: true })
      io.report(e, "onboarding:identity", {
        retry: { label: copy.retryEnter, run: () => void failedEntry?.() },
      })
      return
    }
    dispatch({ type: "entry", failed: false })
    // An account created here is new on this version: nothing older to upgrade.
    if (s().created === address) markNewAccountHere(config, address)
    if (confirmed) signup.clearGrant(tag)
    // A deposit cannot recreate missing passkey metadata: the account is recovered on /enter.
    if (
      !live &&
      !enteredIdentity(session.identity.get(), session.device.get().passkeyMap, config.rpId)
    )
      go(`/enter?handle=${encodeURIComponent(tag)}`)
    else enterWallet()
  }

  /** Claim retry. A cancel stops the spinner; a submission that lands anyway still routes. */
  const claimTagStep = async () => {
    if (mock) return mockAdvance()
    const { keys } = s()
    if (!keys) return dispatch({ type: "to", step: "create" })
    op = restart(op)
    const ran = op
    dispatch({ type: "claiming" })
    try {
      if ((await resumeTicketWithKeys(keys)) || ran !== op || ran.signal.aborted) return
      const { handle, route } = s()
      await claimAndApply(keys, handle ? (fromPaylink ? "ticket" : route) : undefined)
    } catch (err) {
      claimFailed(err, ran === op)
    } finally {
      if (ran === op) dispatch({ type: "opEnded" })
    }
  }

  /** Cancel on a running sheet. Before a device is chosen the sheet returns to the terms. */
  const cancelModalOp = (gateOpen: boolean) => {
    markAttempts("userCancelled", true)
    const { step, busyPhase } = s()
    abandonOp()
    latest().gate.cancel()
    dispatch({
      type: "cancelled",
      toTerms: step === "create" && busyPhase === "passkey" && gateOpen,
    })
  }

  /** Back to the invitation page, retaining the name on a grant link. */
  const steerToInvite = (note?: InviteNote) => {
    abandonOp()
    latest().gate.cancel()
    dispatch({ type: "steered", note, step: fromPaylink ? "tag" : "invite" })
    const { pathname, routeHandle: tag } = latest()
    if (!pathname.startsWith("/claim")) return
    const query = resuming ? "?resume=1" : ""
    go(hasRouteGrant() && tag ? `/claim/${encodeURIComponent(tag)}${query}` : `/claim${query}`)
  }
  /** The user's own close of a sheet: back to the invitation, the running attempt cancelled. */
  const closeToInvite = () => {
    markAttempts("userCancelled")
    steerToInvite()
  }

  /** A refused name goes back to the field with the reason, keys still in hand. */
  const steerAfterNameRefusal = (err: unknown): boolean => {
    if (!(err instanceof NameTakenError)) return false
    markAttempts("superseded")
    // The name is gone: the draft reopens the choice, with the refusal, for the account kept.
    choose(undefined)
    steerToInvite({ kind: "refused", error: err })
    return true
  }

  /** Keys and identity leave, and the invitation is back. `lost` names a tag someone else took. */
  const signOutTo = (lost?: string) => {
    markAttempts(lost ? "superseded" : "userCancelled")
    abandonOp()
    dispatch({ type: "opEnded" })
    dispatch({ type: "keys", keys: undefined, recovered: false })
    // Steering can leave for the campaign, so it waits until the sign-out is saved.
    void signOut(session.page, { keepPointers: true, ...(lost ? { localOnly: true } : {}) }).then(
      () => steerToInvite(lost ? { kind: "taken", handle: lost } : undefined),
      (e) => io.report(e, "onboarding:sign-out"),
    )
  }

  /** The forced resume tick; the record it leaves routes the step. Sign deps stay lazy. */
  const forcedTick = async (rec: PendingRegistrationRecord) => {
    dispatch({ type: "busyStage", stage: "checking" })
    const detection = await buildWebDetectionDeps(config, session, {
      getSignDeps: async () => {
        const { keys } = s()
        const wallet = valueOf(session.wallet)
        if (!keys || !wallet) return null
        const signDeps = await buildRetrySignDeps(
          signup.grantToken(rec.tag),
          keys,
          session.page,
          wallet.networkId,
          session.sipaDeposits,
          session.accountRecord,
        )
        // The terms follow a re-issued claim; a ticket's refusal is kept for the tick to report.
        const { accountService } = signDeps
        return {
          ...signDeps,
          accountService: {
            signDomain: async (...args: Parameters<typeof accountService.signDomain>) => {
              const claim = await accountService.signDomain(...args)
              if (rememberReissuedClaim(session.registrations, rec, claim).ticketRefused)
                renewalRefused = true
              return claim
            },
          },
        }
      },
    })
    // A failed chain read keeps the step pending; the next check retries.
    await bestEffort(
      "unknown",
      runDetectionTick(detection, {
        force: true,
        expectedRecord: { account: rec.account, nameHash: rec.nameHash },
      }),
    )
    if (renewalRefused) {
      renewalRefused = false
      dispatch({ type: "note", note: { kind: "ticketRefused" } })
    }
    dispatch({ type: "checkedAt", at: Date.now() })
  }

  /** Reuses the passkey for `rec`'s account when this tab holds no keys. */
  const recoverKeys = async (
    rec: PendingRegistrationRecord,
    recovered: boolean,
    signal?: AbortSignal,
  ) => {
    dispatch({ type: "busyStage", stage: "passkey" })
    const before = session
    const { ticketAttempt } = s()
    const keys = await reuse(
      rec.l2Address,
      fromPaylink && ticketAttempt && !isTicketSignupCreating(ticketAttempt)
        ? { credentialId: ticketAttempt.credentialId }
        : undefined,
      signal,
    )
    if (reloadIfSessionSwitched(before, rec.l2Address)) return undefined
    handOff(keys)
    dispatch({ type: "keys", keys, address: keys.account.getAddress().toString(), recovered })
    return keys
  }

  /** Recovers the keys when this tab holds none, then forces a tick over the open record. */
  const retryClaim = () => {
    const rec = record()
    if (!rec || s().retrying) return
    dispatch({ type: "retrying", on: true })
    return run(
      async () => {
        try {
          dispatch({ type: "note" })
          dispatch({ type: "pendingRefusal" })
          if (!s().keys) {
            op = restart(op)
            try {
              if (!(await recoverKeys(rec, true, op.signal))) return
            } catch (err) {
              if (isGateCancelled(err)) return
              if (err instanceof PasskeyMismatchError)
                return dispatch({ type: "note", note: { kind: "mismatch" } })
              if (isPasskeyNotOffered(err))
                return dispatch({ type: "note", note: { kind: "notOffered" } })
              if (!isPasskeyPolicyError(err)) throw err
              io.fire("action_failed", { action: "pending_retry", code: failureCode(err) })
              return dispatch({
                type: "pendingRefusal",
                refusal: { name: err.name, message: errorMessage(err) },
              })
            }
          }
          // An issued address may be paid already: resume it, never replace it for a new quote.
          await forcedTick(rec)
        } finally {
          dispatch({ type: "retrying", on: false })
          dispatch({ type: "busyStage" })
        }
      },
      "pending_retry",
      "registration:deposit",
    )
  }

  /** Claims the stashed link into this reservation. `account` signs before the session has one. */
  const consumeStashedPaylink = async (
    fragment: string,
    account: SponsoredPaylinkDeps["account"] | undefined,
  ) => {
    const kit = latest().paylinkKit
    const signer = account ?? (session.account && valueOf(session.account))
    if (!kit || !signer) throw new WalletError("wallet.notReady")
    const paying: SponsoredPaylinkDeps = { ...kit, account: signer, session }
    // Home offers no prompt for a link this claim is spending, and starts no claim of its own, even
    // once the wizard has gone.
    claims.start(fragment)
    try {
      const link = await io.viewLink({ ...paying, ...(await chainOf(session)) }, fragment)
      const zkProof =
        link.flavor === "email"
          ? await obtainEmailClaimProof(session, signer.getAddress(), {
              paylinkType: DEFAULT_CONTRACTS.paylinkEmail,
              commitment: link.commitment,
              email: link.email,
            })
          : undefined
      await io.claimLink(paying, fragment, undefined, zkProof, { fundRegistration: true })
    } catch (err) {
      // The node has the batch: offering the link again would spend it twice.
      if (err instanceof TxInFlightError) clearClaimStash(tabStash, fragment)
      throw err
    } finally {
      claims.end(fragment)
    }
    clearClaimStash(tabStash, fragment)
  }

  /** Resolves once no claim of `fragment` runs, or `signal` aborts. */
  const claimEnded = (fragment: string, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        if (!signal.aborted && claims.state.get().running.has(fragment)) return
        stop()
        signal.removeEventListener("abort", done)
        resolve()
      }
      const stop = claims.state.subscribe(done)
      signal.addEventListener("abort", done)
      done()
    })

  /** Enters once the link's claim is sent or lands; a later failure is the bell's to report. */
  const enterPastClaim = (tag: string) => {
    if (s().claimLeft) return
    dispatch({ type: "claimLeft", left: true })
    return enter(tag, true)
  }

  /** Pays the reservation with the stashed link instead of an L1 send. */
  const settlePendingPaylink = () => {
    const rec = record()
    if (!rec || rec.phase !== "awaiting_deposit" || paylinkSettling) return
    // Decided at the click, once the burns load.
    const burns = session.withdrawals.list.get()
    if (!burns.hydrated) return
    const terms = loadRegistrationTerms(session.registrations, rec.account, rec.tag)
    const ticket = io.ticketActivation(session, rec, terms, burns.records)
    if (!ticket) return
    if (ticket.state !== "ready")
      return dispatch({
        type: "note",
        note: { kind: "ticketHold", state: ticket.state, tag: rec.tag },
      })
    const fragment = ticket.stash.fragment
    const claimRunning = () => claims.state.get().running.has(fragment)
    paylinkSettling = true
    dispatch({ type: "claimLeft", left: false })
    return run(
      async () => {
        try {
          dispatch({ type: "note" })
          const signer = latest().paylinkKit && session.account && valueOf(session.account)
          const keyed = s().keys || (signer && !fromPaylink) || claimRunning()
          if (!keyed && !(await recoverKeys(rec, s().recovered))) return
          dispatch({ type: "busyStage", stage: "claiming" })
          await commitTicketSpeed(tapped)
          // Home's claim of this link runs: the screen shows it, as Home does, and starts none.
          if (claimRunning()) {
            const { signal } = op
            await claimEnded(fragment, signal)
            const after = io.ticketActivation(
              session,
              rec,
              terms,
              session.withdrawals.list.get().records,
            )
            if (signal.aborted || after?.state !== "submitted") {
              paylinkSettling = false
              return
            }
          } else {
            // Read again after the waits: Home's own claim may have sent the burn meanwhile.
            const now = io.ticketActivation(
              session,
              rec,
              terms,
              session.withdrawals.list.get().records,
            )?.state
            if (now === "ready") await consumeStashedPaylink(fragment, s().keys?.account)
            else if (now !== "submitted") {
              paylinkSettling = false
              return
            }
          }
          await enterPastClaim(rec.tag)
        } catch (err) {
          paylinkSettling = false
          if (isGateCancelled(err)) return
          // Handed off, so the bell reports it; a queued signup still here can claim again.
          if (s().claimLeft) return dispatch({ type: "claimLeft", left: false })
          throw err
        } finally {
          dispatch({ type: "busyStage" })
        }
      },
      "paylink_settle",
      "paylink:claim",
    )
  }

  /** A lapsed quote: a name now someone else's is lost, else the retry re-signs it. */
  const refreshExpiredQuote = async () => {
    const rec = record()
    if (!rec || s().retrying) return
    await run(
      async () => {
        dispatch({ type: "note" })
        dispatch({ type: "busyStage", stage: "checking" })
        if ((await io.getClaimStatus(session.page, rec.tag)) === "claimed")
          await closeRegistration(session, rec, { type: "closed", outcome: "taken" })
        else await session.registrations.apply(rec.sipaAddress, { type: "broadcastReset" })
      },
      "reregister_check",
      "registration:deposit",
    )
    if (record()?.broadcast === false) return retryClaim()
  }

  /** A forced detection tick: no sign half, it settles what the chain and bundler know. */
  const checkPendingStatus = () => {
    const rec = record()
    if (!rec) return
    return run(
      async () => {
        const detection = await buildWebDetectionDeps(config, session)
        await bestEffort(
          "unknown",
          runDetectionTick(detection, {
            force: true,
            expectedRecord: { account: rec.account, nameHash: rec.nameHash },
          }),
        )
        dispatch({ type: "checkedAt", at: Date.now() })
      },
      "check_pending",
      "registration:deposit",
    )
  }

  /** The deposit sheet's refund restart and earned-price replacement claim with recovered keys. */
  const replaceWith = async (
    keys: OnboardingKeys,
    replacing: Parameters<typeof claimAndApply>[2],
  ) => {
    handOff(keys)
    dispatch({ type: "keys", keys, address: keys.account.getAddress().toString(), recovered: true })
    await claimAndApply(keys, undefined, replacing)
  }
  const restartAfterRefund = async (keys: OnboardingKeys) => {
    const rec = record()
    if (rec) await replaceWith(keys, { refunded: rec })
  }
  /**
   * The old address's broadcast in flight may take the rail, which decides how the replacement
   * registers: it is waited out for a bounded time, and one still undecided stops the replacement.
   */
  const replaceAtEarnedPrice = async (keys: OnboardingKeys) => {
    const rec = record()
    if (!rec) return
    const { view } = session.sipaDeposits
    const inFlight = () => {
      const job = broadcastJob(view.get().records, rec.sipaAddress)
      return job?.state === "proving" || job?.state === "sent" ? job : undefined
    }
    const owed = inFlight()
    if (owed)
      await bestEffort(
        "timeout",
        within(broadcastSettled(view, owed.address), "replace", { ms: REPLACE_SETTLE_MS }),
      )
    return session.page.prover.runUserFlow(async () => {
      if (inFlight()) throw new WalletError("registration.replaceWaiting")
      const current = latestRegistration(loadedRegistrations(session.registrations), rec.account)
      if (!current) return
      await session.registrationRecovery.assertUnfunded(current)
      try {
        await replaceWith(keys, { replaced: current })
      } catch (err) {
        if (!(err instanceof NameTakenError)) throw err
        await closeRegistration(session, current, { type: "closed", outcome: "taken" })
      }
    })
  }

  /** "Enter later" on the pending step: the identity is saved from the keys or the record. */
  const enterDepositLater = () => {
    const rec = record()
    if (!rec) return
    const { keys, handle } = s()
    return keys ? enter(handle, true) : enter(rec.tag, false)
  }

  /** Clears a ticket attempt a closed prompt left; false shows why it could not. */
  const restartTicketAttempt = async (attemptId: string): Promise<boolean> => {
    if (!ticketFragment) return true
    try {
      await restartTicketSignupAccount(
        session,
        config.rpId,
        linkIdentity(ticketFragment),
        attemptId,
      )
      dispatch({ type: "ticketAttempt", attempt: null })
      return true
    } catch (err) {
      // An unreadable attempt keeps the saved one, and the restart error shows.
      const attempt = bestEffortSync(readTicketAttempt, s().ticketAttempt)
      fastRefusals = 0
      dispatch({ type: "ticketAttempt", attempt, error: err })
      return false
    }
  }

  /** Terms accepted: the passkey is created right away, then the claim, then the address. */
  const leaveTerms = (wantsDeposit: boolean) => {
    if (latest().ticketHeld || inAppHold()) return
    dispatch({ type: "to", step: "create" })
    if (mock) return
    io.fire("registration_terms_accepted", { deposit_intent: wantsDeposit })
    void createAccountStep()
  }

  const continueSignup = async () => {
    if (latest().ticketHeld) return
    const { ticketAttempt } = s()
    const shown = op
    if (
      isTicketSignupCreating(ticketAttempt) &&
      (!(await restartTicketAttempt(ticketAttempt.attemptId)) ||
        shown !== op ||
        shown.signal.aborted)
    )
      return
    unheld = undefined
    leaveTerms(!fromPaylink)
  }

  /** What the pending step does when its record moves: once per exit. */
  let exited: string | undefined
  let left: string | undefined
  let woken: string | undefined
  /** The stores of the session commands now run under: a hand-off can open another. */
  let watching: { session: Session; stop(): void } | undefined
  const watch = () => {
    if (watching?.session === session) return
    watching?.stop()
    const stores = [
      session.registrations.view,
      session.sipaDeposits.view,
      session.identity,
      session.device,
    ]
    const stops = stores.map((store) => store.subscribe(react))
    watching = { session, stop: () => stops.forEach((stop) => stop()) }
  }
  const react = () => {
    watch()
    const { step, keys, recovered, entryFailed } = s()
    const rec = record()
    if (rec && rec.account !== s().oxideAccount)
      dispatch({ type: "followed", account: rec.account })
    if (step !== "pending" || !rec || mock || entryFailed) return
    // A record that moved on needs no ceremony: a retry past its prompt still finishes.
    if (rec.phase !== "awaiting_deposit" && left !== rec.sipaAddress) {
      left = rec.sipaAddress
      markAttempts("superseded")
      latest().gate.dismiss()
    }
    const identity = session.identity.get()
    const device = session.device.get()
    const exit = selectPendingExit({
      record: rec,
      identityTag: identity.value?.handle,
      entered: !!enteredIdentity(identity, device.passkeyMap, config.rpId),
      admitted: hasDepositAdmission(session.sipaDeposits, rec),
      refunded: rec.replaced?.refunded === true,
      keysHeld: !!keys && !recovered,
      signedIn: device.storageId === session.namespace.id && device.msk !== null,
      recoveryVisit,
      entryFailed,
    })
    const key = `${exit}:${rec.sipaAddress}:${rec.phase}`
    // The session task saves the identity a settled record names; the step waits for it.
    if (exit === "stay" && (rec.phase === "funded" || rec.phase === "confirmed") && woken !== key) {
      woken = key
      void session.wake(session.tasks.registrationIdentity)
    }
    if (exit === "stay" || exited === key) return
    exited = key
    if (exit === "restart") signOutTo(rec.tag)
    else if (exit === "failed") {
      markAttempts("superseded")
      steerToInvite({ kind: "failed" })
    } else if (exit === "enter") void enter(s().handle, true)
    else if (exit === "wallet") enterWallet()
    else if (exit === "held") go("/enter")
    else go(`/enter?handle=${encodeURIComponent(rec.tag)}`)
  }

  return {
    state: state.readonly,
    tagField: tagInput.field,
    typeTag: (raw: string) => typed.set(raw.replace(/^@/, "").toLowerCase()),
    fromPaylink,
    freshStart,
    returning: freshStart && hasOpeningBreadcrumb(session.device.get().passkeyMap, config.rpId),
    leftoverTag: fromPaylink
      ? undefined
      : latestOpenRegistration(loadedRegistrations(session.registrations))?.tag,
    openRecord,
    mock,
    resuming,
    boundGrantOwner: () => resuming && latest().boundGrantOwner === latest().routeHandle,
    sweepAttempt,
    record,
    expectedEarned,
    start(signal: AbortSignal) {
      startedAt = performance.now()
      signal.addEventListener("abort", () => {
        // Leaving ends whatever was running, so nothing commits for a screen that is gone.
        op.abort()
        invite.abort()
        draw.abort()
        latest().gate.cancel()
        markAttempts("unmounted")
        stopState()
        watching?.stop()
      })
      const stopState = state.subscribe(react)
      watching = undefined
      react()
      tagInput.start(signal)
      signal.addEventListener("abort", state.subscribe(reseedTag))
      // One start per tab; a ticket signup's is the link page's to report.
      if (!fromPaylink && firstInTab("onboarding_started")) {
        io.landing("signup")
        io.fireOnboarding("onboarding_started", { entry: entryCohort })
      }
      // A route grant keeps the link here; its check scopes it, or drops it as spent.
      const grant = routeHandle && signup.grantToken(routeHandle)
      if (
        grant &&
        routeHandle &&
        !mock &&
        !inputs.embedded &&
        !openRecord &&
        !recoveryVisit &&
        !resuming &&
        !session.identity.get().value
      ) {
        void bestEffort(
          "unknown",
          io.grantIsCurrent(session.page, routeHandle, grant).then((current) => {
            if (signal.aborted) return
            if (current) signup.scopeGrant(routeHandle, grant)
            else signup.clearGrant(routeHandle, grant)
          }),
        )
      }
      // The tap taken before boot runs once: a start StrictMode discards never takes it.
      if (startedBeforeBoot)
        void Promise.resolve().then(() => {
          if (!signal.aborted && session.page.preBoot.takeCreate()) void createDrawnWallet()
        })
      // The tag and welcome steps warm what the claim after the passkey needs.
      const { step } = s()
      if (fromPaylink && ticketFragment && !mock && (step === "tag" || step === "terms")) {
        const warm = async () => {
          const chain = {
            wallet: await session.wallet.ready(signal),

            contractService: await session.contractService.ready(signal),
          }
          if (!peekTicketSignup(tabStash)?.paid)
            prewarmGoldenTicket(session.page.preparedTicket, chain, ticketFragment)
          await session.page.chain.oxideEnv.read()
        }
        void bestEffort("unknown", warm())
      }
      // A tag drawn before a link was stashed gives way to the link's signup.
      if (draftTag && !mock) {
        const yielded = async () => {
          await session.wallet.ready(signal)

          await session.contractService.ready(signal)
          const linked = await stashedLinkOpen()
          if (signal.aborted || !linked) return
          toLinkSignup(linked)
          choose(undefined)
          signup.setDrawnOffer(undefined)
        }
        void bestEffort("unknown", yielded())
      }
    },
    logIn,
    unlockAccess: onTap(unlockAccess),
    cancelUnlock,
    createDrawnWallet,
    rerollDrawnTag,
    keepDrawnTag,
    createChosenAccount: onTap(createChosenAccount),
    pickOwnTag,
    picking: (open: boolean) => dispatch({ type: "picking", open }),
    claimTagStep: onTap(claimTagStep),
    cancelModalOp,
    /** The X while the passkey runs: stops it as Cancel does, and leaves the sheet too. */
    closeBusySheet(gateOpen: boolean) {
      cancelModalOp(gateOpen)
      steerToInvite()
    },
    closeToInvite,
    /** Back from the terms sheet: the chosen tag goes with it. */
    backFromTerms() {
      closeToInvite()
      choose(undefined)
    },
    /** Home's back: the drawn tag goes, and WalletEntryGate sends a visitor to the landing. */
    dropDraft() {
      choose(undefined)
      signup.setDrawnOffer(undefined)
    },
    intoWallet,
    enterGo: go,
    retryClaim: onTap(retryClaim),
    settlePendingPaylink: onTap(settlePendingPaylink),
    refreshExpiredQuote,
    checkPendingStatus,
    reading: (on: boolean) => dispatch({ type: "reading", on }),
    retryEntry: () => void failedEntry?.(),
    restartAfterRefund: onTap(restartAfterRefund),
    replaceAtEarnedPrice: onTap(replaceAtEarnedPrice),
    enterDepositLater,
    enterPastClaim,
    logOut: () => signOutTo(),
    /** A refusal card's way back to the creation sheet, opened on `openOn`, after another try. */
    backToSheet: onTap(async (openOn?: SignUpChoice) => {
      if (latest().ticketHeld) return
      const refused = s().modalRefusal
      const shown = op
      if (
        refused?.ticketAttemptId &&
        (!(await restartTicketAttempt(refused.ticketAttemptId)) ||
          shown !== op ||
          shown.signal.aborted)
      )
        return
      unheld = undefined
      reopen = openOn ? { openOn } : undefined
      void createAccountStep()
    }),
    continueSignup: onTap(continueSignup),
    leaveTerms: onTap(leaveTerms),
    /** The ticket signup's own sheet took the tap: its pick and warning start the creation. */
    chooseOnSheet: onTap((choice: SignUpChoice, supported: readonly string[], warning?: string) => {
      unheld = { choice, supported }
      dispatch({ type: "warning", warning })
      leaveTerms(false)
    }),
    warn: (warning?: string) => dispatch({ type: "warning", warning }),
    /** The pending step's gate cancel: the running retry stops at its prompt. */
    cancelPendingGate() {
      markAttempts("userCancelled", true)
      fastRefusals = 0
      latest().gate.cancel()
    },
  }
}
