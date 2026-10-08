import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { parseUnits } from "viem"
import { useAztecContext, useContractServiceContext, TxInFlightError } from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import { EmailMismatchError } from "@obsidion/sdk"
import {
  DEFAULT_CONTRACTS,
  WALLET_TOKEN_SYMBOL,
  tokenDecimalsForNetwork,
} from "@obsidion/core/constants"
import { getConfig } from "../../config/env"
import { showErrorModal, showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent } from "../../lib/analytics"
import { useDepositSkim, useSweepDeductions } from "../onboarding/registrationTerms"
import { ClaimReviewStep } from "../onboarding/steps/ClaimReviewStep"
import { useRegistrationPublishStalled } from "../onboarding/webRegistration"
import { BroadcastStatusRow } from "../broadcasts/BroadcastStatusRow"
import { useOweRegistrationBroadcast } from "../broadcasts/useOweRegistrationBroadcast"
import { getWithdrawalStore, type WithdrawStage } from "../withdraw/withdrawGateway"
import { usePolledChainSeconds } from "./chainTime"
import {
  ClaimLinkModal,
  ClaimProvingModal,
  type ClaimBeat,
  type ClaimStage,
} from "./ClaimLinkModal"
import { ClaimToL1Modal, type ClaimToL1Choice } from "./ClaimToL1Modal"
import {
  claimWaitSeconds,
  claimWindowRevertCopy,
  closedLinkMessage,
  LINK_STATUS_LABEL,
  withExpiry,
  PAYLINK_NOT_CLAIMABLE_YET_MESSAGE,
  useClaimCountdown,
} from "./claimWindow"
import { openClaimPrompt } from "./claimPrompt"
import { clearClaimStash } from "./claimStash"
import {
  endClaim,
  isClaimRunning,
  resetRunningClaims,
  startClaim,
  useClaimRunning,
} from "./runningClaims"
import { obtainEmailClaimProof } from "./emailClaim"
import { GoogleSignInCancelled } from "./googleAuth"
import { watchLink } from "./linkStatus"
import { paylinkSignupQuote } from "./paylinkSignupQuote"
import { useRegistrationSpeed } from "./registrationProverTip"
import { SpeedRow } from "../withdraw/speedChoice"
import {
  commitRegistrationProverTip,
  committedProverTip,
  useRegistrationTerms,
} from "../onboarding/registrationTerms"
import {
  claimLinkToL1,
  planLinkClaimSwap,
  claimSponsoredLink,
  decodeLink,
  emitLinkOpened,
  type SponsoredPaylinkDeps,
  type ViewLinkDeps,
} from "./sponsoredPaylink"
import {
  onTicketRegistrationsChanged,
  ticketHoldNotice,
  ticketSignupCommitted,
  ticketSignupContinuation,
} from "./ticketContinuation"
import type { PaymentLink } from "./types"
import { usePaylinkDeps } from "./usePaylinkDeps"

export interface ClaimLinkFlow {
  /** The claim prompt, or the sheet for the beats that need the user, when one is on screen. */
  modal: ReactNode
}

/**
 * Claim lifecycle for an inbound paylink (ULT-671 pages 6–7). The prompt gives way to the claim
 * sheet for the beats that need the user present (Google sign-in, the zkJWT prove, the passkey).
 * The passkey ceremony is the last of those, so the sheet closes as it ends and the bell carries
 * the claim — the same hand-off a send makes. Success and failure land on the claim's operation
 * row; a failure before the hand-off also reopens the prompt behind an error sheet, since the
 * prompt is the retry. The stash clears on decline or success, so only an unresolved claim
 * re-prompts; a mount that finds its claim already running shows nothing, because the bell owns it.
 * Either flavor can instead burn to Ethereum: that runs as a withdrawal, whose stored record
 * carries its own live row.
 *
 * A link that paid for this account's signup is claimed by Home itself, with the registration
 * slice burned in the batch: the signup entered the wallet as soon as its name was reserved, so
 * the claim starts once the address is published and hands off to the bell at once, with no
 * review. That happens once per page and link; a claim that failed or was cancelled shows the
 * review with its Claim for the retry, as does an email-locked link, whose sign-in needs the tap.
 * Closing the review keeps the link stashed — the signup's funding waits for its claim. A signup
 * whose renewed quote the link can no longer pay, whose reservation lapsed, whose address is not
 * published or whose burn already went out claims nothing and shows nothing here: the hero on Home
 * says why, and the link is still that signup's, never an ordinary claim, until the signup is
 * renewed, published or abandoned.
 */

