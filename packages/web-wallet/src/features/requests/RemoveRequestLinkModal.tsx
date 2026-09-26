import { useState } from "react"
import { PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent } from "../../lib/analytics"
import { Modal } from "../../ui/Modal"
import { cancelRequestById } from "../contacts/requestActions"

/**
 * Take an unpaid request link off the list. Nothing on chain is revoked: a minted link stays
 * payable until it expires, and a payment to it still lands as a deposit. Only the local row goes.
 */
export function RemoveRequestLinkModal({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  // The row settled or left the list while this sat open, so there is nothing to remove.
  const [gone, setGone] = useState(false)

  const remove = async () => {
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
    <Modal variant="bare" label="Remove request link" onClose={onClose}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}
      >
        <span className="zkm-type-title-sm" style={{ color: "var(--text-primary)" }}>
          Remove this request?
        </span>
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {gone ? (
          <>
            <p style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
              This request is no longer on your list. It was paid, or already removed.
            </p>
            <PrimaryGradientButton title="Close" buttonStyle="dark" onClick={onClose} />
          </>
        ) : (
          <>
            <p style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
              It leaves your list. The link itself stays payable until it expires, and anything paid to
              it still reaches you.
            </p>
            <PrimaryGradientButton
              title={busy ? "Removing…" : "Remove"}
              buttonStyle="danger"
              isLoading={busy}
              onClick={() => void remove()}
            />
            <PrimaryGradientButton title="Keep" buttonStyle="dark" isDisabled={busy} onClick={onClose} />
          </>
        )}
      </div>
    </Modal>
  )
}
