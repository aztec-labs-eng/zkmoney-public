import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { canSelfFinalizeWithdrawal, useAztecContext, withdrawalAmounts } from "@obsidion/front-core"
import { Icon, PrimaryGradientButton, Spinner } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { fireEvent } from "../../lib/analytics"
import { shortAddr, usdFigure } from "../../ui/format"
import type { EntryOpener, NotificationScope } from "../../ui/NotificationsPanel"
import { NotificationsBell } from "../../ui/NotificationsBell"
import { withdrawalStatus } from "../../ui/screens/WithdrawalDetailModal"
import { NotificationsMount } from "../notifications/NotificationsMount"
import { operationIdOf } from "../operations/operationEntries"
import { TabLine } from "../operations/TabLine"
import { releaseNote } from "../withdraw/waitingNote"
import { SwapExitModal } from "../withdraw/SwapExitModal"
import { swapExitReasonFor, type SwapExitReason } from "../withdraw/swapRecovery"
import { WithdrawalExitModal } from "../withdraw/WithdrawalExitModal"
import { InvitationChrome } from "../onboarding/InvitationChrome"
import { clearTicketSignup, stashClaimLink, stashTicketSignup } from "./claimStash"
import { useGoldenTicketOffer } from "./goldenTicketOffer"
import { PaylinkOnboardingScreen } from "./PaylinkOnboardingScreen"
import { ticketSignupCommitted, ticketSignupResumable } from "./ticketContinuation"
import {
  belowTicketThresholdCopy,
  linkBaseUnits,
  linkTicketEligibility,
  ticketThresholdLabel,
} from "./ticketThreshold"
import { ClaimProgressModal, hasClaimReceipt } from "./ClaimProgressModal"
import { ClaimToL1Modal } from "./ClaimToL1Modal"
import { usePolledChainSeconds } from "./chainTime"
import { claimWaitSeconds, useClaimCountdown } from "./claimWindow"
import { cashOutLink, planCashOutSwap } from "./paylinkExit"
import { useLinkVoucher, useLinkWithdrawal } from "./usePaylinkDeps"
import { CLOSED_LINK_COPY } from "./claimWindow"
import type { PaymentLink } from "./types"

/**
 * `/link#…` for a visitor with no account. A link whose escrow holds a voucher offers two ways to
 * take the money — an account here, or a claim to an external Ethereum wallet the link itself pays
 * for — and asks which before either. Without a voucher the only way through is signup, so the page
 * opens on it, and the stashed fragment reopens as the claim prompt once that lands.
 *
 * Both choices stay visible while funding is checked; the external claim enables once the read
 * succeeds and the signer connects. A failed check offers retry instead of silently selecting signup.
 *
 * A cash-out is an ordinary operation with the page as its row: status and whether the page may
 * close, then its receipt, which the bell opens too.
 */