/** Links Home has tried to claim on its own in this page. */
const autoClaimed = new Set<string>()

/** Test seam. */
export function resetRunningClaimsForTests(): void {
  resetRunningClaims()
  autoClaimed.clear()
}

/** Resolves to the claim tx hash. */
async function runClaim(
  deps: SponsoredPaylinkDeps,
  fragment: string,
  link: PaymentLink,
  onStage: (stage: ClaimStage) => void,
  fundRegistration: boolean,
  signal?: AbortSignal,
): Promise<string> {
  try {
    let zkProof
    if (link.flavor === "email") {
      zkProof = await obtainEmailClaimProof(
        deps.account.getAddress(),
        {
          paylinkType: DEFAULT_CONTRACTS.paylinkEmail,
          email: link.email,
          commitment: link.commitment,
        },
        onStage,
        signal,
      )
    }
    const txHash = fundRegistration
      ? await claimSponsoredLink(deps, fragment, onStage, zkProof, { fundRegistration: true })
      : await claimSponsoredLink(deps, fragment, onStage, zkProof)
    // A link that funds the name stays stashed: its review reports the claim and the registration
    // until the funds land, and the continuation it names claims nothing twice.
    if (!fundRegistration) clearClaimStash(fragment)
    return txHash
  } catch (e) {
    if (e instanceof TxInFlightError) {
      // The node has the claim: a reload must not re-offer Accept for a note this wallet spent.
      clearClaimStash(fragment)
    } else if (
      !(e instanceof EmailMismatchError) &&
      !isPasskeyCancelled(e) &&
      !(e instanceof GoogleSignInCancelled)
    ) {
      console.error("paylink claim failed", e)
      fireEvent("action_failed", { action: "paylink:claim", code: failureCode(e) })
    }
    throw e
  } finally {
    endClaim(fragment)
  }
}

/**
 * `requested`: an activation surface asked for this link's review, so it opens whatever the claim's
 * state, as the place that reports it, rather than only once Home's own try has been made.
 */
