import { InfoBox, SheetShell } from "@obsidion/web-ds"
import { fmt } from "../../../../lib/fmt"
import { MoveSteps, type MoveStepRow } from "../../../../ui/MoveSteps/MoveSteps"
import stepsCopy from "../../../../ui/MoveSteps/MoveSteps.copy"
import { relandingCopy } from "../../backupPasskeyCopy"
import type { BackupMoveRow, BackupProgress, BackupScreenProps } from "../../backupScreen"
import trackerCopy from "../AddTracker/AddTracker.copy"
import {
  AddTracker,
  approveLabel,
  approverOf,
  closeAction,
  failedLine,
  retryAction,
  type StepLine,
} from "../AddTracker/AddTracker"
import { DelayedSheet } from "../DelayedSheet/DelayedSheet"
import copy from "./FinishScreen.copy"

type Finish = BackupScreenProps<"finish">["screen"]

/**
 * The prompts step 4 still asks for. Paylinks are taken back before the move, whose parts are
 * counted only once it is planned.
 */
function promptsLeft({ refunds, moved, out = 0 }: BackupProgress): number | "several" {
  if (refunds) return "several"
  return moved ? moved.total - moved.included - out : 1
}

const promptsLine = (left: number | "several") =>
  left === "several" ? copy.several : left > 1 ? fmt(copy.count, { count: left }) : copy.one

const keepOpenLead = (left: number | "several") =>
  left === "several"
    ? copy.working.keepOpen.several
    : left > 1
    ? fmt(copy.working.keepOpen.count, { count: left })
    : copy.working.keepOpen.one

const rowLabel = (row: BackupMoveRow) =>
  row.kind !== "links"
    ? copy.rows[row.kind]
    : row.count === 1
    ? copy.rows.link
    : fmt(copy.rows.links, { count: row.count })

/** What holds the move: the attempt's failure first, as on the add's tracker, else a pause. */
const warningOf = ({ failure, paused }: Finish) =>
  failure ? failedLine(failure).detail : paused ? copy.paused.detail : undefined

/** The line of a row the move works on, or waits for the user on. */
function rowLine(screen: Finish, row: BackupMoveRow) {
  if (row.kind === "links" && screen.linkExpiring) return copy.working.linkExpiring
  if (row.state === "confirming") return stepsCopy.confirming
  if (row.state === "sending" || screen.busy || screen.approving) return stepsCopy.preparing
  return screen.ask === "approve" ? approveLabel(screen) : copy.working.detail
}

/** Step 4 as the move's rows; while something holds the move, no row works. */
function moveRows(screen: Finish, rows: readonly BackupMoveRow[], held: boolean): MoveStepRow[] {
  return rows.map((row) => {
    const label = rowLabel(row)
    if (row.state === "done" || row.state === "todo") return { label, state: row.state }
    if (held)
      return {
        label,
        state: "todo",
        ...(row.state === "confirming" && { detail: stepsCopy.confirming }),
      }
    return { label, state: "current", detail: rowLine(screen, row) }
  })
}

/** Step 4's list: the move's rows once they are read, else the add's four steps with `line`. */
function FinishSteps({
  screen,
  line,
  prompt,
}: {
  screen: Finish
  line?: StepLine
  prompt?: StepLine
}) {
  const { rows, relanding } = screen.progress
  if (!rows)
    return <AddTracker screen={screen} {...(line && { line })} {...(prompt && { prompt })} />
  const left = promptsLeft(screen.progress)
  const warning = warningOf(screen)
  return (
    <>
      <MoveSteps
        caption={copy.step}
        header={left === "several" || left > 0 ? promptsLine(left) : ""}
        rows={moveRows(screen, rows, warning !== undefined)}
        {...(warning && { warning })}
      />
      {relanding && <InfoBox title={relandingCopy.title}>{relandingCopy.line}</InfoBox>}
    </>
  )
}

/**
 * A6: the last approvals, one per open paylink taken back and per part of the balance moved. C7 is
 * a closed prompt, shown on the step.
 */
export function FinishScreen({ screen, actions }: BackupScreenProps<"finish">) {
  const approver = approverOf(screen)
  const { ask, failure } = screen
  const loading = screen.busy || screen.approving
  if (screen.delay && !ask) return <DelayedSheet screen={screen} actions={actions} />
  // A declined prompt's line is its failure, which the tracker shows.
  if (screen.declined || screen.paused)
    return (
      <SheetShell
        hero="warning"
        title={copy.title}
        lead={screen.declined ? copy.closed : copy.paused.lead}
        primary={{
          label: screen.declined ? approveLabel(screen) : trackerCopy.tryAgain,
          onClick: actions.retryMove,
          loading: loading || screen.checking,
          testId: "backup-move-retry",
        }}
      >
        <FinishSteps
          screen={screen}
          {...(screen.paused && {
            prompt: { detail: copy.paused.detail, tone: "warning", failed: true },
          })}
        />
      </SheetShell>
    )
  const left = promptsLeft(screen.progress)
  if (ask === "approve" || screen.approving) {
    const more = left === "several" || left > 1
    return (
      <SheetShell
        hero={failure ? "warning" : "key"}
        title={copy.title}
        lead={fmt(more ? copy.leadMore : copy.lead, { approver })}
        primary={{
          label: approveLabel(screen),
          onClick: actions.approveMove,
          loading,
          testId: "backup-move-approve",
        }}
      >
        <FinishSteps screen={screen} prompt={{ detail: promptsLine(left) }} />
      </SheetShell>
    )
  }
  if (failure)
    return (
      <SheetShell
        hero="warning"
        title={copy.title}
        lead={copy.working.lead}
        primary={retryAction(screen, actions)}
      >
        <AddTracker screen={screen} />
      </SheetShell>
    )
  // While an approval is still to come the sheet asks to stay open, and offers no Close. A paylink
  // waiting to expire can take long, so that wait keeps Close.
  const asksMore = !screen.linkExpiring && (left === "several" || left > 0)
  return (
    <SheetShell
      hero="key"
      title={copy.working.title}
      lead={asksMore ? keepOpenLead(left) : copy.working.lead}
      primary={asksMore ? undefined : closeAction(actions, "plain")}
    >
      <FinishSteps
        screen={screen}
        line={{
          detail: screen.linkExpiring ? copy.working.linkExpiring : copy.working.detail,
        }}
      />
    </SheetShell>
  )
}
