import { useState } from "react"
import { PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent } from "../../lib/analytics"
import { Modal } from "../../ui/Modal"
import { cancelRequestById } from "../contacts/requestActions"

/**
 * Cancel an unpaid request link. Nothing on chain is revoked: a minted link stays payable until it
 * expires, and a payment to it still lands as a deposit. Only the local row goes.
 */
export function CancelRequestLinkModal({
  requestId,
  onClose,
}: {
  requestId: string
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  // The row settled or left the list while this sat open, so there is nothing to cancel.
  const [gone, setGone] = useState(false)

  const cancel = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (await cancelRequestById(requestId)) {
        onClose()
        return
      }
      setGone(true)
    } catch (cause) {
      fireEvent("action_failed", { action: "request-link:remove", code: failureCode(cause) })
      showReportableError(cause, "request-link:remove")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal variant="bare" label="Cancel request link" onClose={onClose}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span className="zkm-type-title-sm" style={{ color: "var(--text-primary)" }}>
          Cancel request?
        </span>
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {gone ? (
          <>
            <p style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
              This request was already paid or cancelled.
            </p>
            <PrimaryGradientButton title="Close" buttonStyle="dark" onClick={onClose} />
          </>
        ) : (
          <>
            <p style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
              This will remove the request from your list and can't be undone.
            </p>
            <PrimaryGradientButton
              title={busy ? "Cancelling…" : "Cancel request"}
              buttonStyle="danger"
              isLoading={busy}
              onClick={() => void cancel()}
            />
            <PrimaryGradientButton
              title="Keep"
              buttonStyle="dark"
              isDisabled={busy}
              onClick={onClose}
            />
          </>
        )}
      </div>
    </Modal>
  )
}
