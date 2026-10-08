import { buildRequestShareUrl, type PaymentRequest } from "@obsidion/front-core"
import {
  ConfirmationSheetDetailRow,
  GradientText,
  Icon,
  PrimaryGradientButton,
  StatusBadge,
} from "@obsidion/web-ds"
import { requestAmountLabel, rowTimestamp } from "../../ui/format"
import { useLinkSharing } from "../../ui/hooks"
import { Modal } from "../../ui/Modal"
import { linkExpiryLabel, requestShareStatus, requestShareText } from "./shareView"
import { usePhoneLayout } from "../../ui/usePhoneLayout"

/**
 * Share step of the request-paylink flow (ULT-671), doubling as the detail sheet for a persisted
 * link row: share/copy the link while it's unpaid, and see who paid once it's fulfilled.
 *
 * The sheet offers no cancel. A minted request link is a bearer document whose SIPA is already
 * broadcast, so nothing local can revoke it — the feed row owns removing the row.
 */
export function SharePaylinkModal({
  request,
  requesterTag,
  payer,
  justCreated = false,
  onClose,
}: {
  request: PaymentRequest
  requesterTag: string
  payer?: { displayName: string }
  /** Opened straight from the create step: the sheet reads as a result, not a form. */
  justCreated?: boolean
  onClose: () => void
}) {
  const url = buildRequestShareUrl(request, requesterTag, location.origin) ?? undefined
  const { copied, copy, share } = useLinkSharing(url, "Payment request", requestShareText(request.amount))
  const phone = usePhoneLayout()
  const status = requestShareStatus(request, Date.now())
  const expiry = linkExpiryLabel(request.expiresAt, Date.now())
  const amountLabel = requestAmountLabel(request.amount)
  const heading = justCreated ? "Your request link is ready" : "Request link"
  const nextStep =
    request.amount > 0 ? `Share it with whoever owes you ${amountLabel}.` : "Share it with whoever owes you."

  return (
    <Modal variant="create" label="Request link" onClose={onClose}>
      <div className="ww-create-modal__body">
        <div className="ww-share-modal__head">
          <span className="ww-share-modal__badge">
            <Icon name={justCreated ? "check" : "link"} size={32} color="#fff" />
          </span>
          <span className="ww-share-modal__title">{heading}</span>
          <div className="ww-share-modal__hero">
            <GradientText size={50} weight={700}>
              {amountLabel}
            </GradientText>
            {status.active && <span className="ww-share-modal__caption">{nextStep}</span>}
            <div className="ww-share-modal__meta">
              <span className="ww-share-modal__date">{rowTimestamp(request.createdAt)}</span>
            </div>
          </div>
        </div>

        {status.active &&
          (url ? (
            <div className="ww-share-modal__buttons">
              <PrimaryGradientButton
                title={copied ? "Copied!" : "Copy link"}
                buttonStyle="dark"
                onClick={() => void copy()}
              />
              {phone && <PrimaryGradientButton title="Share" onClick={() => void share()} />}
            </div>
          ) : (
            <span className="zkm-type-body-sm" style={{ color: "var(--text-secondary)" }}>
              This older request cannot be shared again.
            </span>
          ))}

        <div className="ww-review-card">
          <ConfirmationSheetDetailRow
            label="Status"
            value={<StatusBadge label={status.label} badgeStyle={status.badgeStyle} />}
          />
          {request.note && <ConfirmationSheetDetailRow label="Note" value={request.note} />}
          {status.active && expiry && (
            <ConfirmationSheetDetailRow label="Link expiry" value={expiry} />
          )}
          {payer && request.status === "fulfilled" && (
            <ConfirmationSheetDetailRow label="Paid by" value={payer.displayName} />
          )}
        </div>
      </div>
    </Modal>
  )
}
