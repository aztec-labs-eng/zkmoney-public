import { Modal } from "../../ui/Modal"
import type { PaymentRequest } from "@obsidion/front-core"
import {
  ConfirmationSheetDetailRow,
  Icon,
  PrimaryGradientButton,
  StatusBadge,
} from "@obsidion/web-ds"
import { whenLabel } from "../../ui/detailRows"
import { requestAmountLabel } from "../../ui/format"
import { PayModalChrome } from "../../ui/PayModalChrome"

/**
 * "You owe" sheet for a pending incoming request: Decline or go pay it. A request from outside the
 * contact book carries a warning, and paying it saves the requester.
 */
export function IncomingRequestDetailModal({
  request,
  fromNonContact = false,
  onClose,
  onDecline,
  onSend,
}: {
  request: PaymentRequest
  fromNonContact?: boolean
  onClose: () => void
  onDecline: () => void
  onSend: () => void
}) {
  const amount = requestAmountLabel(request.amount)
  const handle = `${request.contactTag}.zk.money`
  return (
    <Modal variant="bare" label="Payment request" className="ww-txd ww-txd--request" onClose={onClose}>
      <PayModalChrome
        name={request.contactTag}
        title={amount}
        subtitle={
          <>
            <span className="ww-txd__owe">You owe</span>
            {whenLabel(request.createdAt)}
          </>
        }
        onClose={onClose}
      />
      {fromNonContact && (
        <div className="ww-withdraw__warning" data-tone="warning" role="note">
          <span className="ww-withdraw__warning-head">
            <Icon name="shield-exclamation" size={16} />
            {handle} is not in your contacts
          </span>
          <div className="ww-withdraw__warning-body">
            <p>
              Only send if you know who this is. After accepting, zk.money cannot reverse a payment.
            </p>
          </div>
        </div>
      )}
      <div className="ww-txd__card">
        {fromNonContact && <ConfirmationSheetDetailRow label="From" value={handle} />}
        <ConfirmationSheetDetailRow
          label="Status"
          value={<StatusBadge label="Unpaid" badgeStyle="awaitingClaim" />}
        />
        {!fromNonContact && <ConfirmationSheetDetailRow label="To" value={handle} />}
        {request.note && <ConfirmationSheetDetailRow label="Note" value={request.note} />}
        <ConfirmationSheetDetailRow label="Fee" value="Free" />
        {!fromNonContact && (
          <>
            <hr className="ww-divider" />
            <ConfirmationSheetDetailRow label="Amount" value={amount} />
          </>
        )}
      </div>
      <div className="ww-txd__actions">
        <PrimaryGradientButton title="Decline" buttonStyle="dark" onClick={onDecline} />
        <PrimaryGradientButton title="Send" onClick={onSend} />
      </div>
      {fromNonContact && (
        <p className="ww-txd__footnote">By accepting, you add {handle} to your contacts</p>
      )}
    </Modal>
  )
}
