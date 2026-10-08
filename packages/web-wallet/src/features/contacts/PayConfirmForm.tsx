import { ConfirmationSheetDetailRow, PrimaryGradientButton } from "@obsidion/web-ds"
import { usd } from "../../ui/format"
import { useBusyLabel } from "../operations/operations"
import { SponsoredActionNotice, useSponsoredActionBlock } from "../allowance/SponsoredActionNotice"

export function PayConfirmForm({
  title,
  amount,
  note,
  ready,
  busy,
  overspent,
  isSend,
  onConfirm,
}: {
  title: string
  amount: number
  note: string
  ready: boolean
  /** Another tx flow is running; the wallet is single-flight. */
  busy: boolean
  overspent: boolean
  isSend: boolean
  onConfirm: () => void
}) {
  const busyLabel = useBusyLabel()
  const unsponsored = useSponsoredActionBlock(isSend)
  return (
    <div className="ww-pay__form">
      <div className="ww-pay__summary">
        <ConfirmationSheetDetailRow label="Type" value={title} />
        <ConfirmationSheetDetailRow label="Amount" value={usd(amount)} />
        {note.trim() && <ConfirmationSheetDetailRow label="Note" value={note.trim()} />}
      </div>
      {/* Reachable when the balance lands after Continue — the CTA is dead without this. */}
      {overspent && <span className="ww-pay__error">Balance not enough</span>}
      <SponsoredActionNotice reason={unsponsored} />
      <PrimaryGradientButton
        title={
          busy ? busyLabel : ready ? `Confirm & ${isSend ? "send" : "request"}` : "Connecting…"
        }
        isDisabled={!ready || overspent || busy || !!unsponsored}
        onClick={onConfirm}
      />
    </div>
  )
}
