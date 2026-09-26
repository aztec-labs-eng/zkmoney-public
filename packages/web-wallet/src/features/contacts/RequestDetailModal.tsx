import { useEffect, useState } from "react"
import { RequestStorage, type PaymentRequest } from "@obsidion/front-core"
import {
  ConfirmationSheetDetailRow,
  GradientInitialAvatar,
  GradientText,
  Icon,
} from "@obsidion/web-ds"
import cancelArt from "../../assets/contacts/cancel-request.png"
import { getConfig } from "../../config/env"
import { showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent } from "../../lib/analytics"
import { l2TxUrl } from "../../lib/explorer"
import { rowTimestamp, shortAddr, usdBalance } from "../../ui/format"
import { Modal } from "../../ui/Modal"
import { cancelRequestById } from "./requestActions"

const STATUS_VIEW: Record<
  PaymentRequest["status"],
  { label: string; icon: string; color: string }
> = {
  pending: { label: "Waiting", icon: "clock", color: "#eed04e" },
  fulfilled: { label: "Completed", icon: "check", color: "#2ecc71" },
  declined: { label: "Declined", icon: "x", color: "#fe708b" },
  cancelled: { label: "Cancelled", icon: "x", color: "#fe708b" },
}

/** The one confirm sheet every request-cancel path goes through. */
export function CancelRequestConfirmModal({
  busy,
  onConfirm,
  onClose,
}: {
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal variant="create" label="Cancel request?" onClose={onClose}>
      <div className="ww-create-modal__body">
        <div className="ww-cancel-confirm">
          <img src={cancelArt} alt="" width={139} height={140} />
          <span className="ww-cancel-confirm__title">Cancel request?</span>
          <span className="ww-cancel-confirm__sub">
            The user will no longer see this request if you cancel it
          </span>
        </div>
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-danger-btn"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Cancelling…" : "Cancel request"}
        </button>
      </div>
    </Modal>
  )
}

/** Post-cancel beat; the host closes it after a moment. */
export function RequestCancelledModal() {
  return (
    <Modal variant="create" label="Request cancelled">
      <div className="ww-create-modal__body">
        <div className="ww-cancel-confirm">
          <Icon name="x" size={28} color="#fe708b" />
          <span className="ww-cancel-confirm__title">Request cancelled</span>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Detail sheet for a payment request in the contact chat (ULT-671 page 5): the stored row's
 * fields plus, for an open outgoing request, a cancel chain (confirm → local flip → "Request
 * cancelled"). Cancelling only flips the local row — the peer's copy stays until an XMTP cancel
 * signal exists. `initialStep="confirm"` enters at the confirm sheet (the bubble's and the
 * activity rows' inline Cancel). `tag` falls back to the stored row's contact tag when the caller
 * doesn't know the counterparty (a feed row).
 */
export function RequestDetailModal({
  requestId,
  tag,
  initialStep = "detail",
  onClose,
}: {
  requestId: string
  tag?: string
  initialStep?: "detail" | "confirm"
  onClose: () => void
}) {
  const [row, setRow] = useState<PaymentRequest>()
  const [step, setStep] = useState<"detail" | "confirm" | "cancelled">(initialStep)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    RequestStorage.get()
      .findById(requestId)
      .then((r) => (r ? setRow(r) : onClose()))
      .catch(() => onClose())
    // Loads once per open — the modal owns the row for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId])

  useEffect(() => {
    if (step !== "cancelled") return
    const t = setTimeout(onClose, 1600)
    return () => clearTimeout(t)
  }, [step, onClose])

  const cancel = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (await cancelRequestById(requestId)) {
        setStep("cancelled")
        return
      }
      // Lost the race to a terminal status: show what the row became.
      const fresh = await RequestStorage.get().findById(requestId)
      if (fresh) setRow(fresh)
      else onClose()
      setStep("detail")
    } catch (cause) {
      fireEvent("action_failed", { action: "contact:request-cancel", code: failureCode(cause) })
      showReportableError(cause, "contact:request-cancel")
    } finally {
      setBusy(false)
    }
  }

  if (!row) return null

  if (step === "cancelled") return <RequestCancelledModal />

  if (step === "confirm") {
    return (
      <CancelRequestConfirmModal busy={busy} onConfirm={() => void cancel()} onClose={onClose} />
    )
  }

  const config = getConfig()
  const status = STATUS_VIEW[row.status]
  const txHash = row.fulfillmentTxHash
  const handle = tag ?? row.contactTag
  return (
    <Modal variant="create" label="Request" onClose={onClose}>
      <div className="ww-create-modal__body">
        <div className="ww-create-modal__head">
          <GradientInitialAvatar name={handle ?? "Request"} size={64} />
          <div className="ww-share-modal__title">
            <GradientText size={24} weight={700}>
              Request
            </GradientText>
            <span className="ww-request-contact__handle">
              {handle ? `${handle}.zk.money` : "Via paylink"}
            </span>
          </div>
        </div>

        <div className="ww-review-card">
          <ConfirmationSheetDetailRow label="Type" value="Receive" />
          <ConfirmationSheetDetailRow label="Amount" value={usdBalance(String(row.amount))} />
          {row.note && <ConfirmationSheetDetailRow label="Note" value={row.note} />}
          <ConfirmationSheetDetailRow label="Request date" value={rowTimestamp(row.createdAt)} />
          <ConfirmationSheetDetailRow
            label="Tx hash"
            value={
              txHash ? (
                <a
                  className="ww-request-detail__hash"
                  href={l2TxUrl(config.network, config.nodeUrl, txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddr(txHash)}
                  <Icon name="share-box" size={16} color="currentColor" />
                </a>
              ) : (
                <span className="ww-request-detail__hash">
                  --
                  <Icon name="share-box" size={16} color="currentColor" />
                </span>
              )
            }
          />
          <div className="ww-review-card__divider" />
          <ConfirmationSheetDetailRow
            label="Status"
            value={
              <span className="ww-request-detail__status" style={{ color: status.color }}>
                <Icon name={status.icon} size={16} color="currentColor" />
                {status.label}
              </span>
            }
          />
        </div>

        {row.direction === "outgoing" && row.status === "pending" && (
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-danger-btn"
            onClick={() => setStep("confirm")}
          >
            Cancel request
          </button>
        )}
      </div>
    </Modal>
  )
}
