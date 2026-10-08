import { amountError, decimalInput } from "../../ui/format"
import { PrimaryGradientButton, TextField } from "@obsidion/web-ds"
import { TRANSFER_MEMO_MAX_BYTES, truncateUtf8 } from "@obsidion/sdk"

export function PayAmountForm({
  amount,
  note,
  isSend,
  walletBalance,
  maxAmount,
  overspent,
  validAmount,
  onAmount,
  onNote,
  onContinue,
}: {
  amount: string
  note: string
  isSend: boolean
  /** Two-decimal display balance. */
  walletBalance: string
  /** Balance floored to cents, for MAX. */
  maxAmount?: string
  overspent: boolean
  validAmount: boolean
  onAmount: (value: string) => void
  onNote: (value: string) => void
  onContinue: () => void
}) {
  const go = () => validAmount && !overspent && onContinue()
  return (
    <div className="ww-pay__form">
      <div className="ww-pay__field">
        <span className="ww-pay__available">
          Available: <b>${walletBalance}</b>
        </span>
        <TextField
          label="Amount"
          placeholder="$0.00"
          inputMode="decimal"
          autoFocus
          className="ww-autofocus"
          value={amount}
          onChange={(v) => onAmount(decimalInput(v))}
          onSubmit={go}
          error={overspent ? "Balance not enough" : amountError(amount)}
          trailing={
            isSend && (
              <button
                type="button"
                className="zkm-btn-reset ww-pay__max"
                onClick={() => maxAmount != null && onAmount(maxAmount)}
              >
                MAX
              </button>
            )
          }
        />
      </div>
      <TextField
        label="Add note (optional)"
        placeholder="e.g. dinner"
        value={note}
        onChange={(v) => onNote(truncateUtf8(v, TRANSFER_MEMO_MAX_BYTES))}
        onSubmit={go}
      />
      <PrimaryGradientButton
        title={isSend ? "Send funds" : "Request funds"}
        isDisabled={!validAmount || overspent}
        onClick={onContinue}
      />
    </div>
  )
}
