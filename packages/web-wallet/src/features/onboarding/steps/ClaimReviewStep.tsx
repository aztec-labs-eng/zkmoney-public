import type { ReactNode } from "react"
import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import type { PaylinkSignupQuote } from "../../paylink/paylinkSignupQuote"
import { OnboardingCard, OnboardingSpinnerBody } from "../OnboardingCard"
import { formatTokenAmount } from "./DepositTermsRows"
import { PaylinkSignupRows } from "./PaylinkSignupRows"
import { SignupStepper } from "./SignupStepper"

/**
 * Step three of a paylink-funded signup (Figma 11118:54014): the payment, its memo and the exact
 * split the claim commits to — what the tag costs, what the network and prover take, what opens the
 * wallet — before the one batch that claims the link and funds the registration SIPA. Closing keeps
 * the payment unclaimed and the reservation held; Home offers the claim again.
 */
export function ClaimReviewStep({
  quote,
  tokenSymbol,
  tokenDecimals,
  memo,
  busy,
  busyLabel,
  error,
  notices,
  claimable = true,
  onClaim,
  onClose,
}: {
  /** Absent while the portal cut that prices the split is unread: no claim until it lands. */
  quote?: PaylinkSignupQuote
  tokenSymbol: string
  tokenDecimals: number
  memo?: string
  busy: boolean
  busyLabel?: string
  error?: string
  notices?: ReactNode
  /** False while the claim is refused for a reason `error` gives; Close is the only way out. */
  claimable?: boolean
  onClaim: () => void
  onClose: () => void
}) {
  const amount = (v: bigint) => formatTokenAmount(v, tokenDecimals, tokenSymbol)
  return (
    <OnboardingCard
      className="ww-modal--create ww-signup-step"
      onClose={busy ? undefined : onClose}
    >
      <SignupStepper current={2} />
      <div className="ww-claim-review">
        <div className="ww-claim-review__payment">
          <span className="ww-paylink-summary__label">Someone sent you</span>
          <span className="ww-paylink-summary__amount" data-testid="claim-review-amount">
            {quote?.paylink === undefined ? "a payment" : amount(quote.paylink)}
          </span>
          {memo && <span className="ww-paylink-summary__note">{memo}</span>}
        </div>
        <PaylinkSignupRows quote={quote} tokenSymbol={tokenSymbol} tokenDecimals={tokenDecimals} />
        <p className="ww-reg-sheet__warn">
          <Icon name="info-circle" size={16} color="var(--text-secondary)" />
          <span>
            The network fee and the proving fee leave the payment to register your tag; what remains
            opens your wallet once the claim confirms. Registration completes later, when the
            network sweeps the deposit and returns a little more.
          </span>
        </p>
        {quote?.covers === false && (
          <p className="ww-invite-modal-error" role="alert">
            This payment cannot cover the account deposit.
          </p>
        )}
      </div>
      <span className="ww-claim-review__status">
        <Icon name="clock" size={14} color="var(--accent-yellow, #f5c542)" />
        Unclaimed
      </span>
      {error && (
        <p className="ww-invite-modal-error" role="alert">
          {error}
        </p>
      )}
      {notices}
      {busy ? (
        <OnboardingSpinnerBody label={busyLabel ?? "Claiming your payment..."} />
      ) : (
        <div className="ww-claim-review__actions">
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-claim-review__close"
            onClick={onClose}
          >
            Close
          </button>
          <PrimaryGradientButton
            title="Claim"
            isDisabled={quote === undefined || quote.covers === false || !claimable}
            onClick={onClaim}
          />
        </div>
      )}
    </OnboardingCard>
  )
}
