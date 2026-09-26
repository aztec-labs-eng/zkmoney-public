import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { parseUnits } from "viem"
import {
  isPaylinkWindowRevert,
  useAztecContext,
  useContractServiceContext,
  TxInFlightError,
} from "@obsidion/front-core"
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
  isPaylinkNotYetClaimable,
  PAYLINK_CLAIM_MARGIN_SECONDS,
  PAYLINK_NOT_CLAIMABLE_YET_MESSAGE,
} from "./claimWindow"
import { clearClaimStash } from "./claimStash"
import { obtainEmailClaimProof } from "./emailClaim"
import { GoogleSignInCancelled } from "./googleAuth"
import { watchLink } from "./linkStatus"
import { paylinkSignupQuote } from "./paylinkSignupQuote"
import {
  claimLinkToL1,
  planLinkClaimSwap,
  claimSponsoredLink,
  decodeLink,
  emitLinkOpened,
  type SponsoredPaylinkDeps,
  type ViewLinkDeps,
} from "./sponsoredPaylink"
import { ticketHoldNotice, ticketSignupContinuation } from "./ticketContinuation"
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
 * A link that paid for this account's signup and was left unclaimed at the review step prompts
 * with that review again: the same split, and a claim that burns the registration slice in the
 * batch. Closing it keeps the link stashed — the signup's funding waits for its claim. A signup
 * whose renewed quote the link can no longer pay, whose reservation lapsed, whose address is not
 * published or whose burn already went out shows the review with the reason and no claim: the
 * link is still that signup's, never an ordinary claim, until the signup is renewed, published or
 * abandoned.
 */

/** Fragments with a claim in flight. Module-level so a claim outlives the mount that started it. */
const running = new Set<string>()

/** Test seam. */
export function resetRunningClaimsForTests(): void {
  running.clear()
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
    clearClaimStash(fragment)
    return txHash
  } catch (e) {
    if (e instanceof TxInFlightError) {
      // The node has the claim: a reload must not re-offer Accept for a note this wallet spent.
      clearClaimStash(fragment)
    } else if (!(e instanceof EmailMismatchError)) {
      console.error("paylink claim failed", e)
      fireEvent("action_failed", { action: "paylink:claim", code: failureCode(e) })
    }
    throw e
  } finally {
    running.delete(fragment)
  }
}

