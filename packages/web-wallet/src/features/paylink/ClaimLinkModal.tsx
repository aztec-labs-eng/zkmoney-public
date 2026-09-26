import {
  ConfirmationSheetDetailRow,
  GradientSpinner,
  Icon,
  PrimaryGradientButton,
  StatusBadge,
} from "@obsidion/web-ds"
import googleLogo from "../../assets/paylink/google-logo.png"
import { getConfig } from "../../config/env"
import { l2TxUrl } from "../../lib/explorer"
import { rowTimestamp, shortAddr } from "../../ui/format"
import { Modal } from "../../ui/Modal"
import { useUserFlowActive } from "../provingGate"
import { formatClaimCountdown } from "./claimWindow"
import type { CreateStage, PaymentLink } from "./types"
import type { EmailClaimStage } from "./emailClaim"
import { useBusyLabel } from "../operations/operations"
import { OperationHandOff } from "../operations/OperationHandOff"
import { WORKING_WARNING } from "../contacts/PayWorking"

export type ClaimStage = CreateStage | EmailClaimStage

/** The beats the claim sheet holds the user for before the passkey. */
export type ClaimBeat = EmailClaimStage | "building"

const BEAT_LABEL: Record<ClaimBeat, string> = {
  "signing-in": "Signing in with Google...",
  "proving-jwt": "Proving your email — this can take a minute",
  "building": "Preparing transaction...",
}
const SIGNING_LABEL = "Confirm with passkey..."

/**
 * Claim prompt for an inbound paylink, shown over Home (ULT-671 page 6). Direct flavor offers
 * Decline / Accept; email flavor offers Claim with Google (the zkJWT path). Declining only dismisses the prompt — the link stays claimable from its URL. The claim
 * itself runs through useClaimLinkFlow, which swaps this prompt for ClaimProvingModal.
 */
export function ClaimLinkModal({
  link,
  claimableInSec,
  timingPending = false,
  onClose,
  onClaim,
  onClaimToL1,
}: {
  link: PaymentLink
  /** Seconds of grace left; while set the claim buttons give way to a countdown. */
  claimableInSec?: number
  /** The link has a grace window and chain time is not known yet: hold the claim rather than offer
   *  one the chain may still refuse. */
  timingPending?: boolean
  onClose: () => void
  onClaim: () => void
  /** Open the external-wallet claim sheet instead of claiming into the wallet. */
  onClaimToL1?: () => void
}) {
  const config = getConfig()
  const claimed = link.status === "claimed"
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  return (
    <Modal variant="create" label="Claim your payment" onClose={onClose}>
      <div className="ww-create-modal__body">
        <div className="ww-claim-modal__head">
          <StatusBadge
            label={claimed ? "Claimed" : "Unclaimed"}
            badgeStyle={claimed ? "pending" : "awaitingClaim"}
          />
          {link.amount && <span className="ww-claim-modal__amount">${link.amount}</span>}
          <div className="ww-claim-modal__copy">
            <span className="ww-claim-modal__title">Claim your payment</span>
            <span className="ww-claim-modal__sub">
              {claimed
                ? "This link has been used: claimed, or cancelled by the sender. It can't be claimed again."
                : link.flavor === "email"
                ? `Confirm ${link.email ?? "your email"} to securely receive funds in your account`
                : "Accept to receive funds in your account"}
            </span>
          </div>
        </div>

        <div className="ww-review-card">
          {link.memo && <ConfirmationSheetDetailRow label="Note" value={link.memo} />}
          <ConfirmationSheetDetailRow label="Date" value={rowTimestamp(Date.now())} />
          {link.txHash && (
            <ConfirmationSheetDetailRow
              label="Tx hash"
              value={
                <a
                  className="ww-request-detail__hash"
                  href={l2TxUrl(config.network, config.nodeUrl, link.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddr(link.txHash)}
                  <Icon name="share-box" size={16} color="currentColor" />
                </a>
              }
            />
          )}
        </div>

        {claimed ? (
          <PrimaryGradientButton title="Go to wallet" buttonStyle="dark" onClick={onClose} />
        ) : claimableInSec != null ? (
          <div className="ww-claim-modal__actions">
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="ww-claim-modal__sub">
                {`Ready to claim in ${formatClaimCountdown(claimableInSec)}`}
              </span>
              <span className="ww-claim-modal__sub">
                New links wait a moment so the sender can cancel a mistake.
              </span>
            </div>
            <PrimaryGradientButton title="Close" buttonStyle="dark" onClick={onClose} />
          </div>
        ) : link.flavor === "email" ? (
          <div className="ww-claim-modal__brand-actions">
            {onClaimToL1 && (
              <button
                type="button"
                className="zkm-btn-reset ww-claim-modal__alt"
                onClick={onClaimToL1}
              >
                Claim to an Ethereum wallet instead
              </button>
            )}
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-brand-claim-btn"
              disabled={busy || timingPending || !link.commitment}
              onClick={onClaim}
            >
              <img src={googleLogo} alt="" width={20} height={20} />
              {link.commitment && !timingPending ? "Claim with Google" : "Reading link…"}
            </button>
          </div>
        ) : (
          <>
            <div className="ww-claim-modal__actions">
              <PrimaryGradientButton title="Decline" buttonStyle="dark" onClick={onClose} />
              <PrimaryGradientButton
                title={busy ? busyLabel : timingPending ? "Checking…" : "Accept"}
                isDisabled={busy || timingPending}
                onClick={onClaim}
              />
            </div>
            {onClaimToL1 && (
              <button
                type="button"
                className="zkm-btn-reset ww-claim-modal__alt"
                onClick={onClaimToL1}
              >
                Claim to an Ethereum wallet instead
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

/**
 * The claim sheet (ULT-671 page 7): the beats that need the user present, with the don't-close
 * warning, until the claim is handed to the bell. No close control: leaving mid-beat is what the
 * warning is about. `onCancel` is offered only while the Google popup is up: nothing has moved yet,
 * so backing out is safe.
 */
export function ClaimProvingModal({
  beat,
  onCancel,
  onLeave,
}: {
  beat?: ClaimBeat
  onCancel?: () => void
  onLeave: () => void
}) {
  return (
    <Modal variant="create" label="Claiming payment">
      <OperationHandOff
        onLeave={onLeave}
        renderWorking={(passkey, child) => (
          <div className="ww-create-modal__body ww-claim-proving">
            <div className="ww-claim-proving__status">
              <GradientSpinner size={48} />
              <span className="ww-claim-proving__label">
                {passkey === "signing"
                  ? SIGNING_LABEL
                  : (beat ?? "building") === "building" && child
                    ? child
                    : BEAT_LABEL[beat ?? "building"]}
              </span>
            </div>
            {onCancel ? (
              <PrimaryGradientButton title="Cancel" buttonStyle="dark" onClick={onCancel} />
            ) : (
              <span className="ww-claim-proving__warning">
                {WORKING_WARNING[0]}
                <br />
                {WORKING_WARNING[1]}
              </span>
            )}
          </div>
        )}
      />
    </Modal>
  )
}
