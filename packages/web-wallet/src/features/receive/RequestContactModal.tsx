import { useAssetContext } from "@obsidion/front-core"
import {
  ConfirmationSheetDetailRow,
  GradientInitialAvatar,
  GradientText,
  PrimaryGradientButton,
  TextField,
} from "@obsidion/web-ds"
import { useState } from "react"
import { showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent } from "../../lib/analytics"
import { MessagingBanner } from "../../platform/xmtp/MessagingBanner"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { decimalInput, usdBalance } from "../../ui/format"
import { Modal } from "../../ui/Modal"
import { requestFromContact } from "../contacts/contactPay"
import { parseRequestAmount } from "./receiveView"

/**
 * Request-from-contact modal (ULT-671 flow 2): amount + note form, then a review card whose
 * "Confirm request" announces over XMTP. No proving, no balance gate — the requester isn't
 * spending, so the amount is never checked against their own balance.
 */
export function RequestContactModal({
  tag,
  onClose,
  onRequested,
}: {
  tag: string
  onClose: () => void
  /** Fired after the request is delivered — the caller decides where to land. */
  onRequested: () => void
}) {
  const { tokenService } = useAssetContext()

  const [step, setStep] = useState<"form" | "review">("form")
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  const parsedAmount = parseRequestAmount(amount)
  const amountError =
    amount.trim() && parsedAmount === null ? "Enter an amount above $0." : undefined

  const submit = async () => {
    if (!tokenService || parsedAmount === null || busy) return
    setBusy(true)
    try {
      const requesterTag = loadWalletIdentity()?.handle
      if (!requesterTag) throw new Error("Wallet identity unavailable")
      await requestFromContact(
        { tokenService },
        { tag, requesterTag, amountDisplay: String(parsedAmount), note: note.trim() || undefined },
      )
      onRequested()
    } catch (cause) {
      fireEvent("action_failed", { action: "contact:request", code: failureCode(cause) })
      showReportableError(cause, "contact:request")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal variant="create" label="Request" onClose={busy ? undefined : onClose}>
      <div className="ww-create-modal__body">
        <div className="ww-create-modal__head">
          <GradientInitialAvatar name={tag} size={64} />
          <div className="ww-share-modal__title">
            <GradientText size={24} weight={700}>
              Request
            </GradientText>
            <span className="ww-request-contact__handle">@{tag}.zk.money</span>
          </div>
        </div>

        {/* Requests hard-fail without a live XMTP leader; surface the state before submit. */}
        <MessagingBanner />

        {step === "form" ? (
          <>
            <TextField
              label="Amount"
              placeholder="$0"
              inputMode="decimal"
              autoFocus
              value={amount}
              onChange={(v) => setAmount(decimalInput(v))}
              error={amountError}
              onSubmit={() => parsedAmount !== null && setStep("review")}
            />
            <TextField
              label="Add note (optional)"
              placeholder="e.g. dinner"
              value={note}
              onChange={setNote}
            />
            <PrimaryGradientButton
              title="Request funds"
              isDisabled={parsedAmount === null}
              onClick={() => setStep("review")}
            />
          </>
        ) : (
          <>
            <div className="ww-review-card">
              <ConfirmationSheetDetailRow label="Type" value="Receive" />
              <ConfirmationSheetDetailRow
                label="Amount"
                value={usdBalance(String(parsedAmount ?? 0))}
              />
              {note.trim() && <ConfirmationSheetDetailRow label="Note" value={note.trim()} />}
            </div>
            <PrimaryGradientButton
              title={
                busy ? "Delivering your request" : tokenService ? "Confirm request" : "Connecting…"
              }
              isLoading={busy}
              isDisabled={!tokenService || busy}
              onClick={() => void submit()}
            />
          </>
        )}
      </div>
    </Modal>
  )
}
