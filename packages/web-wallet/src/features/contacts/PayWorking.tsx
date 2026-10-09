import type { ReactNode } from "react"
import { GradientSpinner } from "@obsidion/web-ds"

/**
 * What the user waits on until the passkey ceremony ends and the flow hands off to the bell; a flow
 * that holds the page until its transaction is sent also waits on the proof.
 */
export type PayWorkingBeat = "preparing" | "signing" | "proving"

/** The warning every working beat shows, as its two lines. Nothing is sent while it shows. */
export const WORKING_WARNING = [
  "Keep this tab open until it's sent.",
  "Closing it stops the transaction. Your funds stay where they are.",
] as const

const LABEL: Record<PayWorkingBeat, string> = {
  preparing: "Preparing transaction…",
  signing: "Confirm with passkey…",
  proving: "Proving privately…",
}

/**
 * `onCancel` is offered only while the caller can still honor it — each flow checks its cancel flag
 * once, at its first stage boundary — so a caller withholds it once that gate has passed. `label`
 * names what the preparing beat waits on when it is more than the transaction. `warn` is off for a
 * beat with no transaction to lose. `hint` is advice for the passkey prompt, under the stage.
 */
export function PayWorking({
  beat,
  label,
  onCancel,
  warn = true,
  hint,
}: {
  beat: PayWorkingBeat
  label?: string
  onCancel?: () => void
  warn?: boolean
  hint?: ReactNode
}) {
  return (
    <div className="ww-pay__working">
      <GradientSpinner size={32} />
      <span className="ww-pay__stage">{beat === "preparing" && label ? label : LABEL[beat]}</span>
      {hint}
      {/* Past the first beat the passkey sheet's own dismiss is the way out. */}
      {onCancel && beat === "preparing" && (
        <button type="button" className="zkm-btn-reset ww-pay__cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
      {warn && (
        <span className="ww-pay__warn">
          {WORKING_WARNING[0]}
          <br />
          {WORKING_WARNING[1]}
        </span>
      )}
    </div>
  )
}
