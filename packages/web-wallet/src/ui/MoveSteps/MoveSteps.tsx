import { StepTracker, type TrackerStep } from "@obsidion/web-ds"
import { fmt } from "../../lib/fmt"
import copy from "./MoveSteps.copy"
import styles from "./MoveSteps.module.css"

/** One row of a move: a balance, or another thing it takes care of first. */
export type MoveStepRow = Pick<TrackerStep, "label" | "state" | "detail">

/** How many approvals a move still asks for; empty when none are left or the number is unknown. */
export function approvalsLeft(left: number | undefined, upper = false): string {
  if (left === undefined || left <= 0) return ""
  if (upper) return fmt(copy.left.upTo, { count: left })
  return left === 1 ? copy.left.one : fmt(copy.left.count, { count: left })
}

/**
 * A move of funds as rows under a caption. `header` sits beside the caption, `warning` says what
 * holds the move while no row works, and `note` is the caller's line under the list.
 */
export function MoveSteps({
  caption,
  header = "",
  rows,
  warning,
  note,
}: {
  caption: string
  header?: string
  rows: readonly MoveStepRow[]
  warning?: string
  note?: string
}) {
  return (
    <div className={styles.steps}>
      <StepTracker label={caption} progress={header} steps={[...rows]} />
      {warning && (
        <p className={styles.warning} role="alert">
          {warning}
        </p>
      )}
      {note && <p className={`ww-sheet__note ${styles.note}`}>{note}</p>}
    </div>
  )
}
