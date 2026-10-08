import { Modal } from "../../ui/Modal"
import type { PaymentRequest } from "@obsidion/front-core"
import { ConfirmationSheetDetailRow, PrimaryGradientButton, StatusBadge } from "@obsidion/web-ds"
import { whenLabel } from "../../ui/detailRows"
import { requestAmountLabel } from "../../ui/format"
import { PayModalChrome } from "../../ui/PayModalChrome"

/** "You owe" sheet for a pending incoming contact request: Decline or go pay it. */
export function IncomingRequestDetailModal({
  request,
  onClose,
  onDecline,
  onSend,
}: {
  request: PaymentRequest
  onClose: () => void
  onDecline: () => void
  onSend: () => void
}) {
  const amount = requestAmountLabel(request.amount)
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
      <div className="ww-txd__card">
        <ConfirmationSheetDetailRow
          label="Status"
          value={<StatusBadge label="Unpaid" badgeStyle="awaitingClaim" />}
        />
        <ConfirmationSheetDetailRow label="To" value={`${request.contactTag}.zk.money`} />
        {request.note && <ConfirmationSheetDetailRow label="Note" value={request.note} />}
        <ConfirmationSheetDetailRow label="Fee" value="Free" />
        <hr className="ww-divider" />
        <ConfirmationSheetDetailRow label="Amount" value={amount} />
      </div>
      <div className="ww-txd__actions">
        <PrimaryGradientButton title="Decline" buttonStyle="dark" onClick={onDecline} />
        <PrimaryGradientButton title="Send" onClick={onSend} />
      </div>
    </Modal>
  )
}
