import { amountError, decimalInput } from "../../ui/format"
import { PrimaryGradientButton, TextField } from "@obsidion/web-ds"
import { TRANSFER_MEMO_MAX_BYTES, truncateUtf8 } from "@obsidion/sdk"
import balanceCopy from "../../ui/balance.copy"

export function PayAmountForm({
  amount,
  note,
  isSend,
  walletBalance,
  maxAmount,
  overspent,
  balanceUnconfirmed,
  limitError,
  validAmount,
  onAmount,
  onNote,
  onContinue,
  submitLabel,
}: {
  amount: string
  note: string
  isSend: boolean
  /** Two-decimal display balance. */
  walletBalance: string
  /** Balance floored to cents, for MAX. */
  maxAmount?: string
  overspent: boolean
  balanceUnconfirmed: boolean
  limitError?: string
  validAmount: boolean
  onAmount: (value: string) => void
  onNote: (value: string) => void
  onContinue: () => void
  submitLabel?: string
}) {
  const checking = isSend && balanceUnconfirmed
  const blocked = !validAmount || overspent || !!limitError || checking
  const go = () => !blocked && onContinue()
  return (
    <div className="ww-pay__form">
      <div className="ww-pay__field">
        <span className="ww-pay__available">
          Available:{" "}
          <b className="ww-available" aria-busy={balanceUnconfirmed}>
            ${walletBalance}
          </b>
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
          error={overspent ? "Balance not enough" : limitError ?? amountError(amount)}
          trailing={
            isSend && (
              <button
                type="button"
                className="zkm-btn-reset ww-pay__max"
                disabled={checking}
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
        title={
          checking ? balanceCopy.checking : submitLabel ?? (isSend ? "Send funds" : "Request funds")
        }
        isDisabled={blocked}
        onClick={onContinue}
      />
    </div>
  )
}
