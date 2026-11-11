/** Home's claim sheet for one stashed link: its state, its commands, and the reads it runs. */
import {
  bestEffort,
  memoryStore,
  TxInFlightError,
  valueOf,
  WalletError,
  type RegistrationTerms,
} from "@obsidion/front-core"
import type { RegistrationSchedule } from "@obsidion/core/types"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import { EmailMismatchError } from "@obsidion/sdk"
import { showErrorModal, showReportableError } from "../../../errors/errorModal"
import { errorMessage } from "../../../errors/catalog"
import { failureCode, fireEvent } from "../../../lib/analytics"
import { fmt } from "../../../lib/fmt"
import type { Session } from "../../../session/session"
import type { WithdrawStage } from "../../withdraw/withdrawGateway"
import type { ClaimBeat, ClaimStage } from "../ClaimLinkModal"
import type { ClaimToL1Choice } from "../ClaimToL1Modal"
import { subscribeToChainSeconds } from "../chainTime"
import { claimWaitSeconds, claimWindowRevertCopy, withExpiry } from "../claimWindow"
import { clearClaimStash } from "../claimStash"
import { tabStash } from "../../../platform/storage/tabStash"
import { obtainEmailClaimProof, type EmailClaimOwner } from "../emailClaim"
import { GoogleSignInCancelled } from "../googleRelay"
import { LINK_READ_BUDGET_MS, readBefore, seededLink, watchLink } from "../linkStatus"
import {
  claimLinkToL1,
  claimSponsoredLink,
  emitLinkOpened,
  readyPaylinkDeps,
  type SponsoredPaylinkDeps,
  type ViewLinkDeps,
} from "../sponsoredPaylink"
import {
  fundingRefusalCopy,
  releaseLinkDeposit,
  ticketSignupContinuation,
  ticketSignupSpent,
} from "../ticketContinuation"
import { committedProverTip } from "../../registration/registrationTerms"
import { paylinkSignupQuote, type PaylinkSignupQuote } from "../paylinkSignupQuote"
import type { PaymentLink } from "../types"
import type { LinkFunding } from "../claims"
import { failureCodeOf, retryableFailure } from "../../operations/operations"
import copy from "./ClaimLinkSheet.copy"

/** Home's claim sheet for one stashed link. */
export interface ClaimState {
  /** This tab's earlier read until a read here answers; null until seeded. */
  link: PaymentLink | null
  /** `link` is only this tab's earlier read: its status may be stale, so nothing is offered off it. */
  seedOnly: boolean
  /** The reads stopped: they answered, failed, or ran out of time. */
  readSettled: boolean
  /** They stopped without reading the note, which only a read here supplies. */
  noteMissed: boolean
  /** A claim this sheet started is at work. */
  claiming: boolean
  beat?: ClaimBeat
  l1Open: boolean
  /** The sheet gave up deciding whether the link funds the registration: the plain prompt shows. */
  detectExpired: boolean
}

/** How long the sheet waits to learn whether the link funds a registration before the prompt. */
const DETECT_BUDGET_MS = 15_000

/** What the sheet's render knows that the flow reads at a command. */
export interface ClaimInputs {
  requested: boolean
  onDone(): void
  claimDeps: SponsoredPaylinkDeps | undefined
  chainNow: number | undefined
  /** The sheet is still deciding whether the link funds the account's registration. */
  detecting: boolean
  /** What the sheet decided of that, for the hero: the flow publishes it as it reacts and ends. */
  funding: LinkFunding | null
}

/** What the flow calls out to, bound late for the suites that mock these modules. */
export const CLAIM_IO = {
  watch: ((...a) => watchLink(...a)) as typeof watchLink,
  chainSeconds: ((...a) => subscribeToChainSeconds(...a)) as typeof subscribeToChainSeconds,
  claim: runClaim,
  claimToL1: ((...a) => claimLinkToL1(...a)) as typeof claimLinkToL1,
  opened: ((...a) => emitLinkOpened(...a)) as typeof emitLinkOpened,
  release: ((...a) => releaseLinkDeposit(...a)) as typeof releaseLinkDeposit,
}

/**
 * A signup review's split: quoted live while the review offers the claim, else what the claim at
 * work or sent burns, off the tip and the withdrawal fee its terms committed. Terms from an older
 * build carry no fee, and the live one stands in.
 */