export function useClaimLinkFlow(
  fragment: string | null,
  onDone: () => void,
  requested = false,
): ClaimLinkFlow {
  const { obsidionWallet, rollupAddress } = useAztecContext()
  const { contractService } = useContractServiceContext()
  const claimDeps = usePaylinkDeps()
  const chainNow = usePolledChainSeconds(obsidionWallet?.node)

  // Claim-funnel top for the Home handoff surface — /link redirects signed-in visitors here
  // without emitting. Once per fragment, as soon as the network identity (part of the join key)
  // is known; waits on nothing else.
  const openedFragment = useRef<string>(undefined)
  useEffect(() => {
    if (!fragment || !rollupAddress || openedFragment.current === fragment) return
    openedFragment.current = fragment
    emitLinkOpened(rollupAddress, fragment)
  }, [fragment, rollupAddress])

  const [read, setLink] = useState<PaymentLink | null>(null)
  const link = read && withExpiry(read, chainNow)
  const [claiming, setClaiming] = useState(false)
  // The signup this link paid for, when this account still owes it the claim's burn. Read again at
  // the click: the terms can lapse, and the burn can go out elsewhere, after the render.
  const readContinuation = () =>
    fragment && claimDeps
      ? ticketSignupContinuation(
          fragment,
          claimDeps.account.getAddress().toString(),
          getWithdrawalStore().list(),
        )
      : null
  const continuation = readContinuation()
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  // The signup moves under Home: its address publishes, or its burn goes out from another surface.
  useEffect(() => {
    if (!fragment) return
    const offRegistrations = onTicketRegistrationsChanged(rerender)
    const offBurns = getWithdrawalStore().onListChanged(rerender)
    return () => {
      offRegistrations()
      offBurns()
    }
  }, [fragment])
  // A claim of this link at work, from this mount or an earlier one.
  const running = useClaimRunning(fragment)
  // The link's registration moved past the claim, its funds seen and the name confirmed: the link
  // is done with, and so is its review.
  useEffect(() => {
    if (!fragment || !claimDeps || continuation !== null) return
    if (!ticketSignupCommitted(fragment)) return
    clearClaimStash(fragment)
    onDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fragment, claimDeps, continuation === null])
  const navigate = useNavigate()
  const config = getConfig()
  const deductions = useSweepDeductions(config, undefined, continuation !== null)
  const sweepFee = useDepositSkim(config, continuation !== null)
  const [beat, setBeat] = useState<ClaimBeat>()
  const [l1Open, setL1Open] = useState(false)
  const signInAbort = useRef<AbortController | null>(null)
  // The fragment this mount is showing; a claim whose fragment no longer matches is obsolete.
  const shown = useRef<string | null>(null)
  // Set as the sheet leaves, ahead of the re-render that clears `shown`: from then on the row alone
  // reports the claim, so a failure landing in that gap cannot reopen the prompt.
  const handedOff = useRef(false)
  const handOff = () => {
    if (handedOff.current) return
    handedOff.current = true
    onDone()
  }
  // The link Home is claiming on its own, handed off at the start: its failure reopens the review.
  const autoRun = useRef<string | null>(null)

  useEffect(() => {
    shown.current = fragment
    setClaiming(false)
    setBeat(undefined)
    setL1Open(false)
    if (!fragment) {
      setLink(null)
      return
    }
    try {
      setLink(decodeLink(fragment))
    } catch {
      // A fragment that doesn't decode has nothing to prompt for.
      setLink(null)
      clearClaimStash(fragment)
      onDone()
      return
    }
    // Already claiming: nothing to prompt for, the notification row owns it, unless the review was
    // asked for, which then reports the claim at work.
    if (isClaimRunning(fragment) && !requested) {
      setLink(null)
      onDone()
      return
    }
    return () => {
      shown.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fragment])

  // The account, when unlocked, lets `sync_note` run under a real scope so `claimableFrom` is
  // read reliably; before that the placeholder sender serves.
  const account = claimDeps?.account
  const statusDeps: ViewLinkDeps | undefined = useMemo(
    () =>
      obsidionWallet && contractService
        ? { wallet: obsidionWallet, contractService, account }
        : undefined,
    [obsidionWallet, contractService, account],
  )

  const [readSettled, setReadSettled] = useState(false)
  const [readAttempt, setReadAttempt] = useState(0)
  useEffect(() => {
    setReadSettled(false)
    if (!statusDeps || !fragment) return
    return watchLink(
      statusDeps,
      fragment,
      setLink,
      (e) =>
        showReportableError(e, "paylink:status", {
          message: `Could not check the link's status: ${
            e instanceof Error ? e.message : String(e)
          }`,
        }),
      () => setReadSettled(true),
    )
  }, [statusDeps, fragment, readAttempt])

  const loading = !readSettled && link?.status === "unclaimed" && link.amount === undefined
  // Grace window: the claim's timestamp check runs at inclusion, so offer a claim only once the
  // window is known to be open.
  const claimWait = claimWaitSeconds(link?.claimableFrom, chainNow)
  const countdown = useClaimCountdown(claimWait, chainNow, obsidionWallet?.node)
  // The reads stopped without the note, so the window stays unknown until the link is read again.
  const unreadable = readSettled && link?.status === "unclaimed" && link.claimableFrom == null
  const retryRead = () => setReadAttempt((n) => n + 1)

  /** Starts the claim; false when nothing could start. */
  const claim = (): boolean => {
    if (
      !fragment ||
      !link ||
      link.status !== "unclaimed" ||
      isClaimRunning(fragment) ||
      claimWait !== 0
    )
      return false
    if (continuation) {
      const live = readContinuation()
      if (live?.activation.state !== "ready") {
        rerender()
        return false
      }
    }
    if (!claimDeps) {
      showReportableError(
        new Error("The wallet is still loading — try again in a moment"),
        "paylink:claim",
      )
      return false
    }
    const owned = fragment
    const live = () => shown.current === owned && !handedOff.current
    // The hand-off means the rest of the claim outlives this mount: its operation's row reports the
    // end, not component state.
    handedOff.current = false
    startClaim(owned)
    setClaiming(true)
    setBeat(undefined)
    // Only the Google popup is abortable; once the proof or the claim is running, nothing is.
    const signIn = new AbortController()
    signInAbort.current = signIn
    runClaim(
      claimDeps,
      owned,
      link,
      (s) => {
        // Proving and submitting start before the passkey prompt; the sheet keeps its last beat.
        if (live() && s !== "proving" && s !== "submitting") setBeat(s)
      },
      continuation !== null,
      signIn.signal,
    ).then(
      () => {
        signInAbort.current = null
      },
      (e: unknown) => {
        signInAbort.current = null
        // The claim reached the node and its operation hands off; offering Accept again would burn
        // the note twice.
        if (e instanceof TxInFlightError) return
        // Home's own claim ended: the review, with its Claim, is the retry, so Home is asked to
        // show it again; the error sheet, when there is one, opens over it.
        const auto = autoRun.current === owned
        if (auto) {
          autoRun.current = null
          openClaimPrompt(owned)
        }
        if (isPasskeyCancelled(e) || e instanceof GoogleSignInCancelled) {
          if (live()) setClaiming(false)
          return
        }
        // Failed before the hand-off: the reopened prompt is the retry, and the sheet says why.
        if (!live() && !auto) return
        if (live()) setClaiming(false)
        const windowCopy = claimWindowRevertCopy(e)
        if (e instanceof EmailMismatchError) {
          showErrorModal({ title: "Email mismatch", message: e.message, context: "paylink:claim" })
        } else if (windowCopy) {
          showErrorModal({ ...windowCopy, context: "paylink:claim" })
        } else {
          showReportableError(e, "paylink:claim", {
            title: "Claim failed",
            message: e instanceof Error ? e.message : "Something went wrong",
          })
        }
      },
    )
    return true
  }

  // The signup's own claim, started by Home: the address is published and the link is a direct
  // one, so nothing needs the user before the passkey. It waits for the escrow read (`decodeLink`
  // knows no window; the note names `from_claimable`) and for that window to open, since the one
  // try must not be spent on a revert. The hand-off is immediate; the row and the hero report from
  // here, and a failure leaves the link stashed for the review's Claim.
  const autoClaim =
    fragment !== null &&
    continuation?.activation.state === "ready" &&
    link?.flavor === "direct" &&
    link.status === "unclaimed" &&
    claimWait === 0 &&
    !!claimDeps &&
    !claiming &&
    !isClaimRunning(fragment) &&
    !autoClaimed.has(fragment)
  useEffect(() => {
    if (!autoClaim || !fragment) return
    autoClaimed.add(fragment)
    autoRun.current = fragment
    if (claim()) handOff()
    else autoRun.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the flag folds every input in
  }, [autoClaim, fragment])

  // Registered as running like an ordinary claim, so a remount mid-burn shows nothing instead of
  // offering Accept again. The withdrawal record's own live row reports the burn; the stash clears
  // only once it mined.
  const claimToL1 = (
    {
      recipient,
      screener,
      walletName,
      receiveAsset,
      quote,
      zkProof,
      swap,
      proverTip,
    }: ClaimToL1Choice,
    onStage: (stage: WithdrawStage) => void,
  ): Promise<void> => {
    if (!fragment || !link || isClaimRunning(fragment)) return Promise.resolve()
    if (link.status !== "unclaimed" || claimWait !== 0) {
      return Promise.reject(new Error("This link is not currently claimable"))
    }
    if (!claimDeps) {
      return Promise.reject(new Error("The wallet is still loading — try again in a moment"))
    }
    const owned = fragment
    startClaim(owned)
    return claimLinkToL1(
      claimDeps,
      owned,
      recipient,
      screener,
      onStage,
      walletName,
      receiveAsset,
      quote,
      zkProof,
      swap,
      proverTip,
    )
      .then(() => clearClaimStash(owned))
      .finally(() => endClaim(owned))
  }

  const dismiss = () => {
    if (fragment) clearClaimStash(fragment)
    onDone()
  }

  // Home claims a ticket's payment into the address once it is published, so this flow owes it.
  useOweRegistrationBroadcast(
    continuation?.record,
    continuation?.activation.state === "unpublished",
  )
  const publishStalled = useRegistrationPublishStalled(continuation?.record ?? null)
  // The ledger publishes the address on its own; only a stalled publish needs the registration page.
  const publishing = continuation?.activation.state === "unpublished" && !publishStalled
  const hold =
    continuation && !publishing
      ? ticketHoldNotice(continuation.activation.state, continuation.record.tag)
      : undefined
  // The review's amount: the note as the signup read it, else as this prompt's own read has it.
  const paylinkAmount =
    continuation?.stash.amount !== undefined
      ? BigInt(continuation.stash.amount)
      : link?.amount !== undefined
      ? parseUnits(link.amount, tokenDecimalsForNetwork(config.network))
      : undefined
  const registrationPage = () => {
    if (!continuation) return
    onDone()
    navigate(`/claim/${continuation.record.tag}`)
  }
  // A direct link's signup shows its review only once Home's own claim has been tried, when the
  // reads stopped without the claim window and the review's re-read is the way on, or when the
  // link closed before that try (cancelled, expired, spent) and the review is where that is said;
  // until then the hero reports the wait and the claim starts by itself.
  const reviewing =
    continuation !== null &&
    (requested ||
      link?.flavor === "email" ||
      unreadable ||
      (link !== null && link.status !== "unclaimed") ||
      (fragment !== null && autoClaimed.has(fragment)))
  // Only a ready signup has a fundable quote; the split it was offered stands in.
  const reviewSchedule = !continuation
    ? undefined
    : continuation.activation.state === "ready"
    ? continuation.activation.schedule
    : {
        fee: BigInt(continuation.stash.schedule.fee),
        min: BigInt(continuation.stash.schedule.minDeposit),
      }
  // Home's own claim burns what the signup committed; only the review on screen quotes again.
  const reviewShown =
    reviewing && !!fragment && !!link && !l1Open && !(claiming && !requested) && !running
  const reviewRecord = continuation?.record
  const reviewTerms = useRegistrationTerms(reviewRecord?.account, reviewRecord?.tag)
  const reviewSpeed = useRegistrationSpeed({
    active: reviewShown,
    node: obsidionWallet?.node,
    noteAmount: paylinkAmount,
    schedule: reviewSchedule,
    cuts:
      deductions === undefined
        ? undefined
        : { withdrawalCut: deductions.fpcCut, depositCut: deductions.fpcCut },
    initialSpeed: reviewTerms?.speed,
    onCommit: (tip, speed) => {
      if (reviewRecord)
        commitRegistrationProverTip(reviewRecord.account, reviewRecord.tag, tip, speed)
    },
    commitKey: reviewRecord && `${reviewRecord.account}:${reviewRecord.tag}`,
  })
  // A review opened over a running claim shows the tip that claim burns.
  const proverTip =
    reviewSpeed.proverTip ?? (reviewShown ? undefined : committedProverTip(reviewTerms))

  const modal =
    !fragment || !link ? null : l1Open ? (
      <ClaimToL1Modal
        link={link}
        ready={!!claimDeps}
        onClose={() => setL1Open(false)}
        onHandOff={onDone}
        onConfirm={claimToL1}
        planSwap={(recipient, receiveAsset, quote, amount, proverTip) =>
          claimDeps
            ? planLinkClaimSwap(
                claimDeps,
                fragment,
                amount,
                recipient,
                receiveAsset,
                quote,
                proverTip,
              )
            : Promise.reject(new Error("The wallet is still loading — try again in a moment"))
        }
        node={obsidionWallet?.node}
      />
    ) : claiming && !(continuation && requested) ? (
      <ClaimProvingModal
        beat={beat}
        onCancel={beat === "signing-in" ? () => signInAbort.current?.abort() : undefined}
        onLeave={handOff}
      />
    ) : continuation && !reviewing ? null : continuation ? (
      // A signup's claim keeps its own step: the review, which an asked-for open can close while
      // a claim runs on in the background, its status the review's word.
      <ClaimReviewStep
        quote={
          deductions === undefined || !reviewSchedule || proverTip === undefined
            ? undefined
            : paylinkSignupQuote({
                ...(paylinkAmount !== undefined ? { paylink: paylinkAmount } : {}),
                schedule: reviewSchedule,
                cuts: { withdrawalCut: deductions.fpcCut, depositCut: deductions.fpcCut },
                sweepFee,
                proverTip,
              })
        }
        tokenSymbol={WALLET_TOKEN_SYMBOL}
        tokenDecimals={tokenDecimalsForNetwork(config.network)}
        speed={<SpeedRow choice={reviewSpeed.choice} outcome={reviewSpeed.outcome} />}
        memo={continuation.stash.memo ?? link.memo}
        busy={claiming}
        onHandOff={handOff}
        status={claiming || running ? "Claiming" : LINK_STATUS_LABEL[link.status]}
        error={
          // A claim at work says so in its status alone; once sent, this account's own claim spent
          // the link and the sweep notice says what happens next.
          running
            ? undefined
            : publishing
            ? closedLinkMessage(link.status)
            : continuation.activation.state === "submitted"
            ? hold
            : closedLinkMessage(link.status) ??
              hold ??
              (claimWait
                ? PAYLINK_NOT_CLAIMABLE_YET_MESSAGE
                : unreadable
                ? "Couldn't check when this link can be claimed."
                : claimWait === undefined
                ? "Checking when this link can be claimed…"
                : undefined)
        }
        notices={
          publishing ? (
            <BroadcastStatusRow
              address={continuation.record.sipaAddress}
              fallback="Publishing your deposit address. The payment funds it once that lands."
            />
          ) : hold && continuation.activation.state !== "submitted" ? (
            <button
              type="button"
              className="zkm-btn-reset ww-send-to__link"
              onClick={registrationPage}
            >
              Check registration
            </button>
          ) : !hold && unreadable ? (
            <button type="button" className="zkm-btn-reset ww-send-to__link" onClick={retryRead}>
              Try again
            </button>
          ) : undefined
        }
        claimable={
          continuation.activation.state === "ready" &&
          link.status === "unclaimed" &&
          claimWait === 0 &&
          !running
        }
        onClaim={claim}
        onClose={onDone}
      />
    ) : (
      <ClaimLinkModal
        link={link}
        claimWait={claimWait}
        countdown={countdown}
        loading={loading}
        onRetryRead={unreadable ? retryRead : undefined}
        onClose={dismiss}
        onClaim={claim}
        onClaimToL1={() => setL1Open(true)}
      />
    )

  return { modal }
}
