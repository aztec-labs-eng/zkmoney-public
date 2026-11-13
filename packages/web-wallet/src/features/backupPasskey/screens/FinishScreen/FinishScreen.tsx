import { InfoBox, SheetShell } from "@obsidion/web-ds"
import { fmt } from "../../../../lib/fmt"
import { MoveSteps, type MoveStepRow } from "../../../../ui/MoveSteps/MoveSteps"
import stepsCopy from "../../../../ui/MoveSteps/MoveSteps.copy"
import { relandingCopy } from "../../backupPasskeyCopy"
import {
  offersClose,
  promptsLeft,
  type BackupMoveRow,
  type BackupScreenProps,
} from "../../backupScreen"
import trackerCopy from "../AddTracker/AddTracker.copy"
import {
  AddTracker,
  closeAction,
  failedLine,
  retryAction,
  type StepLine,
} from "../AddTracker/AddTracker"
import { DelayedSheet } from "../DelayedSheet/DelayedSheet"
import copy from "./FinishScreen.copy"

type Finish = BackupScreenProps<"finish">["screen"]

/** The line of `lines` for the prompts left. */
const byLeft = (
  lines: { one: string; count: `${string}{count}${string}`; several: string },
  left: number | "several",
) => (left === "several" ? lines.several : left > 1 ? fmt(lines.count, { count: left }) : lines.one)

const rowLabel = (row: BackupMoveRow) =>
  row.kind !== "links"
    ? copy.rows[row.kind]
    : row.count === 1
    ? copy.rows.link
    : fmt(copy.rows.links, { count: row.count })

/** What holds the move: the attempt's failure first, as on the add's tracker, else a pause. */
const warningOf = ({ failure, paused }: Finish) =>
  failure ? failedLine(failure).detail : paused ? copy.paused.detail : undefined

/** The line of a row the move works on; none while it waits on the button, which says it. */
function rowLine(screen: Finish, row: BackupMoveRow): string | undefined {
  if (row.kind === "links" && screen.linkExpiring) return copy.working.linkExpiring
  if (row.state === "confirming") return stepsCopy.confirming
  if (row.state === "sending" || screen.busy || screen.approving) return stepsCopy.preparing
  return screen.ask === "approve" ? undefined : copy.working.detail
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
    const line = rowLine(screen, row)
    return { label, state: "current", ...(line && { detail: line }) }
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
  const warning = warningOf(screen)
  return (
    <>
      <MoveSteps
        caption={copy.step}
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
  const { ask, failure } = screen
  const loading = screen.busy || screen.approving
  if (screen.delay && !ask) return <DelayedSheet screen={screen} actions={actions} />
  // A declined prompt's line is its failure, which the tracker shows.
  if (screen.declined || screen.paused)
    return (
      <SheetShell
        hero="warning"
        title={screen.declined ? copy.finishTitle : copy.title}
        lead={screen.declined ? copy.closed : copy.paused.lead}
        primary={{
          label: screen.declined ? copy.finish : trackerCopy.tryAgain,
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
    return (
      <SheetShell
        hero={failure ? "warning" : "key"}
        title={copy.finishTitle}
        lead={byLeft(copy.lead, left)}
        primary={{
          label: copy.finish,
          onClick: actions.approveMove,
          loading,
          testId: "backup-move-approve",
        }}
      >
        <FinishSteps screen={screen} />
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
  // While an approval is still to come the sheet asks to stay open, and offers no Close.
  const closes = offersClose(screen)
  return (
    <SheetShell
      hero="key"
      title={copy.working.title}
      lead={closes ? copy.working.lead : byLeft(copy.working.keepOpen, left)}
      primary={closes ? closeAction(actions, "plain") : undefined}
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