export function useClaimLinkFlow(fragment: string | null, onDone: () => void): ClaimLinkFlow {
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

  const [link, setLink] = useState<PaymentLink | null>(null)
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
    handedOff.current = true
    onDone()
  }

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
    // Already claiming: nothing to prompt for — the notification row owns it.
    if (running.has(fragment)) {
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
  // read reliably; before that the placeholder sender serves. The token service names the
  // contract whose Transfer event carries the creator's memo — without it the memo read fails.
  const account = claimDeps?.account
  const tokenService = claimDeps?.tokenService
  const statusDeps: ViewLinkDeps | undefined = useMemo(
    () =>
      obsidionWallet && contractService
        ? { wallet: obsidionWallet, contractService, account, tokenService }
        : undefined,
    [obsidionWallet, contractService, account, tokenService],
  )

  // Grace window: the claim's timestamp check runs at inclusion, so offer nothing the chain would
  // reject. Unknown timing fails open — the contract still gates, and the revert has its own copy.
  const claimableInSec =
    link && isPaylinkNotYetClaimable(link.claimableFrom, chainNow)
      ? link.claimableFrom! + PAYLINK_CLAIM_MARGIN_SECONDS - chainNow!
      : undefined
  // Fail closed while the clock is unknown: an Accept taken then reverted at inclusion, and the row
  // read "Failed" with no reason.
  const timingPending = link?.claimableFrom != null && chainNow === undefined

  useEffect(() => {
    if (!statusDeps || !fragment) return
    return watchLink(statusDeps, fragment, setLink, (e) =>
      showReportableError(e, "paylink:status", {
        message: `Could not check the link's status: ${e instanceof Error ? e.message : String(e)}`,
      }),
    )
  }, [statusDeps, fragment])

  const claim = () => {
    if (!fragment || !link || running.has(fragment) || claimableInSec != null || timingPending) return
    if (continuation) {
      const live = readContinuation()
      if (live?.activation.state !== "ready") {
        rerender()
        return
      }
    }
    if (!claimDeps) {
      showReportableError(
        new Error("The wallet is still loading — try again in a moment"),
        "paylink:claim",
      )
      return
    }
    const owned = fragment
    const live = () => shown.current === owned && !handedOff.current
    // The hand-off means the rest of the claim outlives this mount: its operation's row reports the
    // end, not component state.
    handedOff.current = false
    running.add(owned)
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
        if (isPasskeyCancelled(e) || e instanceof GoogleSignInCancelled) {
          if (live()) setClaiming(false)
          return
        }
        // The claim reached the node and its operation hands off; offering Accept again would burn
        // the note twice.
        if (e instanceof TxInFlightError) return
        // Failed before the hand-off: the reopened prompt is the retry, and the sheet says why.
        if (!live()) return
        setClaiming(false)
        if (e instanceof EmailMismatchError) {
          showErrorModal({ title: "Email mismatch", message: e.message, context: "paylink:claim" })
        } else if (isPaylinkWindowRevert(e)) {
          showErrorModal({
            title: "Not claimable yet",
            message: PAYLINK_NOT_CLAIMABLE_YET_MESSAGE,
            context: "paylink:claim",
          })
        } else {
          showReportableError(e, "paylink:claim", {
            title: "Claim failed",
            message: e instanceof Error ? e.message : "Something went wrong",
          })
        }
      },
    )
  }

  // Registered in `running` like an ordinary claim, so a remount mid-burn shows nothing instead of
  // offering Accept again. The withdrawal record's own live row reports the burn; the stash clears
  // only once it mined.
  const claimToL1 = (
    { recipient, screener, walletName, receiveAsset, quote, zkProof, swap }: ClaimToL1Choice,
    onStage: (stage: WithdrawStage) => void,
  ): Promise<void> => {
    if (!fragment || !link || running.has(fragment)) return Promise.resolve()
    if (link.status !== "unclaimed" || claimableInSec != null || timingPending) {
      return Promise.reject(new Error("This link is not currently claimable"))
    }
    if (!claimDeps) {
      return Promise.reject(new Error("The wallet is still loading — try again in a moment"))
    }
    const owned = fragment
    running.add(owned)
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
    )
      .then(() => clearClaimStash(owned))
      .finally(() => running.delete(owned))
  }

  const dismiss = () => {
    if (fragment) clearClaimStash(fragment)
    onDone()
  }

  const hold = continuation
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

  const modal =
    !fragment || !link ? null : l1Open ? (
      <ClaimToL1Modal
        link={link}
        ready={!!claimDeps}
        onClose={() => setL1Open(false)}
        onHandOff={onDone}
        onConfirm={claimToL1}
        planSwap={(recipient, receiveAsset, quote, amount) =>
          claimDeps
            ? planLinkClaimSwap(claimDeps, fragment, amount, recipient, receiveAsset, quote)
            : Promise.reject(new Error("The wallet is still loading — try again in a moment"))
        }
      />
    ) : claiming ? (
      <ClaimProvingModal
        beat={beat}
        onCancel={beat === "signing-in" ? () => signInAbort.current?.abort() : undefined}
        onLeave={handOff}
      />
    ) : continuation ? (
      <ClaimReviewStep
        quote={
          deductions === undefined
            ? undefined
            : paylinkSignupQuote({
                ...(paylinkAmount !== undefined ? { paylink: paylinkAmount } : {}),
                // Only a ready signup has a fundable quote; the split it was offered stands in.
                schedule:
                  continuation.activation.state === "ready"
                    ? continuation.activation.schedule
                    : {
                        fee: BigInt(continuation.stash.schedule.fee),
                        min: BigInt(continuation.stash.schedule.minDeposit),
                      },
                cuts: { withdrawalCut: deductions.fpcCut, depositCut: deductions.fpcCut },
                sweepFee,
              })
        }
        tokenSymbol={WALLET_TOKEN_SYMBOL}
        tokenDecimals={tokenDecimalsForNetwork(config.network)}
        memo={continuation.stash.memo ?? link.memo}
        busy={false}
        error={hold ?? (claimableInSec != null ? PAYLINK_NOT_CLAIMABLE_YET_MESSAGE : undefined)}
        notices={
          hold && continuation.activation.state !== "submitted" ? (
            <button
              type="button"
              className="zkm-btn-reset ww-send-to__link"
              onClick={registrationPage}
            >
              Check registration
            </button>
          ) : undefined
        }
        claimable={continuation.activation.state === "ready"}
        onClaim={claim}
        onClose={onDone}
      />
    ) : (
      <ClaimLinkModal
        link={link}
        claimableInSec={claimableInSec}
        timingPending={timingPending}
        onClose={dismiss}
        onClaim={claim}
        onClaimToL1={() => setL1Open(true)}
      />
    )

  return { modal }
}
