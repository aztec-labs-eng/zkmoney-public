import { ConfirmationSheetDetailRow, Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { usd } from "../../ui/format"
import { LocalPasskeyHint } from "../../ui/LocalPasskeyHint"
import { useBusyLabel } from "../operations/operations"
import { SponsoredActionNotice, useSponsoredActionBlock } from "../allowance/SponsoredActionNotice"

export function PayConfirmForm({
  title,
  amount,
  note,
  ready,
  busy,
  overspent,
  limitError,
  isSend,
  payee,
  onConfirm,
}: {
  title: string
  amount: number
  note: string
  ready: boolean
  /** Another tx flow is running; the wallet is single-flight. */
  busy: boolean
  overspent: boolean
  limitError?: string
  isSend: boolean
  /** Paying a request or a pay page: the amount leads, and the rows say who, what fee, how private. */
  payee?: { tag: string; savesContact: boolean }
  onConfirm: () => void
}) {
  const busyLabel = useBusyLabel()
  const unsponsored = useSponsoredActionBlock(isSend)
  const cta = payee ? `Pay ${usd(amount)}` : `Confirm & ${isSend ? "send" : "request"}`
  return (
    <div className="ww-pay__form">
      {payee ? (
        <>
          <div className="ww-pay__lead">
            <span className="ww-paylink-summary__amount">{usd(amount)}</span>
            {note.trim() && <span className="ww-paylink-summary__note">{note.trim()}</span>}
          </div>
          <div className="ww-pay__summary">
            <ConfirmationSheetDetailRow label="To" value={`@${payee.tag}`} />
            <ConfirmationSheetDetailRow
              label="Fee"
              value={<span className="ww-pay__free">Free</span>}
            />
            <ConfirmationSheetDetailRow label="Privacy" value="Private" />
          </div>
          {payee.savesContact && (
            <p className="ww-pay__notice">
              <Icon name="user-follow" size={16} color="currentColor" />@{payee.tag} will be added
              to your contacts.
            </p>
          )}
        </>
      ) : (
        <div className="ww-pay__summary">
          <ConfirmationSheetDetailRow label="Type" value={title} />
          <ConfirmationSheetDetailRow label="Amount" value={usd(amount)} />
          {note.trim() && <ConfirmationSheetDetailRow label="Note" value={note.trim()} />}
        </div>
      )}
      {/* Reachable when the balance lands after Continue — the CTA is dead without this. */}
      {overspent ? (
        <span className="ww-pay__error">Balance not enough</span>
      ) : (
        limitError && <span className="ww-pay__error">{limitError}</span>
      )}
      <SponsoredActionNotice reason={unsponsored} />
      {/* A request is not signed with the passkey. */}
      {isSend && <LocalPasskeyHint />}
      <PrimaryGradientButton
        title={busy ? busyLabel : ready ? cta : "Connecting…"}
        isDisabled={!ready || overspent || !!limitError || busy || !!unsponsored}
        onClick={onConfirm}
      />
    </div>
  )
}
