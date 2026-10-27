/** Process manually: the user sends an old-version withdrawal's refund no relayer sent. */
import type { OldVersionRefund, OldVersionWithdrawal } from "@obsidion/front-core"
import { ConfirmationSheetDetailRow } from "@obsidion/web-ds"
import { getConfig, l1ChainFor } from "../../config/env"
import { showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent } from "../../lib/analytics"
import { shortL1Addr, usdAtomicFloor } from "../../ui/format"
import { ManualExitSheet } from "./ManualExitSheet"
import { selfRefundOldVersion } from "./oldVersionSelfRefund"

const EXPLAINER =
  "No relayer has sent this withdrawal from the old version. You can send it yourself instead of waiting for one to pick it up."

export function OldVersionRefundExitModal({
  record,
  refund,
  onClose,
}: {
  record: OldVersionWithdrawal
  refund: OldVersionRefund
  onClose: () => void
}) {
  const config = getConfig()
  const amount = usdAtomicFloor(BigInt(refund.usd))
  const recipient = shortL1Addr(record.to)
  return (
    <ManualExitSheet
      label="Withdrawal recovery"
      title="Withdrawal taking too long"
      doneTitle="Withdrawal released"
      explainer={EXPLAINER}
      facts={
        <>
          <ConfirmationSheetDetailRow label="Amount" value={amount} />
          <ConfirmationSheetDetailRow label="Recipient" value={recipient} />
          <ConfirmationSheetDetailRow label="Network" value={l1ChainFor(config.l1ChainId).name} />
        </>
      }
      buttonTitle="Process manually"
      run={(opts) => selfRefundOldVersion(record, refund, opts)}
      onError={(e) => {
        fireEvent("action_failed", {
          action: "withdraw:old-version-self-refund",
          code: failureCode(e),
        })
        showReportableError(e, "withdraw:old-version-self-refund", { title: "Withdrawal failed" })
      }}
      done={`${amount} released to ${recipient}.`}
      onClose={onClose}
    />
  )
}