export function reviewQuote(i: {
  quoting: boolean
  live: { tip?: bigint; fee?: bigint }
  terms: RegistrationTerms | null
  schedule?: RegistrationSchedule
  paylink?: bigint
  sweepFee?: bigint
}): PaylinkSignupQuote | undefined {
  const { terms } = i
  const proverTip = i.quoting ? i.live.tip : committedProverTip(terms)
  const withdrawalFee =
    i.quoting || terms?.withdrawalFee === undefined ? i.live.fee : BigInt(terms.withdrawalFee)
  if (!i.schedule || proverTip === undefined || withdrawalFee === undefined) return undefined
  return paylinkSignupQuote({
    ...(i.paylink !== undefined ? { paylink: i.paylink } : {}),
    schedule: i.schedule,
    sweepFee: i.sweepFee,
    proverTip,
    withdrawalFee,
    ticket: !terms?.paylinkDeposit,
  })
}

/** A failure a later try may get past: a read that timed out behind other work. */
export function retryable(e: unknown): boolean {
  return retryableFailure(failureCodeOf(e))
}

const cancelled = (e: unknown) => isPasskeyCancelled(e) || e instanceof GoogleSignInCancelled

/** Why a claim failed, for its review; undefined for a cancel, which says nothing. */
export function claimFailureReason(e: unknown): string | undefined {
  if (cancelled(e)) return undefined
  return (
    claimWindowRevertCopy(e)?.message ??
    fundingRefusalCopy(e) ??
    (e instanceof Error ? errorMessage(e) : copy.unknownFailure)
  )
}

/** The error sheet for a failed claim. */
export function showClaimFailure(e: unknown, reason: string): void {
  const windowCopy = claimWindowRevertCopy(e)
  if (e instanceof EmailMismatchError) {
    showErrorModal({ title: copy.emailMismatch, message: reason, context: "paylink:claim" })
  } else if (windowCopy) {
    showErrorModal({ ...windowCopy, context: "paylink:claim" })
  } else {
    showReportableError(e, "paylink:claim", { title: copy.claimFailed, message: reason })
  }
}

/** Resolves to the claim tx hash. `saved`: the terms write the burn is priced off. */
async function runClaim(
  own: EmailClaimOwner,
  deps: SponsoredPaylinkDeps,
  fragment: string,
  link: PaymentLink,
  onStage: (stage: ClaimStage) => void,
  fundRegistration: boolean,
  saved: Promise<void>,
  signal?: AbortSignal,
  automatic = false,
): Promise<string> {
  try {
    await saved
    const zkProof =
      link.flavor === "email"
        ? await obtainEmailClaimProof(
            own,
            (await readyPaylinkDeps(deps)).account.getAddress(),
            {
              paylinkType: DEFAULT_CONTRACTS.paylinkEmail,
              email: link.email,
              commitment: link.commitment,
            },
            onStage,
            signal,
          )
        : undefined
    const txHash = await claimSponsoredLink(deps, fragment, onStage, zkProof, {
      fundRegistration,
      dropRetryable: automatic,
    })
    // A link that funds the name stays stashed: its review reports the claim and the registration
    // until the funds land.
    if (!fundRegistration) clearClaimStash(tabStash, fragment)
    return txHash
  } catch (e) {
    if (e instanceof TxInFlightError) {
      // The node has the claim: a reload must not re-offer Accept for a note this wallet spent.
      clearClaimStash(tabStash, fragment)
    } else if (!(e instanceof EmailMismatchError) && !cancelled(e)) {
      console.error("paylink claim failed", e)
      fireEvent("action_failed", { action: "paylink:claim", code: failureCode(e) })
    }
    throw e
  }
}

/**
 * The claim sheet of one stashed link. A read that does not answer within the reads' budget settles
 * as missed, unless a claim of the link holds the reads.
 */
