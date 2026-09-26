import { GradientSpinner } from "@obsidion/web-ds"

/** What the user waits on until the passkey ceremony ends and the flow hands off to the bell. */
export type PayWorkingBeat = "preparing" | "signing"

/** The warning every working beat shows, as its two lines. */
export const WORKING_WARNING = [
  "Don't close this screen,",
  "your transaction may be lost",
] as const

const LABEL: Record<PayWorkingBeat, string> = {
  preparing: "Preparing transaction…",
  signing: "Confirm with passkey…",
}

/**
 * `onCancel` is offered only while the caller can still honour it — each flow checks its cancel flag
 * once, at its first stage boundary — so a caller withholds it once that gate has passed. `label`
 * names what the preparing beat waits on when it is more than the transaction.
 */
export function PayWorking({
  beat,
  label,
  onCancel,
}: {
  beat: PayWorkingBeat
  label?: string
  onCancel?: () => void
}) {
  return (
    <div className="ww-pay__working">
      <GradientSpinner size={32} />
      <span className="ww-pay__stage">{beat === "preparing" && label ? label : LABEL[beat]}</span>
      {/* Past the first beat the passkey sheet's own dismiss is the way out. */}
      {onCancel && beat === "preparing" && (
        <button type="button" className="zkm-btn-reset ww-pay__cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
      <span className="ww-pay__warn">
        {WORKING_WARNING[0]}
        <br />
        {WORKING_WARNING[1]}
      </span>
    </div>
  )
}
