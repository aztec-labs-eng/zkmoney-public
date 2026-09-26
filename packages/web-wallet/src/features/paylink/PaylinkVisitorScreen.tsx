import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { formatUnits } from "viem"
import { DEFAULT_DECIMALS, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { Icon, PrimaryGradientButton, Spinner } from "@obsidion/web-ds"
import { currentFpcFundingCut } from "../fees/fpcFundingCut"
import { fireEvent } from "../../lib/analytics"
import { shortAddr, usdFigure } from "../../ui/format"
import { withdrawalStatus } from "../../ui/screens/WithdrawalDetailModal"
import { InvitationChrome } from "../onboarding/InvitationChrome"
import { clearTicketSignup, stashClaimLink, stashTicketSignup } from "./claimStash"
import { useGoldenTicketOffer } from "./goldenTicketOffer"
import { PaylinkOnboardingScreen } from "./PaylinkOnboardingScreen"
import { ticketSignupCommitted } from "./ticketContinuation"
import { ClaimProgressModal } from "./ClaimProgressModal"
import { ClaimToL1Modal } from "./ClaimToL1Modal"
import { cashOutLink, planCashOutSwap } from "./paylinkExit"
import { useLinkVoucher, useLinkWithdrawal } from "./usePaylinkDeps"
import type { PaymentLink } from "./types"

/**
 * `/link#…` for a visitor with no account. A link whose escrow holds a voucher offers two ways to
 * take the money — an account here, or a claim to an external Ethereum wallet the link itself pays
 * for — and asks which before either. Without a voucher the only way through is signup, so the page
 * opens on it, and the stashed fragment reopens as the claim prompt once that lands.
 *
 * Both choices stay visible while funding is checked; the external claim enables once the read
 * succeeds and the signer connects. A failed check offers retry instead of silently selecting signup.
 */
export function PaylinkVisitorScreen({
  link,
  statusSettled = true,
}: {
  link: PaymentLink
  /** The page's status read is over. The voucher read registers the same escrow, and a PXE
   *  cannot take two registrations of one contract at once; held until the first is done. */
  statusSettled?: boolean
}) {
  const navigate = useNavigate()
  const { uses, deps, error, retry } = useLinkVoucher(link, { enabled: statusSettled })
  const withdrawal = useLinkWithdrawal(link)
  const [signup, setSignup] = useState(false)
  // Decided once, when signup starts: the claim that ends the ticket signup clears its stash, and
  // the wizard must not remount into an ordinary signup under the user while it finishes.
  const [ticketSignup, setTicketSignup] = useState(false)
  const [cashOut, setCashOut] = useState(false)
  const [progressOpen, setProgressOpen] = useState(true)
  // The network's ticket offer decides what "Receive to zk.money" means: the link paying for the
  // account (the three-step signup), or an ordinary signup with the link claimed on Home after. A
  // read that failed decides neither, so the choice retries it instead.
  const { offer, failed: offerFailed, retry: retryOffer } = useGoldenTicketOffer()
  // An external claim pays the relayer tip and the portal's cut. The figure waits on the cut.
  const [feeDisplay, setFeeDisplay] = useState<string>()

  useEffect(() => {
    let live = true
    void currentFpcFundingCut()
      .then((cut) => {
        if (live)
          setFeeDisplay(usdFigure(formatUnits(WITHDRAW_RELAYER_TIP + cut, DEFAULT_DECIMALS)))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

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

  const known = uses !== undefined
  const canCashOut = !!uses && uses > 0
  // The burn seeds its record before it mines; the sheet that started it stays up until it resolves.
  const tracking = withdrawal && !cashOut
  // A link this browser cashed out reads as claimed on chain. Saying so plainly is the difference
  // between "your money is on its way" and "someone else took it".
  // The ticket signup keeps this page as the backdrop of its modal steps.
  const choosing = !tracking && (!signup || ticketSignup) && (!known || canCashOut || cashOut)

  const startSignup = () => {
    if (offer === undefined) return
    fireEvent("paylink_visitor_chose", { choice: "account", ticket: Boolean(offer) })
    if (offer) {
      stashTicketSignup({
        fragment: link.fragment,
        threshold: offer.threshold,
        schedule: offer.schedule,
        ...(link.memo ? { memo: link.memo } : {}),
      })
    } else clearTicketSignup()
    setTicketSignup(Boolean(offer))
    setCashOut(false)
    setSignup(true)
  }

  const summary = (
    <>
      <span className="ww-invite-modal-badge">
        <Icon name="link" size={32} color="#fff" />
      </span>
      <div className="ww-paylink-summary">
        <span className="ww-paylink-summary__label">
          {tracking ? "You withdrew" : link.status === "claimed" ? "This link has been used" : "Someone sent you"}
        </span>
        {link.amount && <span className="ww-paylink-summary__amount">${link.amount}</span>}
        {link.memo && <span className="ww-paylink-summary__note">{link.memo}</span>}
      </div>
      {link.flavor === "email" && link.email && !tracking && (
        <span className="ww-paylink-summary__pill">
          EMAIL <b>{link.email}</b>
        </span>
      )}
      {(tracking || link.status === "claimed" || (known && !canCashOut)) && (
        <p className="ww-paylink-summary__caption">
          {tracking
            ? `${withdrawalStatus(withdrawal).label} — to ${shortAddr(withdrawal.recipient)}`
            : link.status === "claimed"
            ? "It was claimed, or the sender cancelled it. Either way it can't be claimed again."
            : "Log in or sign up to zk.money to receive your payment"}
        </p>
      )}
    </>
  )

  if (tracking) {
    return (
      <InvitationChrome>
        <div className="ww-invite__content ww-invite__content--landing">
          {summary}
          <p className="ww-invite-modal-foot">
            Ethereum releases the funds on its own — there is nothing left for you to do here.
          </p>
        </div>
        {progressOpen && (
          <ClaimProgressModal
            record={withdrawal}
            memo={link.memo}
            onClose={() => setProgressOpen(false)}
          />
        )}
      </InvitationChrome>
    )
  }

  // A spent link has nothing to offer: the message is the whole page. A link this browser is cashing
  // out reads as claimed once the burn lands, so that sheet stays up until it resolves.
  if (link.status === "claimed" && !cashOut) {
    return (
      <InvitationChrome>
        <div className="ww-invite__content ww-invite__content--landing">{summary}</div>
      </InvitationChrome>
    )
  }

  if (choosing) {
    const externalCaption = error
      ? "Couldn't check availability."
      : !known
      ? "Checking availability…"
      : !deps
      ? "Connecting…"
      : feeDisplay
      ? `Slower and pays a ${feeDisplay} fee. Public onchain payment.`
      : "Slower and pays a network fee. Public onchain payment."
    return (
      <InvitationChrome>
        <div className="ww-invite__content ww-invite__content--landing">
          {summary}
          <p className="ww-paylink-summary__caption">Choose how to receive payment</p>
          <div className="ww-paymethods">
            {/* Until the offer is read the button promises nothing: a click here would have to
                pick the paid signup for a visitor the link may be about to pay for. A read that
                failed is not a confirmed absence, so the click retries it. */}
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-deposit__connect ww-paymethod ww-paymethod--best"
              disabled={signup || (offer === undefined && !offerFailed)}
              onClick={offerFailed ? retryOffer : startSignup}
            >
              {offer !== undefined && (
                <span className="ww-paymethod__flag">
                  <span>{offer === null ? "Private" : "Free"}</span>
                </span>
              )}
              <span className="ww-deposit__connect-icon">
                <Icon name="lock-shield" size={24} color="#fff" />
              </span>
              <span className="ww-deposit__connect-text">
                <b>Receive to zk.money</b>
                <span>
                  {offerFailed
                    ? "Couldn't check what this link pays for. Tap to try again."
                    : offer === undefined
                    ? "Checking what this link pays for…"
                    : offer === null
                    ? "Create an account to receive it. Your balance stays private."
                    : "Free and instant. Your balance stays private."}
                </span>
              </span>
              {offer === undefined && !offerFailed ? (
                <Spinner size={16} />
              ) : (
                <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
              )}
            </button>
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-deposit__connect ww-paymethod"
              disabled={!known || !canCashOut || !deps || signup}
              onClick={() => {
                fireEvent("paylink_visitor_chose", { choice: "ethereum" })
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
              {!known && !error ? (
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
            // No passkey in this flow, so the signing hand-off never fires; the modal closes when
            // the burn resolves and the progress sheet carries the withdrawal from there.
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
            onClaimInstead={startSignup}
          />
        )}
      </InvitationChrome>
    )
  }

  return (
    <InvitationChrome>
      <PaylinkOnboardingScreen embedded inviteHeader={summary} />
    </InvitationChrome>
  )
}