export function openClaimFlow(
  session: Session,
  fragment: string,
  latest: () => ClaimInputs,
  io = CLAIM_IO,
) {
  const state = memoryStore<ClaimState>({
    link: null,
    seedOnly: false,
    readSettled: false,
    noteMissed: false,
    claiming: false,
    l1Open: false,
    detectExpired: false,
  })
  const set = (patch: Partial<ClaimState>) => state.set({ ...state.get(), ...patch })
  let shown = false
  let handedOff = false
  /** A claim this sheet started is at work. */
  let mine = false
  let signIn: AbortController | null = null
  let stopWatch: (() => void) | undefined
  let stall: ReturnType<typeof setTimeout> | undefined
  const released = new Set<string>()
  const running = () => session.claims.state.get().running.has(fragment)
  const account = () => (session.account ? valueOf(session.account) : undefined)
  const begin = () => {
    mine = true
    session.claims.start(fragment)
  }
  const finish = () => {
    mine = false
    signIn = null
    session.claims.end(fragment)
  }

  const armStall = () => {
    clearTimeout(stall)
    if (state.get().readSettled) return
    stall = setTimeout(() => {
      if (running()) return armStall()
      set({ readSettled: true, noteMissed: true })
      react()
    }, LINK_READ_BUDGET_MS)
  }

  /** The chain time the flow follows itself, so a link that expires on a tick is acted on. */
  let ticked: number | undefined
  const chainNow = () => ticked ?? latest().chainNow

  const statusDeps = (): ViewLinkDeps | undefined => {
    const wallet = valueOf(session.wallet)
    const contractService = valueOf(session.contractService)
    return wallet && contractService
      ? { session, wallet, contractService, account: account() }
      : undefined
  }
  let watched: ViewLinkDeps | undefined
  const watch = () => {
    stopWatch?.()
    stopWatch = undefined
    watched = statusDeps()
    if (!watched || !shown) return
    armStall()
    stopWatch = io.watch(
      watched,
      fragment,
      (fresh) => {
        set({ link: fresh, seedOnly: false })
        armStall()
        react()
      },
      (e) =>
        showReportableError(e, "paylink:status", {
          message: fmt(copy.statusFailed, { reason: errorMessage(e) }),
        }),
      (noteRead) => {
        clearTimeout(stall)
        set({ readSettled: true, noteMissed: !noteRead })
        react()
      },
    )
  }
  const reread = () => {
    set({ readSettled: false, noteMissed: false })
    watch()
  }
  const depsChanged = () => {
    const next = statusDeps()
    const keys = ["wallet", "contractService", "account"] as const
    if (keys.some((key) => next?.[key] !== watched?.[key])) reread()
  }

  /** What the link's registration asks of this sheet as the reads and the records move. */
  const react = () => {
    if (shown) session.claims.fund(latest().funding)
    const burns = session.withdrawals.list.get()
    const address = account()?.getAddress().toString()
    if (!shown || !burns.hydrated || address === undefined) return
    const continuation = ticketSignupContinuation(session, fragment, address, burns.records)
    if (continuation === null) {
      if (!ticketSignupSpent(session, fragment, burns.records)) return
      clearClaimStash(tabStash, fragment)
      return latest().onDone()
    }
    const s = state.get()
    const link = s.link && withExpiry(s.link, chainNow())
    const closed = !s.seedOnly && link !== null && link.status !== "unclaimed" && !running()
    const { activation, record } = continuation
    if (closed && activation.state !== "submitted" && !released.has(record.sipaAddress)) {
      released.add(record.sipaAddress)
      io.release(session, record)
    }
  }

  const handOff = () => {
    if (handedOff) return
    handedOff = true
    latest().onDone()
  }
  const onScreen = () => shown && !handedOff
  // Home's own claim of the link started: the bell carries it from here, as a send's does.
  const followAuto = () => {
    if (running() && !mine && !latest().requested) handOff()
  }
  /** Seconds until the claim is offered: none off this tab's earlier read or a missed note. */
  const offeredWait = (link: PaymentLink) => {
    const { seedOnly, noteMissed } = state.get()
    return seedOnly || noteMissed ? undefined : claimWaitSeconds(link.claimableFrom, chainNow())
  }
  const claimable = (link: PaymentLink | null): link is PaymentLink =>
    !!link &&
    withExpiry(link, chainNow()).status === "unclaimed" &&
    !running() &&
    offeredWait(link) === 0

  return {
    state: state.readonly,
    start(signal: AbortSignal) {
      // The claim funnel's top on Home: /link redirects a signed-in visitor here without it.
      void bestEffort(
        "unknown",

        session.wallet.ready(signal).then((wallet) => io.opened(wallet.networkId, fragment)),
      )
      // A link can close on a chain tick with no store moving: each tick reacts.
      void bestEffort(
        "unknown",

        session.wallet.ready(signal).then(() => {
          if (signal.aborted) return
          const stop = io.chainSeconds(session.page.chainClock, (seconds) => {
            ticked = seconds
            react()
          })
          signal.addEventListener("abort", stop)
        }),
      )
      let link: PaymentLink
      try {
        link = seededLink(session.page.config, fragment)
      } catch {
        // A fragment that doesn't decode has nothing to prompt for.
        clearClaimStash(tabStash, fragment)
        latest().onDone()
        return
      }
      // Already claiming: the notification row owns it, unless the review was asked for.
      if (running() && !latest().requested) return latest().onDone()
      shown = true
      set({ link, seedOnly: readBefore(session.page.config, fragment) })
      const detect = setTimeout(
        () => latest().detecting && set({ detectExpired: true }),
        DETECT_BUDGET_MS,
      )
      const stops = [
        session.wallet.subscribe(depsChanged),
        session.contractService.subscribe(depsChanged),
        ...(session.account ? [session.account.subscribe(depsChanged)] : []),
        session.withdrawals.list.subscribe(react),
        session.registrations.view.subscribe(react),
        session.claims.state.subscribe(followAuto),
        session.claims.state.subscribe(react),
      ]
      watch()
      react()
      signal.addEventListener("abort", () => {
        session.claims.fund(latest().funding)
        shown = false
        stopWatch?.()
        clearTimeout(stall)
        clearTimeout(detect)
        for (const stop of stops) stop()
      })
    },
    /**
     * Starts a tapped claim; false when nothing could start. `ticket`: the review of the signup the
     * link funds, read again at the tap.
     */
    claim(fundRegistration: boolean, saved: Promise<void>, ticket = fundRegistration) {
      const { link } = state.get()
      const burns = session.withdrawals.list.get()
      const address = account()?.getAddress().toString()
      // An entered account's link may fund its registration: nothing is claimed before the burns load.
      if (!claimable(link) || (address !== undefined && !burns.hydrated)) return false
      // Read again at the tap: the terms can lapse, and the burn go out elsewhere, after the render.
      if (
        ticket &&
        ticketSignupContinuation(session, fragment, address, burns.records)?.activation.state !==
          "ready"
      )
        return false
      const deps = latest().claimDeps
      if (!deps) {
        showReportableError(new Error(copy.loading), "paylink:claim")
        return false
      }
      begin()
      set({ claiming: true, beat: undefined })
      // Only the Google popup is abortable; once the proof or the claim is running, nothing is.
      const abort = new AbortController()
      signIn = abort
      const stage = (s: ClaimStage) => {
        // Proving and submitting start before the passkey prompt; the sheet keeps its last beat.
        if (onScreen() && state.get().claiming && s !== "proving" && s !== "submitting")
          set({ beat: s as ClaimBeat })
      }
      void io
        .claim(session, deps, fragment, link, stage, fundRegistration, saved, abort.signal)
        .finally(finish)
        .then(
          () => onScreen() && handOff(),
          (e: unknown) => {
            // The claim reached the node and the bell follows it; offering Accept again would burn
            // the note twice.
            if (e instanceof TxInFlightError) return onScreen() && handOff()
            const reason = claimFailureReason(e)
            // A closed prompt stops Home's own claim of the link too: the tap is the retry.
            if (reason === undefined) session.claims.decline(fragment)
            else session.claims.failed(fragment, reason)
            // Failed after the hand-off: the reopened prompt is the retry, and its review says why.
            if (!onScreen()) return
            set({ claiming: false })
            if (reason !== undefined) showClaimFailure(e, reason)
          },
        )
      return true
    },
    claimToL1(choice: ClaimToL1Choice, onStage: (stage: WithdrawStage) => void) {
      const { link } = state.get()
      if (!link || running()) return Promise.resolve()
      if (!claimable(link)) return Promise.reject(new WalletError("invariant", copy.notClaimable))
      const deps = latest().claimDeps
      if (!deps) return Promise.reject(new WalletError("invariant", copy.loading))
      // Running like an ordinary claim, so a remount mid-burn shows nothing instead of Accept. The
      // withdrawal record's own row reports the burn; the stash clears only once it mined.
      begin()
      return io
        .claimToL1(
          deps,
          fragment,
          choice.recipient,
          choice.screener,
          onStage,
          choice.walletName,
          choice.receiveAsset,
          choice.quote,
          choice.zkProof,
          choice.swap,
          choice.proverTip,
          choice.bridge,
        )
        .then(() => clearClaimStash(tabStash, fragment))
        .finally(finish)
    },
    handOff,
    dismiss() {
      clearClaimStash(tabStash, fragment)
      latest().onDone()
    },
    retryRead: reread,
    openL1: (open: boolean) => set({ l1Open: open }),
    cancelSignIn: () => signIn?.abort(),
  }
}
