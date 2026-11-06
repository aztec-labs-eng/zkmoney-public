/** The sign-in screen's flow: its state, its commands, and the arrival that runs once it shows. */
import type { NavigateFunction } from "react-router-dom"
import {
  composeWireNameHash,
  latestRegistration,
  memoryStore,
  normalizeTag,
  readyValue,
  valueOf,
  WalletError,
} from "@obsidion/front-core"
import { bestEffort } from "@obsidion/core/errors"
import type { ObsidionAccount } from "@obsidion/sdk"
import {
  NoWalletForPasskeyError,
  signInKeyChoices,
  type PasskeyAttemptHandle,
} from "@obsidion/passkey-web"
import { getConfig } from "../../../config/env"
import { getOxideTuple } from "../../../config/oxideTuple"
import { showReportableError } from "../../../errors/errorModal"
import { failureCode, fireEvent, fireOnboardingEvent, reportLanding } from "../../../lib/analytics"
import { fmt } from "../../../lib/fmt"
import { passkeyTelemetry } from "../../../lib/passkeyTelemetry"
import { firstInTab } from "../../../lib/trafficSource"
import {
  listRetiredUsertagCandidates,
  listUsertagCandidates,
  usertagFor,
  walletKeysFor,
  type RememberedAccount,
  type WalletKey,
} from "../../../platform/auth/WebPasskeyIdentityMap"
import { leavePage } from "../../../platform/storage/walletStorage"
import { collectOnboardingKeys, saveIdentity } from "../../../session/account"
import {
  handOffAccount,
  servesAnotherAccount,
  signedInAccount,
  type Session,
} from "../../../session/session"
import { stillCommitted } from "../../../session/stillCommitted"
import { type CeremonyGate, isGateCancelled } from "../../identity/ceremonyGate"
import {
  DIFFERENT_PASSKEY,
  GRANTED_REGISTRATION,
  PASSKEY_NOT_OFFERED,
  PASSKEY_NOT_ON_DEVICE,
} from "../../identity/PasskeyRefusal"
import { resolveSignInTag } from "../../contacts/registryResolution"
import { peekClaimStash } from "../../paylink/claimStash"
import { linkIdentity } from "../../paylink/linkIdentity"
import { isTicketSignupCreating, loadTicketSignupAttempt } from "../../paylink/ticketSignupAccount"
import { probeNameAvailability } from "../../registration/nameAvailability"
import { loadedRegistrations } from "../../registration/webRegistration"
import { BY_TAG_FAILURE_CODES, diagnoseMiss, lookupPasskeyByTag } from "../findPasskeyByTag"
import {
  claimTag,
  confirmTag,
  enterWithPasskey,
  reservedTagMatch,
  type EnteredClaim,
  type EnterResult,
} from "../oxideOnboarding"
import { boundNameGrantOwner, reservedNameHashes } from "../recoveryProbes"
import {
  keyOptions,
  oneRowPerWallet,
  recordTarget,
  type AccountFound,
  type Found,
} from "../rowKeys"
import copy from "./EnterAppScreen.copy"
import {
  classifyEntryFailure,
  enterOutcome,
  macHelpFor,
  missDiagnosisCard,
  NO_RETRY,
  pinnedMiss,
  refusalOf,
  reservedCard,
  walletPath,
  type Refusal,
} from "./signInSettle"
import {
  signInTransition,
  type EntryAction,
  type SignInEvent,
  type SignInState,
  type Unclaimed,
} from "./signInTransition"

/** How long a pause in typing waits before the tag is read. */
export const RESOLVE_DEBOUNCE_MS = 400

// How the passkey was picked: the browser's list, or pinned to a typed tag or a remembered account.
const LOGIN_METHODS = { "enter": "chooser", "enter:by-tag": "pinned" } as const
type LoginMethod = (typeof LOGIN_METHODS)[EntryAction]

/** Which sign-in a result came from, and the tag it selected, for the branches shared by both. */
type Entry = {
  op: AbortController
  tag: string
  action: EntryAction
  /** The tag's account, on the pinned path only. */
  l2Address?: string
  /** The L1 read found keys beyond the one pinned, on the pinned path only; unset when there was no read. */
  moreKeys?: boolean
}

type SignIn = { kind: "probe" } | { kind: "enter"; phone?: boolean } | Pinned
type Pinned = { kind: "pinned"; phone?: boolean } & Found
/** What the refusal card's retry re-runs: whichever action ran last, steered to the phone or not. */
type LastAction =
  | SignIn
  | { kind: "bound-grant" | "nameless"; result: Unclaimed; entry: Omit<Entry, "op"> }

/** What the flow calls out to; tests stand in for any of them. */
export const SIGN_IN_IO = {
  telemetry: () => passkeyTelemetry,
  fire: fireEvent,
  fireOnboarding: fireOnboardingEvent,
  landing: reportLanding,
  report: showReportableError,
  enterWithPasskey,
  lookup: lookupPasskeyByTag,
  probeName: probeNameAvailability,
  diagnoseMiss,
  reservedNameHashes,
  boundNameGrantOwner,
  claimTag: ((...args) => claimTag(...args)) as typeof claimTag,
  collectKeys: collectOnboardingKeys,
  confirmTag,
  warm: getOxideTuple,
  retired: listRetiredUsertagCandidates,
  leave: leavePage,
}