export function PaylinkVisitorScreen({
  link,
  statusSettled = true,
  onRetryStatus,
}: {
  link: PaymentLink
  /** The page's status read is over. The voucher read registers the same escrow, and a PXE
   *  cannot take two registrations of one contract at once; held until the first is done. */
  statusSettled?: boolean
  /** Reads the link's status again. */
  onRetryStatus: () => void
}) {
  const navigate = useNavigate()
  const { obsidionWallet } = useAztecContext()
  // A claim is offered only once the window is known to be open; the chain refuses one before.
  const chainNow = usePolledChainSeconds(obsidionWallet?.node)
  const claimWait = claimWaitSeconds(link.claimableFrom, chainNow)
  const countdown = useClaimCountdown(claimWait, chainNow, obsidionWallet?.node)
  // The status reads stopped without the note, so the window stays unknown until a re-read.
  const unreadable = statusSettled && link.status === "unclaimed" && link.claimableFrom == null
  const { uses, deps, error, retry } = useLinkVoucher(link, { enabled: statusSettled })
  const withdrawal = useLinkWithdrawal(link)
  const [signup, setSignup] = useState(false)
  // Decided once, when signup starts: the claim that ends the ticket signup clears its stash, and
  // the wizard must not remount into an ordinary signup under the user while it finishes.
  const [ticketSignup, setTicketSignup] = useState(false)
  const [cashOut, setCashOut] = useState(false)
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [exit, setExit] = useState<"finalize" | SwapExitReason | null>(null)
  // The manual exits open on elapsed time, not on a record write, so the page re-reads the clock.
  const [now, setNow] = useState(Date.now)
  const burned = !!withdrawal?.l2TxHash
  useEffect(() => {
    if (!burned) return
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [burned])
  // The network's ticket offer decides what "Receive to zk.money" means: the link paying for the
  // account (the three-step signup), or an ordinary signup with the link claimed on Home after. A
  // read that failed decides neither, so the choice retries it instead.
  const { offer, failed: offerFailed, retry: retryOffer } = useGoldenTicketOffer()

  useEffect(() => {
    stashClaimLink(link.fragment)
  }, [link.fragment])

  // Leaving the page (Close, back, another route) before the tag is claimed drops the ticket
  // intent; the link stays stashed for an ordinary claim. Once the ticket bought a registration
  // the marker is that signup's continuation and outlives this page.
  useEffect(() => {
    if (!ticketSignup) return
    return () => {
      if (!ticketSignupCommitted(link.fragment)) clearTicketSignup()
    }
  }, [ticketSignup, link.fragment])

  // A shared browser holds other visitors' cash-outs and other notifications: this page's bell
  // shows only this link's.
  const localId = withdrawal?.localId
  const operationId = withdrawal?.operationId
  const scope = useMemo<NotificationScope>(
    () => ({
      entry: (entry) => {
        const target = entry.target as { type: string; bridgeKind?: string; sourceId?: string }
        const own =
          target.type === "bridge.txDetail" &&
          target.bridgeKind === "withdrawal" &&
          localId !== undefined &&
          target.sourceId === localId
        return own || (operationId !== undefined && operationIdOf(entry.id) === operationId)
      },
      operation: (id) => operationId !== undefined && id === operationId,
    }),
    [localId, operationId],
  )
  const openEntry: EntryOpener = () =>
    withdrawal && hasClaimReceipt(withdrawal) ? () => setReceiptOpen(true) : null
  const bell = <NotificationsBell openEntry={openEntry} place="page" scope={scope} />

  const known = uses !== undefined
  const canCashOut = !!uses && uses > 0
  // The burn seeds its record before it proves; the sheet that started it stays up until it hands off.
  const tracking = withdrawal && !cashOut
  // A link with no voucher has one way through, the ordinary signup: the ticket signup's claim
  // batch is paid by the voucher, so a spent one cannot pay for the account.
  const voucherless = known && !canCashOut && !cashOut
  // The same manual exits a wallet's activity row offers once no relayer has moved the withdrawal.
  const canFinalize = !!withdrawal && canSelfFinalizeWithdrawal(withdrawal, now)
  const swapExit = withdrawal ? swapExitReasonFor(withdrawal, now) : null
  // A link this browser cashed out reads as claimed on chain. Saying so plainly is the difference
  // between "your money is on its way" and "someone else took it".
  // The ticket signup keeps this page as the backdrop of its modal steps whatever the reads say
  // once it has started: the wizard is never swapped under the visitor.
  const choosing = !tracking && (ticketSignup || (!signup && !voucherless))
  // With a ticket on offer the account option promises it only once the voucher read has answered.
  const ticketUnread = !!offer && !known
  const decimals = tokenDecimalsForNetwork(getConfig().network)
  // The note's amount as this page read it: it decides whether a new ticket signup may start, and
  // prices the signup's split at once.
  const amount = linkBaseUnits(link.amount, decimals)
  const eligibility = linkTicketEligibility(
    offer,
    amount,
    canCashOut && !ticketSignupResumable(link.fragment),
  )
  // The status reads stopped without the note: their re-read is the retry.
  const amountFailed = eligibility === "unknown" && statusSettled
  const thresholdNote =
    offer && eligibility === "below_threshold"
      ? belowTicketThresholdCopy(ticketThresholdLabel(offer.threshold, decimals))
      : undefined
  const accountRetry = offerFailed
    ? retryOffer
    : ticketUnread && error
    ? retry
    : amountFailed
    ? onRetryStatus
    : undefined
  const accountChecking =
    !accountRetry && (offer === undefined || ticketUnread || eligibility === "unknown")

  const startSignup = () => {
    if (offer === undefined || ticketUnread) return
    const ticket = !!offer && canCashOut
    if (eligibility !== undefined && eligibility !== "eligible") return
    fireEvent("paylink_visitor_chose", { choice: "account", ticket })
    if (ticket) {
      stashTicketSignup({
        fragment: link.fragment,
        threshold: offer.threshold,
        schedule: offer.schedule,
        ...(link.memo ? { memo: link.memo } : {}),
        amount,
      })
    } else clearTicketSignup()
    setTicketSignup(ticket)
    setCashOut(false)
    setSignup(true)
  }

  const closed = link.status === "unclaimed" ? undefined : CLOSED_LINK_COPY[link.status]
  const summary = (
    <>
      <span className="ww-invite-modal-badge">
        <Icon name="link" size={32} color="#fff" />
      </span>
      <div className="ww-paylink-summary">
        <span className="ww-paylink-summary__label">
          {tracking ? "You withdrew" : closed ? closed.title : "Someone sent you"}
        </span>
        {/* A cash-out spends the escrow note the link's amount is read from; the record keeps it,
            gross of the fee the receipt itemizes. */}
        {tracking ? (
          <span className="ww-paylink-summary__amount">
            {usdFigure(withdrawalAmounts(withdrawal).grossDisplay)}
          </span>
        ) : (
          link.amount && <span className="ww-paylink-summary__amount">${link.amount}</span>
        )}
        {link.memo && <span className="ww-paylink-summary__note">{link.memo}</span>}
      </div>
      {link.flavor === "email" && link.email && !tracking && (
        <span className="ww-paylink-summary__pill">
          EMAIL <b>{link.email}</b>
        </span>
      )}
      {(tracking || closed || (known && !canCashOut)) && (
        <p className="ww-paylink-summary__caption">
          {tracking
            ? `${withdrawalStatus(withdrawal).label} — to ${shortAddr(withdrawal.recipient)}`
            : closed
            ? closed.caption
            : "Log in or sign up to zk.money to receive your payment"}
        </p>
      )}
    </>
  )

  let page: ReactNode
  if (tracking) {
    page = (
      <InvitationChrome actions={bell}>
        <div className="ww-invite__content ww-invite__content--landing">
          {summary}
          <p className="ww-invite-modal-foot">
            <TabLine operationId={withdrawal.operationId} place="page" />
            {releaseNote(withdrawal, now)}
          </p>
          {canFinalize && (
            <PrimaryGradientButton
              title="Finalize it yourself"
              onClick={() => setExit("finalize")}
            />
          )}
          {swapExit && (
            <PrimaryGradientButton
              title={swapExit === "stuck" ? "Run swap manually" : "Recover"}
              onClick={() => setExit(swapExit)}
            />
          )}
          {hasClaimReceipt(withdrawal) && (
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              onClick={() => setReceiptOpen(true)}
            >
              View receipt
            </button>
          )}
        </div>
      </InvitationChrome>
    )
  } else if (closed && !cashOut) {
    // A closed link has nothing to offer: the message is the whole page. A link this browser is
    // cashing out reads as claimed once the burn lands, so that sheet stays up until it resolves.
    page = (
      <InvitationChrome actions={bell}>
        <div className="ww-invite__content ww-invite__content--landing">{summary}</div>
      </InvitationChrome>
    )
  } else if (choosing) {
    const checking = !known || (claimWait === undefined && !unreadable)
    const externalCaption = error
      ? "Couldn't check availability."
      : checking
      ? "Checking availability…"
      : unreadable
      ? "Couldn't check when this link can be claimed. Tap to try again."
      : countdown
      ? countdown
      : !deps
      ? "Connecting…"
      : "Slower. Public onchain payment."
    page = (
      <InvitationChrome actions={bell}>
        <div className="ww-invite__content ww-invite__content--landing">
          {summary}
          <p className="ww-paylink-summary__caption">Choose how to receive payment</p>
          <div className="ww-paymethods">
            {/* Until the offer, voucher and amount are read the button promises nothing: a click
                here would have to pick the paid signup for a visitor the link may be about to pay
                for. A read that failed is not a confirmed absence, so the click retries it. */}
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-deposit__connect ww-paymethod ww-paymethod--best"
              disabled={signup || accountChecking || thresholdNote !== undefined}
              onClick={accountRetry ?? startSignup}
            >
              {offer !== undefined && (
                <span className="ww-paymethod__flag">
                  <span>Private</span>
                </span>
              )}
              <span className="ww-deposit__connect-icon">
                <Icon name="lock-shield" size={24} color="#fff" />
              </span>
              <span className="ww-deposit__connect-text">
                <b>Receive to zk.money</b>
                <span>
                  {accountRetry
                    ? "Couldn't check what this link pays for. Tap to try again."
                    : accountChecking
                    ? "Checking what this link pays for…"
                    : thresholdNote
                    ? thresholdNote
                    : offer === null
                    ? "Create an account to receive it. Your balance stays private."
                    : "Instant. Your balance stays private."}
                </span>
              </span>
              {accountChecking ? (
                <Spinner size={16} />
              ) : (
                <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
              )}
            </button>
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-deposit__connect ww-paymethod"
              disabled={
                !known || !canCashOut || signup || (!unreadable && (!deps || claimWait !== 0))
              }
              onClick={() => {
                if (unreadable) return onRetryStatus()
                fireEvent("paylink_visitor_chose", {
                  choice: "ethereum",
                  // Whether a free account was on offer; unset while that read is pending or failed.
                  ...(offer !== undefined ? { ticket: Boolean(offer) } : {}),
                })
                setCashOut(true)
              }}
            >
              <span className="ww-deposit__connect-icon">
                <Icon name="wallet" size={24} color="#fff" />
              </span>
              <span className="ww-deposit__connect-text">
                <b>Claim to an Ethereum wallet</b>
                <span>{externalCaption}</span>
              </span>
              {checking && !error ? (
                <Spinner size={16} />
              ) : (
                <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
              )}
            </button>
          </div>
          {error && (
            <>
              <p className="ww-invite-modal-error" role="alert">
                {error}
              </p>
              <PrimaryGradientButton title="Try again" buttonStyle="dark" onClick={retry} />
            </>
          )}
          <p className="ww-invite-modal-foot">
            Already have an account?{" "}
            <button
              type="button"
              className="zkm-btn-reset ww-invite__link"
              onClick={() => navigate("/enter")}
            >
              Log in
            </button>
          </p>
        </div>
        {signup && ticketSignup && (
          <PaylinkOnboardingScreen
            embedded
            ticketSignup
            // Back to the choice; the effect above drops the uncommitted ticket intent.
            onExit={() => {
              setTicketSignup(false)
              setSignup(false)
            }}
          />
        )}
        {cashOut && deps && (
          <ClaimToL1Modal
            link={link}
            ready={true}
            onClose={() => setCashOut(false)}
            // No passkey in this flow: the modal closes as the proof starts, and the page carries
            // the withdrawal from there.
            onHandOff={() => setCashOut(false)}
            onConfirm={(choice, onStage) =>
              cashOutLink(
                { ...deps, screener: choice.screener },
                link.fragment,
                choice.recipient,
                onStage,
                choice.receiveAsset,
                choice.quote,
                choice.zkProof,
                choice.swap,
              )
            }
            planSwap={(recipient, receiveAsset, quote, amount) =>
              planCashOutSwap(deps, link.fragment, amount, recipient, receiveAsset, quote)
            }
            onClaimInstead={thresholdNote ? undefined : startSignup}
          />
        )}
      </InvitationChrome>
    )
  } else {
    page = (
      <InvitationChrome actions={bell}>
        <PaylinkOnboardingScreen embedded inviteHeader={summary} />
      </InvitationChrome>
    )
  }

  return (
    <>
      {/* No wallet shell here: the page runs the producers the bell reads. */}
      <NotificationsMount />
      {page}
      {exit === "finalize" && withdrawal && (
        <WithdrawalExitModal record={withdrawal} onClose={() => setExit(null)} />
      )}
      {exit && exit !== "finalize" && withdrawal && (
        <SwapExitModal
          record={withdrawal}
          reason={exit}
          linkFragment={link.fragment}
          onClose={() => setExit(null)}
        />
      )}
      {receiptOpen && withdrawal && (
        <ClaimProgressModal
          record={withdrawal}
          memo={link.memo}
          onClose={() => setReceiptOpen(false)}
        />
      )}
    </>
  )
}
