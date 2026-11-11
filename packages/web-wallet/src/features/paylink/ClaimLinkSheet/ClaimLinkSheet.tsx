import { WalletError } from "@obsidion/core/errors"
import { useNavigate } from "react-router-dom"
import { parseUnits } from "viem"
import { bestEffort, useStore } from "@obsidion/front-core"
import { WALLET_TOKEN_SYMBOL, tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { fmt } from "../../../lib/fmt"
import { useSession } from "../../../session/session"
import { useScreenFlow } from "../../../ui/useScreenFlow"
import { useActionGuard, useActionVerdict } from "../../actionGate"
import { balanceMovingCopy } from "../../backupPasskey/backupPasskeyCopy"
import { ClaimReviewStep } from "../../onboarding/steps/ClaimReviewStep"
import { useRegistrationPricing } from "../../registration/registrationPricing"
import {
  commitRegistrationProverTip,
  useRegistrationTerms,
} from "../../registration/registrationTerms"
import { useActiveWithdrawalFee } from "../../withdraw/withdrawalFee"
import { SpeedRow } from "../../withdraw/speedChoice"
import { usePolledChainSeconds } from "../chainTime"
import { ClaimLinkModal, ClaimProvingModal } from "../ClaimLinkModal"
import { ClaimToL1Modal } from "../ClaimToL1Modal"
import {
  claimWaitSeconds,
  closedLinkMessage,
  LINK_STATUS_LABEL,
  PAYLINK_NOT_CLAIMABLE_YET_MESSAGE,
  useClaimCountdown,
  withExpiry,
} from "../claimWindow"
import { paylinkSignupQuote } from "../paylinkSignupQuote"
import { useRegistrationSpeed } from "../registrationProverTip"
import { planLinkClaimSwap } from "../sponsoredPaylink"
import {
  bindLinkDeposit,
  ticketHoldNotice,
  ticketSignupCommitted,
  ticketSignupContinuation,
  unfundedRegistration,
} from "../ticketContinuation"
import { claimLinkId, claimRefused } from "../ticketClaim"
import { useLinkVoucher, usePaylinkDeps } from "../usePaylinkDeps"
import copy from "./ClaimLinkSheet.copy"
import { openClaimFlow, reviewQuote, type ClaimInputs } from "./claimFlow"

/**
 * Home's claim of an inbound paylink (ULT-671 pages 6–7). The prompt gives way to the claim sheet
 * for the beats that need the user present (Google sign-in, the zkJWT prove, the passkey), and the
 * sheet closes as the passkey ends: the bell carries the claim from there. A failure before the
 * hand-off reopens the prompt behind an error sheet, the prompt being the retry. Either flavor can
 * instead burn to Ethereum, which runs as a withdrawal with its own live row.
 *
 * A link that paid for this account's signup is claimed by Home's own task; its review opens when
 * asked for, once that claim ended without a claim, when the reads stopped without the window, or
 * when the link closed. Closing it keeps the link stashed, since the signup's funding waits for it.
 *
 * `requested`: an activation surface asked for this link's review, so it opens whatever the claim's
 * state. `onReviewClosed`: that review closed while Home's own claim is still to come.
 */
export function ClaimLinkSheet({
  fragment,
  requested,
  onDone,
  onReviewClosed,
}: {
  fragment: string
  requested: boolean
  onDone: () => void
  onReviewClosed: () => void
}) {
  const session = useSession()
  const claimDeps = usePaylinkDeps()
  const chainNow = usePolledChainSeconds()
  const guard = useActionGuard()
  const claimVerdict = useActionVerdict("claim")
  const navigate = useNavigate()
  const decimals = tokenDecimalsForNetwork(session.page.config.network)
  const inputs: ClaimInputs = {
    requested,
    onDone,
    claimDeps,
    chainNow,
    detecting: false,
    funding: null,
  }
  const flow = useScreenFlow(inputs, (latest) => openClaimFlow(session, fragment, latest))
  const s = useStore(flow.state)
  const link = s.link && withExpiry(s.link, chainNow)

  // The signup this link paid for, while this account still owes it the claim's burn. Until the
  // burns load, a signup's own burn is missing and it reads as unfunded or funded elsewhere.
  const burnList = useStore(session.withdrawals.list)
  const registrationsRead = useStore(session.registrations.view, (v) => v.loaded || v.failed)
  const claimState = useStore(session.claims.state)
  const burns = burnList.hydrated ? burnList.records : null
  const entered = useStore(session.identity, (i) => i.value?.address)
  const address = claimDeps && entered
  const continuation = burns ? ticketSignupContinuation(session, fragment, address, burns) : null
  // This account's registration still waiting for its deposit, when no registration is this
  // link's yet: the link pays it when its note covers the deposit, the fees and the tip.
  const accountAddress = entered
  const unfunded =
    accountAddress && burns && continuation === null && !ticketSignupCommitted(session, fragment)
      ? unfundedRegistration(session, accountAddress, burns)
      : null
  const running = claimState.running.has(fragment)
  const failure = claimState.reasons.get(fragment)
  const refused = useStore(session.operations.view, ({ records }) =>
    claimRefused(records, claimLinkId(fragment)),
  )
  const { sweepFee } = useRegistrationPricing(continuation !== null || !!unfunded)

  const loading = !s.readSettled && link?.status === "unclaimed" && link.amount === undefined
  // Grace window: the claim's timestamp check runs at inclusion, so a claim is offered only once
  // the window is known to be open.
  const claimWait = claimWaitSeconds(link?.claimableFrom, chainNow)
  const countdown = useClaimCountdown(claimWait, chainNow, session.page)
  const unreadable = s.readSettled && link?.status === "unclaimed" && link.claimableFrom == null
  // Nothing is offered off this tab's earlier read alone, nor once the reads stopped without the
  // note: only a read here supplies its token, email and commitment.
  const offerRetry = s.readSettled && link?.status === "unclaimed" && s.noteMissed
  const offeredWait = s.seedOnly || offerRetry ? undefined : claimWait
  // The automatic claim cannot get past this on its own, so the review is where the tap is.
  const tapOnly =
    link?.flavor === "email" || unreadable || (link !== null && link.status !== "unclaimed")
  // A claim of this link runs, failed for good, or was declined here: Home's own is not to come.
  const tried = running || refused || claimState.declined.has(fragment)
  const autoDue =
    continuation?.activation.state === "ready" && link?.flavor === "direct" && !tapOnly && !tried

  const hold = continuation
    ? ticketHoldNotice(continuation.activation.state, continuation.record.tag)
    : undefined
  const submitted = continuation?.activation.state === "submitted"
  // The review's amount: the note as the signup read it, else as this sheet's own read has it.
  const paylinkAmount =
    continuation?.stash.amount !== undefined
      ? BigInt(continuation.stash.amount)
      : link?.amount !== undefined
      ? parseUnits(link.amount, decimals)
      : undefined
  const reviewing = continuation !== null && (requested || tapOnly || tried)
  // Only a ready signup has a fundable quote; the split it was offered stands in.
  const reviewSchedule = !continuation
    ? undefined
    : continuation.activation.state === "ready"
    ? continuation.activation.schedule
    : {
        fee: BigInt(continuation.stash.schedule.fee),
        min: BigInt(continuation.stash.schedule.minDeposit),
      }
  // Only the review on screen quotes, and only while nothing burned yet.
  const quoting = reviewing && !!link && !s.l1Open && !running && !submitted
  const reviewRecord = continuation?.record
  const reviewTerms = useRegistrationTerms(reviewRecord?.account, reviewRecord?.tag)
  const liveFee = useActiveWithdrawalFee(
    quoting || (reviewing && reviewTerms?.withdrawalFee === undefined),
  )
  const reviewSpeed = useRegistrationSpeed({
    active: quoting,
    noteAmount: paylinkAmount,
    schedule: reviewSchedule,
    withdrawalFee: liveFee,
    initialSpeed: reviewTerms?.speed,
  })

  // The registration this link may fund: its split, shown before the claim, with the speed choice
  // that commits the tip. A link with no voucher, or a note short of the split, claims as any other.
  const voucher = useLinkVoucher(unfunded ? link : null)
  const fundSchedule = unfunded?.schedule
  const fundFee = useActiveWithdrawalFee(!!unfunded)
  const fundSpeed = useRegistrationSpeed({
    active: !!unfunded && voucher.uses !== 0,
    noteAmount: paylinkAmount,
    schedule: fundSchedule,
    withdrawalFee: fundFee,
  })
  // The review is chosen, and priced, only once the voucher and the sweep fee answered.
  const fundQuote =
    voucher.uses !== undefined &&
    sweepFee !== undefined &&
    fundSchedule &&
    fundFee !== undefined &&
    fundSpeed.proverTip !== undefined
      ? paylinkSignupQuote({
          ...(paylinkAmount !== undefined ? { paylink: paylinkAmount } : {}),
          schedule: fundSchedule,
          withdrawalFee: fundFee,
          sweepFee,
          proverTip: fundSpeed.proverTip,
        })
      : undefined
  // Which modal applies is decided before any shows: the plain prompt never flashes ahead of the
  // review. A read that fails, or a decision past its time, falls back to the plain prompt.
  const fundRefused =
    !unfunded ||
    voucher.uses === 0 ||
    voucher.error !== undefined ||
    s.detectExpired ||
    link?.status !== "unclaimed" ||
    fundQuote?.covers === false
  const detecting =
    continuation === null &&
    !!accountAddress &&
    !s.detectExpired &&
    (!registrationsRead || !burns || (!fundRefused && fundQuote === undefined))
  inputs.detecting = detecting
  // The hero asks for no deposit while the link may pay an entered account's unfunded registration,
  // and leads back to the review once it does.
  const linkFunding =
    !unfunded || link?.status !== "unclaimed"
      ? null
      : detecting
      ? "checking"
      : !fundRefused && fundQuote !== undefined
      ? "review"
      : null
  inputs.funding = linkFunding ? { fragment, state: linkFunding, amount: paylinkAmount } : null
  const fundAndClaim = () => {
    const shown = fundSpeed.decision
    if (!unfunded || fundQuote?.covers !== true || !voucher.uses || !shown) return
    const { tip, speed, withdrawalFee } = shown
    const bound = bindLinkDeposit(
      session,
      unfunded.record,
      { fragment, amount: paylinkAmount, senderTag: link?.senderTag },
      tip,
      speed,
      withdrawalFee,
    )
    flow.claim(true, bound ?? Promise.resolve(), false)
  }

  // A signup's tapped claim keeps its review on screen while it runs; an email link's sign-in has
  // the claim sheet, unless the review was asked for.
  const reviewKept = continuation !== null && (requested || link?.flavor === "direct")
  const windowStatus =
    offeredWait === undefined
      ? copy.windowChecking
      : offeredWait
      ? PAYLINK_NOT_CLAIMABLE_YET_MESSAGE
      : undefined
  // The tap commits the speed the review shows; the claim burns it once saved.
  const onClaim = () =>
    guard("claim", () => {
      const shown = reviewSpeed.decision
      const saved =
        reviewRecord && shown
          ? commitRegistrationProverTip(
              session.registrations,
              reviewRecord,
              shown.tip,
              shown.speed,
              shown.withdrawalFee,
            )
          : Promise.resolve()
      // A claim that does not start leaves the save on its own.
      void bestEffort("unknown", saved)
      void flow.claim(continuation !== null, saved)
    })
  if (!link) return null
  if (s.l1Open)
    return (
      <ClaimToL1Modal
        link={link}
        ready={!!claimDeps}
        onClose={() => flow.openL1(false)}
        onHandOff={onDone}
        onConfirm={flow.claimToL1}
        planSwap={(recipient, receiveAsset, quote, amount, proverTip) =>
          claimDeps
            ? planLinkClaimSwap(
                claimDeps.session,
                fragment,
                amount,
                recipient,
                receiveAsset,
                quote,
                proverTip,
              )
            : Promise.reject(new WalletError("invariant", copy.loading))
        }
        offersSpeed
      />
    )
  if (s.claiming && !reviewKept)
    return (
      <ClaimProvingModal
        beat={s.beat}
        onCancel={s.beat === "signing-in" ? flow.cancelSignIn : undefined}
        onLeave={flow.handOff}
      />
    )
  if (continuation && !reviewing) return null
  if (continuation)
    return (
      <ClaimReviewStep
        quote={reviewQuote({
          quoting,
          live: { tip: reviewSpeed.proverTip, fee: liveFee },
          terms: reviewTerms,
          schedule: reviewSchedule,
          paylink: paylinkAmount,
          sweepFee,
        })}
        tokenSymbol={WALLET_TOKEN_SYMBOL}
        tokenDecimals={decimals}
        speed={<SpeedRow choice={reviewSpeed.choice} outcome={reviewSpeed.outcome} />}
        memo={continuation.stash.memo ?? link.memo}
        senderTag={continuation.stash.senderTag ?? link.senderTag}
        busy={s.claiming}
        onHandOff={flow.handOff}
        status={
          running
            ? copy.claiming
            : submitted
            ? fmt(copy.registering, { tag: continuation.record.tag })
            : link.status !== "unclaimed" || offerRetry
            ? LINK_STATUS_LABEL[link.status]
            : windowStatus ?? LINK_STATUS_LABEL[link.status]
        }
        statusDetail={submitted && !running ? copy.sweeping : undefined}
        amount={paylinkAmount}
        // A claim at work or sent has nothing left to claim; its status says what follows.
        settled={running || submitted}
        error={
          running || submitted
            ? undefined
            : closedLinkMessage(link.status) ??
              hold ??
              failure ??
              (offerRetry ? copy.windowUnread : undefined)
        }
        notices={
          hold && !submitted ? (
            <button
              type="button"
              className="zkm-btn-reset ww-send-to__link"
              onClick={() => {
                onDone()
                navigate(`/claim/${continuation.record.tag}`)
              }}
            >
              {copy.checkRegistration}
            </button>
          ) : !hold && offerRetry && !running ? (
            <button
              type="button"
              className="zkm-btn-reset ww-send-to__link"
              onClick={flow.retryRead}
            >
              {copy.tryAgain}
            </button>
          ) : undefined
        }
        claimable={
          continuation.activation.state === "ready" &&
          link.status === "unclaimed" &&
          offeredWait === 0 &&
          !running
        }
        onClaim={onClaim}
        onClose={autoDue ? onReviewClosed : onDone}
      />
    )
  if (detecting) return null
  if (!fundRefused)
    return (
      <ClaimReviewStep
        quote={fundQuote}
        amount={paylinkAmount}
        tokenSymbol={WALLET_TOKEN_SYMBOL}
        tokenDecimals={decimals}
        speed={<SpeedRow choice={fundSpeed.choice} outcome={fundSpeed.outcome} />}
        memo={link.memo}
        senderTag={link.senderTag}
        busy={s.claiming}
        onHandOff={flow.handOff}
        status={windowStatus ?? LINK_STATUS_LABEL[link.status]}
        error={failure}
        claimable={fundQuote?.covers === true && offeredWait === 0 && !running}
        onClaim={fundAndClaim}
        // Close keeps the link: the hero leads back to this review.
        onClose={onDone}
      />
    )
  return (
    <ClaimLinkModal
      link={link}
      claimWait={offeredWait}
      countdown={countdown}
      loading={loading}
      mustUpgrade={claimVerdict === "upgrade"}
      waiting={claimVerdict === "moving" ? balanceMovingCopy.message : undefined}
      onRetryRead={offerRetry ? flow.retryRead : undefined}
      onClose={flow.dismiss}
      onClaim={onClaim}
      onClaimToL1={() => guard("claim", () => flow.openL1(true))}
    />
  )
}