export interface SignInDeps {
  /** The session the screen opened under. */
  own: Session
  /** The page's origin: a destination outside it is dropped. */
  origin: string
  io?: Partial<typeof SIGN_IN_IO>
}

/** The screen's latest render: what the flow reads when it acts, not when it opened. */
export interface SignInInputs {
  navigate: NavigateFunction
  params: URLSearchParams
  /** The destination router state carries. */
  nextRoute?: string
  gate: { gate: CeremonyGate; cancel(): void }
}

export function openSignInFlow(deps: SignInDeps, live: () => SignInInputs) {
  const io = { ...SIGN_IN_IO, ...deps.io }
  const { own } = deps
  const { auth, device } = own
  const config = getConfig()
  const passkeyMap = () => device.get().passkeyMap
  const keysOf = (credentialId: string) => walletKeysFor(passkeyMap(), config.rpId, credentialId)

  /** What the URL asks of the screen. */
  const route = () => {
    const { params, nextRoute } = live()
    const handle = normalizeTag(params.get("handle") ?? "") ?? ""
    return {
      handle,
      // Router state normally, and the URL when this screen replaced its own document. Only a path
      // inside the wallet counts: as a URL the destination is anyone's to write.
      next: walletPath(nextRoute ?? params.get("next") ?? undefined, deps.origin),
      /** The passkey's own name, carried over a reload; it names a reservation but never fills the field. */
      named: params.get("named") ?? undefined,
      grantToken: handle && params.get("bound") === "1" ? own.signup.grantToken(handle) : undefined,
      // `strict=1`: a by-tag entry reloaded after switching accounts; only the URL's tag names the claim.
      strict: params.get("strict") === "1",
      // `?choose=1`: the user asked for a different passkey, so no cached key answers and Show
      // passkeys leads the screen; `avoid` names a credential whose row the screen hides (it just failed).
      chooser: params.get("choose") === "1",
      avoid: params.get("avoid") ?? undefined,
      // `pick` names a remembered row whose keys the screen opens with: the unlock pane's way to a key
      // this browser holds no record of.
      pick: params.get("pick") ?? undefined,
      // Dev-only `/enter?mock=confirm`: opens the confirm-tag modal with no passkey prompt.
      mock: import.meta.env.DEV && params.get("mock") === "confirm",
    }
  }

  const state = memoryStore<SignInState>({
    shown: false,
    prepared: "pending",
    typed: "",
    resolving: false,
    selectedTag: route().handle,
    confirming: route().mock,
    prompted: false,
    busy: false,
    retired: [],
  })
  const dispatch = (event: SignInEvent) => state.set(signInTransition(state.get(), event))
  const s = () => state.get()

  /** The running action: starting another aborts it, as do the user's cancel and leaving. */
  let op: AbortController | undefined
  /** The running action's passkey attempt, marked with why it ends before the action is aborted. */
  let attempt: PasskeyAttemptHandle | undefined
  let last: LastAction = { kind: "probe" }
  /**
   * Whether every attempt from now on forces a fresh ceremony past the cache. `?choose=1` sets it
   * for the whole visit; asking for the chooser sets it from then on, so a retry after a refusal
   * still asks rather than resolving the cache and returning the user to the account they are leaving.
   */
  let chooseAll = false
  /** The arrival handle seeds the field once per arrival; Back returns to a blank field. */
  let seeded = false
  /** The tag read in flight, and the pause before one: only the current one may land. */
  let read = new AbortController()
  let pause: ReturnType<typeof setTimeout> | undefined
  let preparing = new AbortController()
  let rowRead = new AbortController()
  /** A recovered-but-unnamed claim and its rebuilt account, threaded to the confirm step. */
  let claimed: { claim: EnteredClaim; account: ObsidionAccount; held: () => boolean } | undefined
  let runs = 0

  // This rollup's remembered rows, one per wallet; `avoid` hides the failed key's record first.
  const ownRows = () =>
    oneRowPerWallet(
      listUsertagCandidates(passkeyMap(), config.rpId).filter(
        (c) => c.credentialId !== route().avoid,
      ),
      (c) => keysOf(c.credentialId)?.length ?? 1,
    )
  /** The accounts this browser remembers; earlier rollups' follow this rollup's, which win a duplicate. */
  const candidates = () => {
    const seen = new Set<string>()
    return [...ownRows(), ...s().retired].filter(
      (c) =>
        c.credentialId !== route().avoid && !seen.has(c.credentialId) && !!seen.add(c.credentialId),
    )
  }

  /** A failed login: `action_failed` for a consenting browser, and an identifier-free funnel count. */
  const failEntry = (action: EntryAction, code: string) => {
    io.fire("action_failed", { action, code })
    io.fireOnboarding("login_failed", { method: LOGIN_METHODS[action], code })
  }
  const failByTag = (outcome: keyof typeof BY_TAG_FAILURE_CODES) =>
    failEntry("enter:by-tag", BY_TAG_FAILURE_CODES[outcome])
  const refuse = (refusal?: Refusal) => dispatch({ type: "refused", refusal })

  /** An action: a failure reaches the error report and both failure counts. */
  const run = async (fn: () => Promise<void>, action: EntryAction) => {
    const mine = ++runs
    dispatch({ type: "busy", on: true })
    try {
      await fn()
    } catch (e) {
      io.fireOnboarding("login_failed", { method: LOGIN_METHODS[action], code: failureCode(e) })
      io.report(e, "enter")
      io.fire("action_failed", { action, code: failureCode(e) })
    } finally {
      if (mine === runs) dispatch({ type: "busy", on: false })
    }
  }

  const startOp = (next?: PasskeyAttemptHandle) => {
    attempt?.superseded()
    attempt = next
    op?.abort()
    op = new AbortController()
    return op
  }
  /** Ends whatever runs: the attempt, its operation, and the gate behind any open prompt. */
  const end = (cause: "userCancelled" | "superseded" | "unmounted") => {
    attempt?.[cause]()
    op?.abort()
    live().gate.cancel()
  }
  const promptGate: CeremonyGate = (options) => {
    dispatch({ type: "prompted" })
    return live().gate.gate(options)
  }

  /** Ends the resolve in flight and the pause that would start one; nothing they answer is taken. */
  const dropResolve = () => {
    read.abort()
    read = new AbortController()
    clearTimeout(pause)
    pause = undefined
    dispatch({ type: "resolving", on: false })
  }

  const claimRoute = (search: string, boundGrantOwner?: string) => {
    const { next } = route()
    live().navigate(`/claim${search}`, {
      replace: true,
      ...(next || boundGrantOwner
        ? { state: { ...(next ? { next } : {}), ...(boundGrantOwner ? { boundGrantOwner } : {}) } }
        : {}),
    })
  }
  // Replace: onboarding panes must never be back targets once in the wallet (useBack pops history).
  // A stashed inbound paylink claims on Home (ClaimLinkModal), not back on /link's split layout.
  const intoWallet = () =>
    live().navigate(peekClaimStash() ? "/" : route().next ?? "/", { replace: true })

  // The account changed while this screen was open, the page served another account before it, or
  // a commit on this page (e.g. a signed-out page entering an account this browser holds) left the
  // stores stale.
  const storesStale = () =>
    auth.recordsStale() ||
    servesAnotherAccount(device) ||
    (own.namespace.id !== null && !stillCommitted(own))

  /**
   * This screen again, for the account recovery just committed. The selected tag and the
   * destination come along, and `strict=1` when only that tag may name the claim; the chooser and
   * `pick` flags do not, so the reloaded document opens from the cached key instead of asking for
   * another passkey.
   */
  const enterAgain = (entry: { tag: string; strict: boolean; named?: string }) => {
    const carried = new URLSearchParams(live().params)
    for (const flag of ["choose", "avoid", "pick", "next"]) carried.delete(flag)
    const set = (key: string, value?: string) =>
      value ? carried.set(key, value) : carried.delete(key)
    set("handle", entry.tag)
    set("strict", entry.strict ? "1" : undefined)
    set("named", entry.named)
    set("next", route().next)
    const query = carried.toString()
    return query ? `/enter?${query}` : "/enter"
  }

  /**
   * Recovery commits the account it found, which can leave record stores this document has already
   * loaded stale. There is no way to release them in place, so the document is replaced as soon as
   * that is known — before anything reads a record, and whether the attempt settled, was cancelled
   * or failed after the commit. True when the document is going.
   */
  const reloadIfSwitched = (entry: Pick<Entry, "tag" | "action">, named?: string): boolean => {
    if (!storesStale()) return false
    const hinted = entry.action === "enter:by-tag"
    void io.leave(enterAgain({ tag: entry.tag, strict: hinted || route().strict, named }))
    return true
  }

  // A name is required, not optional: an account without one has no route it can pay for, so it
  // never reaches the wallet at all. `ours` is the attempt's ownership: a cancel while the identity
  // is saved leaves the passkey hint unwritten and navigates nowhere.
  const finish = async (
    account: ObsidionAccount,
    entered: { handle: string; address: string },
    ours: () => boolean,
    method: LoginMethod = "chooser",
  ) => {
    if (!ours()) return
    await saveIdentity(handOffAccount(account), { ...entered, claimedAt: Date.now() }, ours)
    if (!ours()) return
    io.fireOnboarding("login_succeeded", { method })
    intoWallet()
  }

  /**
   * The signup a reservation names, picked back up where the sign-in landed: the claim server
   * replays the claim and re-signs the same terms, so the record derives the address any deposit
   * already went to, and the wallet opens on the deposit screen the way the signup would have. A
   * claim that cannot be replayed leaves the card whose way on is the signup itself. Past the
   * commit, everything runs under the session the sign-in's commit made current.
   */
  const resumeClaim = async (result: Unclaimed, tag: string, entry: Entry) => {
    const ours = () => !entry.op.signal.aborted && result.held()
    const address = result.account.getAddress().toString()
    const method = LOGIN_METHODS[entry.action]
    let outcome: Awaited<ReturnType<typeof claimTag>>
    try {
      if (!ours()) return
      const keys = await io.collectKeys(result.account)
      if (!ours()) return
      const wallet = valueOf(result.own.wallet)
      if (!wallet) throw new WalletError("wallet.notReady")
      outcome = await io.claimTag(result.own, tag, keys, config, wallet)
    } catch (e) {
      if (!ours()) return
      failEntry(entry.action, failureCode(e))
      return refuse(reservedCard(tag))
    }
    // A claim the server replayed for an attempt since cancelled or a session since replaced is
    // replayed again by the next sign-in; nothing of it is kept here.
    if (!ours()) return
    if (outcome.kind === "custody")
      return finish(result.account, { handle: tag, address }, ours, method)
    // The reservation is the tag the signup settled on; this browser just never saw it confirmed.
    const record = latestRegistration(
      loadedRegistrations(result.own.registrations),
      outcome.oxideAccount,
    )
    if (record) await result.own.confirmTag(record)
    if (!ours()) return
    const identity = { handle: tag, address, claimedAt: Date.now(), pending: true }
    await saveIdentity(handOffAccount(result.account), identity, ours)
    if (!ours()) return
    io.fireOnboarding("login_succeeded", { method })
    intoWallet()
  }

  /**
   * Account-service's claims for a nameless account: any claim continues that signup under the tag
   * naming it — the attempt's own, the name the passkey carries, or the one the user confirms.
   * False when it holds none, for the caller's usual outcome.
   */
  const resumeReservation = async (result: Unclaimed, entry: Entry): Promise<boolean> => {
    // In test mode a key has its own way on, so only a reservation the attempt or passkey names resumes.
    const mayConfirm = !config.accountServiceTestMode
    const ours = () => !entry.op.signal.aborted && result.held()
    let nameHashes: Awaited<ReturnType<typeof reservedNameHashes>>
    try {
      nameHashes = await io.reservedNameHashes(result.bootstrap)
    } catch (e) {
      if (!ours()) return true
      // The lookup is the way in, so its failure is the committed error with a retry.
      if (!mayConfirm) return false
      const { tag, action, l2Address } = entry
      last = { kind: "nameless", result, entry: { tag, action, l2Address } }
      refuse({ name: "error", message: copy.network, committed: true })
      throw e
    }
    if (!ours()) return true
    if (nameHashes.length === 0) return false
    // The attempt's own tag, the tag this browser remembers, then the name the passkey carries: each
    // names the reservation only where it hashes to one the ledger holds, so a tag that hashes to
    // none still yields to the next rather than burying it.
    const carried = result.userHandle ?? route().named
    const matched =
      (entry.tag && reservedTagMatch(nameHashes, result.ensDomain, entry.tag)) ||
      (result.usertag && reservedTagMatch(nameHashes, result.ensDomain, result.usertag)) ||
      (carried && reservedTagMatch(nameHashes, result.ensDomain, carried)) ||
      null
    if (matched) {
      await resumeClaim(result, matched, entry)
      return true
    }
    // A held reservation nothing named: the user types it, since the lookup names exactly one account.
    if (!mayConfirm) return false
    claimed = undefined
    const { ensDomain } = result
    dispatch({
      type: "confirm",
      reserved: { nameHashes, ensDomain, tag: entry.tag, result, action: entry.action },
    })
    return true
  }

  /**
   * The stashed link's signup this passkey's account was made for, picked back up on that link, where
   * the claim keeps its ticket.
   */
  const stashedSignupLink = (result: Unclaimed): string | undefined => {
    const fragment = peekClaimStash()
    if (!fragment) return undefined
    try {
      const pending = loadTicketSignupAttempt(config.rpId, linkIdentity(fragment))
      if (!pending || isTicketSignupCreating(pending)) return undefined
      const address = result.account.getAddress().toString().toLowerCase()
      return pending.l2Address.toLowerCase() === address ? fragment : undefined
    } catch {
      return undefined
    }
  }

  /** A nameless account's way on: its link's signup, its reservation, else the signup it continues. */
  const settleNameless = async (result: Unclaimed, entry: Entry) => {
    const fragment = stashedSignupLink(result)
    if (fragment) return live().navigate(`/link#${fragment}`, { replace: true })
    if (await resumeReservation(result, entry)) return
    refuse({ name: GRANTED_REGISTRATION, message: "" })
  }

  /**
   * A plain-path miss (no local record to anchor against): if a tag is at hand — typed, from the
   * arrival, or the one this credential claimed on this browser — read the account on L1 and say
   * whether this passkey even belongs to it, with no second prompt. It never asserts divergence.
   * Returns true when it rendered a card, false to fall through to the generic no-wallet card.
   */
  const diagnosedMiss = async (
    result: Extract<EnterResult, { reason: "unknown" }>,
    entry: Entry,
    ours: () => boolean,
  ): Promise<boolean> => {
    const tag =
      entry.tag ||
      (result.credentialId ? usertagFor(passkeyMap(), config.rpId, result.credentialId) : undefined)
    if (!tag || !result.credentialId || !result.pubkey) return false
    const evidence = {
      credentialId: result.credentialId,
      pubkey: result.pubkey,
      addresses: result.addresses ?? [],
    }
    const diagnosis = await bestEffort("unknown", io.diagnoseMiss(evidence, tag))
    if (!ours() || !diagnosis) return false
    const card = missDiagnosisCard(diagnosis, tag)
    if (!card) return false
    failEntry(entry.action, BY_TAG_FAILURE_CODES[diagnosis])
    const mac = diagnosis === "NOT_REPRODUCED_HERE" ? macHelpFor(result.observed) : {}
    refuse({ ...card, ...mac })
    return true
  }

  /** The branches every sign-in result takes, whichever prompt produced it. */
  const settle = async (result: EnterResult, entry: Entry) => {
    // A reserved recovery commits and reloads to shed record stores this document already read
    // stale; the passkey's own name rides that reload, so the re-entry (recovered from the cache,
    // which carries no name) still names the held reservation.
    const named = !result.entered && result.reason === "unclaimed" ? result.userHandle : undefined
    if (reloadIfSwitched(entry, named)) return
    const ours = () => !entry.op.signal.aborted
    // An entry is committed by the time it is reported; the identity save and the move into the
    // wallet are still the attempt's, and stop at its cancel or when its session was replaced.
    if (result.entered) {
      const { account, handle, address } = result
      const held = () => ours() && result.held()
      return finish(account, { handle, address }, held, LOGIN_METHODS[entry.action])
    }
    if (!ours()) return
    if (result.reason === "unknown") {
      const { l2Address } = entry
      if (l2Address !== undefined) {
        const miss = pinnedMiss(result, { ...entry, l2Address })
        failEntry(entry.action, miss.code)
        return refuse(miss.refusal)
      }
      // A cancel during the diagnosis ends here: neither card is the cancelled attempt's to show.
      const diagnosed = await diagnosedMiss(result, entry, ours)
      if (diagnosed || !ours()) return
      // An incomplete catalog proves no account absent: a retry, never "no wallet".
      if (result.catalogIncomplete) {
        failEntry(entry.action, "unknown")
        return refuse({ name: "error", message: copy.network })
      }
      const e = new NoWalletForPasskeyError()
      failEntry(entry.action, failureCode(e))
      return refuse(refusalOf(e, macHelpFor(result.observed, true)))
    }
    if (result.reason === "confirm") {
      claimed = { claim: result.claim, account: result.account, held: result.held }
      return dispatch({ type: "confirm" })
    }
    if (result.reason !== "unclaimed") return
    // A bound grant resumes only with the passkey that first used it.
    const { grantToken } = route()
    if (grantToken && !config.accountServiceTestMode) {
      const nameHash = composeWireNameHash(entry.tag, result.ensDomain)
      let owner: boolean
      try {
        owner = await io.boundNameGrantOwner(nameHash, grantToken, result.bootstrap, config)
      } catch (e) {
        if (!ours()) return
        last = { kind: "bound-grant", result, entry: { tag: entry.tag, action: entry.action } }
        failEntry(entry.action, failureCode(e))
        return refuse({ name: "error", message: copy.network })
      }
      if (!ours()) return
      if (owner) return claimRoute(`/${entry.tag}?resume=1`, entry.tag)
      const message = fmt(copy.grantMismatch, { tag: entry.tag })
      return refuse({ name: DIFFERENT_PASSKEY, message })
    }
    // A recovered account with no name has nothing to open — every route that moves money sits
    // behind a registered name — so the way on is always the signup.
    await settleNameless(result, entry)
  }

  /**
   * One sign-in. The arrival probe tries the ceremony-free sources only: a cached key enters with no
   * screen and no prompt, and anything that needs a prompt shows the screen. `enter` is the
   * browser's own chooser and `pinned` the passkey a row or the field named; both open on a tap, so
   * neither restores the cache, and `phone` steers the prompt to the phone. A failure is sorted by
   * where it landed: a switched account reloads, a cancelled attempt shows nothing, and the rest
   * show their card, or, for a probe's read that failed before anything was asked, the screen.
   */
  const signIn = (action: SignIn) => {
    const begun = io.telemetry().begin({ ceremony: "sign_in", flow: "enter" })
    const current = startOp(begun)
    last = action
    const pinned = action.kind === "pinned" ? action : undefined
    const { handle, grantToken, strict } = route()
    const tag = pinned?.tag ?? (action.kind === "probe" ? handle : s().selectedTag)
    const analytics: EntryAction = pinned ? "enter:by-tag" : "enter"
    dispatch({ type: "running", tag: pinned?.tag })
    void run(async () => {
      let result: EnterResult
      try {
        const wallet = valueOf(own.wallet)
        const contractService = valueOf(own.contractService)
        if (!wallet || !contractService) throw new WalletError("wallet.notReady")
        const options = pinned
          ? { hints: pinned.hints, restoreCache: false }
          : action.kind === "probe"
          ? { strictTag: strict, cacheOnly: true }
          : { strictTag: strict, chooser: chooseAll || route().chooser, restoreCache: false }
        result = await begun.run(
          (scope) =>
            io.enterWithPasskey(wallet, config, tag || undefined, {
              auth,
              accounts: signedInAccount,
              contractService,
              ...(grantToken ? { grantToken } : {}),
              gate: promptGate,
              ...options,
              ...(action.kind !== "probe" && action.phone ? { phone: true } : {}),
              signal: current.signal,
              own: scope,
            }),
          enterOutcome(pinned?.l2Address),
        )
      } catch (e) {
        // A commit that switched accounts stands even when what followed was cancelled or failed;
        // the document with the old stores must go before anything else is shown.
        if (reloadIfSwitched({ tag, action: analytics })) return
        // Ended by the user's cancel or by unmount: whoever ended it navigated, or must not.
        if (current.signal.aborted || isGateCancelled(e)) return
        const failed = classifyEntryFailure(e, action.kind, tag)
        if (failed.code !== undefined) failEntry(analytics, failed.code)
        if (!failed.refusal) return showScreen(true)
        if (failed.refusal.probeCommitted) last = { kind: "probe" }
        refuse(failed.refusal)
        if (failed.reported) throw e
        return
      }
      if (!result.entered && result.reason === "ceremony-required") {
        if (!current.signal.aborted) showScreen(false)
        return
      }
      const { l2Address, moreKeys } = pinned ?? {}
      await settle(result, { op: current, tag, action: analytics, l2Address, moreKeys })
    }, analytics)
  }

  /**
   * Prepare the screen's ceremony actions: the manifest, and the one cache proof, so nothing slow
   * sits between a tap and its prompt. What completes here never opens a prompt by itself.
   */
  const prepare = () => {
    preparing.abort()
    preparing = new AbortController()
    const { signal } = preparing
    dispatch({ type: "prepared", prepared: "pending" })
    const landed = (prepared: SignInState["prepared"]) =>
      !signal.aborted && dispatch({ type: "prepared", prepared })
    void io
      .warm(config)
      .then(() => auth.recoverFromCache())
      .then(
        () => landed("ready"),
        () => landed("failed"),
      )
  }

  /**
   * Read `tag` on L1. Only the current read's answer lands, so an older one can neither repopulate
   * the field after an edit nor overwrite a newer notice; nothing here starts a prompt, and nothing
   * here touches the sign-in operation.
   */
  const readTag = (tag: string) => {
    const { signal } = read
    dispatch({ type: "resolving", on: true })
    void io.lookup(tag, { resolveTag: resolveSignInTag }).then(
      async (found) => {
        if (signal.aborted) return
        if (found.kind === "resolved") {
          const resolved: AccountFound = {
            tag,
            l2Address: found.l2Address,
            hints: { account: found.account, l2Address: found.l2Address, keys: found.keys },
            moreKeys: found.moreKeys,
          }
          return dispatch({
            type: "field",
            found: { ...resolved, keys: keyOptions(passkeyMap(), resolved) },
          })
        }
        failByTag(found.kind === "inconclusive" ? "INCONCLUSIVE" : found.kind)
        if (found.kind !== "notFound")
          return dispatch({ type: "field", notice: { kind: found.kind, tag } })
        // No account on the network yet: a reserved name is one whose signup still waits for its
        // deposit, and its way in is the passkey it was reserved with.
        const { status } = await io.probeName(tag)
        if (signal.aborted) return
        const reserved = status === "reserved" || status === "blocked-reserved"
        dispatch({ type: "field", notice: { kind: reserved ? "reserved" : "notFound", tag } })
      },
      () => {
        if (signal.aborted) return
        failByTag("lookupFailed")
        dispatch({ type: "field", notice: { kind: "lookupFailed", tag } })
      },
    )
  }

  /** Read `tag` as it is typed. A tag the list shows is that row's sign-in: nothing is read. */
  const resolve = (tag: string) => {
    dropResolve()
    if (candidates().some((c) => c.usertag === tag))
      return dispatch({ type: "field", notice: { kind: "listed", tag } })
    readTag(tag)
  }

  /**
   * Show the sign-in screen. `warm` runs the preparation the arrival probe would have done (the
   * chooser skips the probe; a failed probe left the manifest unread). The arrival handle seeds the
   * field the first time the screen shows, whichever way it did; Back never reseeds it. The
   * accounts this browser remembers on earlier rollups are read as it shows.
   */
  const showScreen = (warm: boolean) => {
    dispatch({ type: "shown" })
    if (warm) prepare()
    else dispatch({ type: "prepared", prepared: "ready" })
    void bestEffort("unknown", io.retired(config.rpId)).then(
      (rows) => rows && dispatch({ type: "retired", rows }),
    )
    const { handle } = route()
    if (seeded || !handle) return
    seeded = true
    dispatch({ type: "typed", typed: handle })
    resolve(handle)
  }

  /**
   * The selected remembered row's keys, shown in place of Login. Records this browser holds name them
   * at once; a key it holds none for is found by reading the row's tag, so its option pins the tag's
   * account. Only the latest read lands.
   */
  const openRow = (account: RememberedAccount, keys: WalletKey[]) => {
    closeRow()
    const { signal } = rowRead
    const row = { tag: account.usertag, l2Address: account.l2Address }
    const recorded = keys.flatMap((k) => (k.record ? [k.record] : []))
    if (recorded.length === keys.length) {
      const options = (signInKeyChoices(recorded) ?? []).map((c) => ({
        ...c,
        target: recordTarget(row, c.credentialId),
      }))
      return dispatch({ type: "row", row: { account, options } })
    }
    const failed = () =>
      !signal.aborted && dispatch({ type: "row", row: { account, options: [], failed: true } })
    dispatch({ type: "row", row: { account, options: [], reading: true } })
    void io.lookup(account.usertag, { resolveTag: resolveSignInTag }).then((found) => {
      if (signal.aborted) return
      if (found.kind !== "resolved") return failed()
      const hints = { account: found.account, l2Address: found.l2Address, keys: found.keys }
      const target = { ...row, l2Address: found.l2Address, hints, moreKeys: found.moreKeys }
      const options = keyOptions(passkeyMap(), target, recorded)
      if (!options) return failed()
      dispatch({ type: "row", row: { account, options } })
    }, failed)
  }
  const closeRow = () => {
    rowRead.abort()
    rowRead = new AbortController()
    dispatch({ type: "row" })
  }

  /** Once the wallet is ready: the chooser and `pick` show the screen; anything else probes. */
  const arrive = async (signal: AbortSignal) => {
    await readyValue(own.wallet, signal)
    await readyValue(own.contractService, signal)
    const { chooser, pick } = route()
    if (!chooser && !pick) return signIn({ kind: "probe" })
    showScreen(true)
    // The picked record's wallet, as the row the screen shows for it.
    const picked = pick
      ? listUsertagCandidates(passkeyMap(), config.rpId).find((c) => c.credentialId === pick)
      : undefined
    const address = picked?.l2Address.toLowerCase()
    const row = ownRows().find((c) => c.l2Address.toLowerCase() === address)
    const keys = row && keysOf(row.credentialId)
    if (row && keys && keys.length > 1) openRow(row, keys)
  }

  const submitReady = () => {
    const { found, typed } = s()
    return found !== undefined && found.tag === normalizeTag(typed)
  }
  /** A pinned sign-in from a resolved tag, counted as the lookup it resolved. */
  const pinFound = (target: Found) => {
    dropResolve()
    io.fire("passkey_by_tag_lookup_resolved", { more_keys: s().found?.moreKeys ?? false })
    signIn({ kind: "pinned", ...target })
  }

  return {
    state: state.readonly,
    submitReady,
    /** The rows the screen lists, and those whose wallet holds more than one key. */
    remembered() {
      const rows = candidates()
      const keyed = rows.filter((c) => (keysOf(c.credentialId)?.length ?? 0) > 1)
      return { candidates: rows, keyed: new Set(keyed.map((c) => c.credentialId)) }
    },
    /**
     * Whether the card's retry may run what ran last. Where that could only end the same way, the
     * screen is where the user tries again instead; a phone attempt that offered nothing may still
     * reach it.
     */
    retryable(refusal: Refusal) {
      const phoneOffered =
        (last.kind === "enter" || last.kind === "pinned") &&
        last.phone === true &&
        (refusal.name === PASSKEY_NOT_OFFERED || refusal.name === PASSKEY_NOT_ON_DEVICE)
      return (
        !!(refusal.probeCommitted || refusal.committed) ||
        !NO_RETRY.has(refusal.name) ||
        phoneOffered
      )
    },
    start(signal: AbortSignal) {
      signal.addEventListener("abort", () => {
        // Leaving ends the attempt behind any open prompt too: the gate's attempt is what the
        // ceremony and every write behind it run under. A replayed start seeds again.
        end("unmounted")
        dropResolve()
        seeded = false
      })
      io.landing("login")
      if (firstInTab("login_opened")) io.fireOnboarding("login_opened")
      if (!route().mock) void bestEffort("unknown", arrive(signal))
    },
    prepare,
    tagChanged(value: string) {
      dropResolve()
      dispatch({ type: "typed", typed: value })
      // Typing a tag leaves the selected row: one account's keys show at a time.
      closeRow()
      const tag = normalizeTag(value)
      if (!tag) return
      pause = setTimeout(() => resolve(tag), RESOLVE_DEBOUNCE_MS)
    },
    // A blur runs a pending read at once, and reads a tag nothing has answered yet — never one that
    // already resolved, which would disable Login under the click that blurred the field. A read the
    // network refused is asked again; the notice's Try again comes here too.
    tagBlurred() {
      const { typed, notice, resolving, found } = s()
      const tag = normalizeTag(typed)
      if (!tag) return
      const answered = notice?.tag === tag && notice.kind !== "lookupFailed"
      if (!pause && (resolving || found?.tag === tag || answered)) return
      resolve(tag)
    },
    /** A remembered tag's way in with a passkey its row does not hold: read like any other tag. */
    differentPasskey() {
      const { notice } = s()
      if (notice?.kind !== "listed") return
      dropResolve()
      dispatch({ type: "field" })
      readTag(notice.tag)
    },
    // The screen's ways in. Each ends the resolve first: nothing it answers may land on a screen
    // that has moved on.
    showPasskeys() {
      dropResolve()
      chooseAll = true
      signIn({ kind: "enter" })
    },
    chooseAccount(account: RememberedAccount) {
      dropResolve()
      const keys = keysOf(account.credentialId)
      if (keys && keys.length > 1) {
        if (s().row?.account.credentialId === account.credentialId) return closeRow()
        // The selected row's keys take Login's place, so the tag field steps aside.
        dispatch({ type: "typed", typed: "" })
        return openRow(account, keys)
      }
      closeRow()
      const { usertag: tag, l2Address, credentialId } = account
      signIn({ kind: "pinned", tag, l2Address, hints: { credentialId } })
    },
    chooseRowKey(credentialId: string) {
      const option = s().row?.options.find((o) => o.credentialId === credentialId)
      if (!option) return
      dropResolve()
      signIn({ kind: "pinned", ...option.target })
    },
    rowAgain() {
      const { row } = s()
      const keys = row && keysOf(row.account.credentialId)
      if (row && keys && keys.length > 1) openRow(row.account, keys)
    },
    login() {
      const { found } = s()
      if (submitReady() && found && !found.keys) pinFound(found)
    },
    chooseTagKey(credentialId: string) {
      const option = submitReady()
        ? s().found?.keys?.find((o) => o.credentialId === credentialId)
        : undefined
      if (option) pinFound(option.target)
    },
    rerun() {
      const ran = last
      if (!("result" in ran)) return signIn(ran)
      // A committed account's way on again, with no passkey prompt.
      const { kind, result, entry } = ran
      const current = startOp()
      dispatch({ type: "running" })
      const again = kind === "nameless" ? settleNameless : settle
      void run(() => again(result, { ...entry, op: current }), entry.action)
    },
    /** The way on from a miss that may be this Mac's own copy: what ran last, steered to the phone. */
    usePhone() {
      dropResolve()
      signIn(last.kind === "pinned" ? { ...last, phone: true } : { kind: "enter", phone: true })
    },
    confirm(typedTag: string) {
      dispatch({ type: "confirmError" })
      const { reserved } = s()
      if (reserved) {
        const matched = reservedTagMatch(reserved.nameHashes, reserved.ensDomain, typedTag)
        if (!matched)
          return dispatch({ type: "confirmError", error: { kind: "notReserved", tag: typedTag } })
        const { result, action } = reserved
        dispatch({ type: "confirmed" })
        const current = op ?? startOp()
        void run(() => resumeClaim(result, matched, { op: current, tag: matched, action }), action)
        return
      }
      const adopted = claimed
      let entered: ReturnType<typeof confirmTag>
      try {
        if (!adopted) throw new WalletError("invariant", "confirm without a claim")
        entered = io.confirmTag(adopted.claim, typedTag)
      } catch (error) {
        return dispatch({ type: "confirmError", error: { kind: "unmatched", error } })
      }
      const current = op
      const held = () => !current?.signal.aborted && adopted.held()
      void finish(adopted.account, entered, held).catch(() =>
        dispatch({ type: "confirmError", error: { kind: "finishFailed" } }),
      )
    },
    // The user's cancel ends the attempt wherever it is — on the screen, past its prompt, or in the
    // writes that follow. A visitor who came from a link goes back to it; otherwise back where the
    // sign-in was opened from.
    cancel() {
      end("userCancelled")
      dropResolve()
      const stashed = peekClaimStash()
      const { next } = route()
      if (stashed) live().navigate(`/link#${stashed}`, { replace: true })
      else if (next) live().navigate(next, { replace: true })
      else claimRoute("")
    },
    /** The same for a committed account whose signup may hold a tag, where the signup picks it back up. */
    continueSignup() {
      end("userCancelled")
      claimRoute("?resume=1")
    },
    /** The signup a reservation card names, picked back up. */
    resume: (tag?: string) => claimRoute(tag ? `/${tag}?resume=1` : "?resume=1"),
    // Back to the screen with a blank field, naming the URL's tag again; whatever was running ends
    // first. A screen that has not shown yet still takes the arrival seed.
    back() {
      end("superseded")
      dropResolve()
      closeRow()
      dispatch({ type: "back", tag: route().handle })
      showScreen(true)
    },
  }
}
