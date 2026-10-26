import { useRef, type ReactNode } from "react"
import { GradientSpinner, Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import type { PaylinkSignupQuote } from "../../paylink/paylinkSignupQuote"
import { OperationHandOff, type OperationHandOffHandle } from "../../operations/OperationHandOff"
import { OnboardingCard } from "../OnboardingCard"
import { ticketAmountFigure } from "./GoldenTicketHead"
import { PaylinkSignupRows } from "./PaylinkSignupRows"
import { SignupStepper } from "./SignupStepper"
import { senderLine } from "../../paylink/senderLine"

/**
 * Step three of a paylink-funded signup (Figma 11118:54014): the payment, its memo and the exact
 * split the claim commits to — what the tag costs, what the network and prover take, what opens the
 * wallet — before the one batch that claims the link and funds the registration SIPA. Closing keeps
 * the payment unclaimed and the reservation held; Home offers the claim again. Closing while the
 * claim runs hands it to the bell, as its own hand-off would, and it runs on.
 */
export function ClaimReviewStep({
  quote,
  amount,
  statusDetail,
  tokenSymbol,
  tokenDecimals,
  memo,
  senderTag,
  busy,
  status = "Unclaimed",
  onHandOff,
  error,
  notices,
  claimable = true,
  settled = false,
  onClaim,
  onClose,
  speed,
}: {
  /** Absent while the figures that price the split are unread: no claim until they land. */
  quote?: PaylinkSignupQuote
  /** The payment, base units, as stored: the head names it while the split is unpriced. */
  amount?: bigint
  /** The settled status's second line. */
  statusDetail?: string
  /** The speed choice the split commits. */
  speed?: ReactNode
  tokenSymbol: string
  tokenDecimals: number
  memo?: string
  /** The link creator's verified tag. */
  senderTag?: string
  /** The claim runs: its working beat, until it is sent. */
  busy: boolean
  status?: string
  onHandOff?: () => void
  error?: string
  notices?: ReactNode
  /** False while the claim is refused for a reason `error` gives; Close is the only way out. */
  claimable?: boolean
  /**
   * The claim is at work or went out: `status` says what follows, and nothing is left to claim or
   * choose.
   */
  settled?: boolean
  onClaim: () => void
  onClose: () => void
}) {
  const shown = quote?.paylink ?? amount
  const working = useRef<OperationHandOffHandle>(null)
  const close = busy ? () => working.current?.leave() : onClose
  return (
    <OnboardingCard className="ww-modal--create ww-signup-step" onClose={close}>
      <SignupStepper current={2} />
      <div className="ww-claim-review">
        <div className="ww-claim-review__payment">
          <span className="ww-paylink-summary__label">{senderLine(senderTag)}</span>
          <span className="ww-paylink-summary__amount" data-testid="claim-review-amount">
            {shown === undefined
              ? "a payment"
              : `${ticketAmountFigure(shown, tokenDecimals)} ${tokenSymbol}`}
          </span>
          {memo && <span className="ww-paylink-summary__note">{memo}</span>}
        </div>
        <p className="ww-reg-sheet__summary">
          <Icon name="coins" size={20} color="#fff" />
          <span>
            The fees come out of the payment to register your tag; the remainder stays in your
            wallet. Registration can take up to 40 minutes.
          </span>
        </p>
        <PaylinkSignupRows
          quote={quote}
          tokenSymbol={tokenSymbol}
          tokenDecimals={tokenDecimals}
          speed={settled ? undefined : speed}
        />
        {!settled && quote?.covers === false && (
          <p className="ww-invite-modal-error" role="alert">
            This payment cannot cover the account deposit.
          </p>
        )}
      </div>
      {settled ? (
        <div className="ww-invite-spinner" role="status">
          <GradientSpinner />
          <span className="ww-invite-spinner__label">{status}</span>
          {statusDetail && <p className="ww-reg-sheet__note">{statusDetail}</p>}
        </div>
      ) : (
        <span className="ww-claim-review__status">
          <Icon name="clock" size={14} color="var(--accent-yellow, #f5c542)" />
          {status}
        </span>
      )}
      {error && (
        <p className="ww-invite-modal-error" role="alert">
          {error}
        </p>
      )}
      {notices && <div className="ww-claim-review__notices">{notices}</div>}
      {busy && <OperationHandOff ref={working} onLeave={onHandOff ?? onClose} until="sent" />}
      <div className="ww-claim-review__actions ww-sheet__actions">
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-claim-review__close"
          onClick={close}
        >
          Close
        </button>
        {!settled && !busy && (
          <PrimaryGradientButton
            title="Claim"
            isDisabled={quote === undefined || quote.covers === false || !claimable}
            onClick={onClaim}
          />
        )}
      </div>
    </OnboardingCard>
  )
}
