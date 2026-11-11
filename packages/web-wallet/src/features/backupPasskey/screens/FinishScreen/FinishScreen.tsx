import { SheetShell } from "@obsidion/web-ds"
import { fmt } from "../../../../lib/fmt"
import type { BackupProgress, BackupScreenProps } from "../../backupScreen"
import trackerCopy from "../AddTracker/AddTracker.copy"
import {
  AddTracker,
  approveLabel,
  approverOf,
  closeAction,
  retryAction,
} from "../AddTracker/AddTracker"
import { DelayedSheet } from "../DelayedSheet/DelayedSheet"
import copy from "./FinishScreen.copy"

/**
 * The prompts step 4 still asks for. Paylinks are taken back before the move, whose parts are
 * counted only once it is planned.
 */
function promptsLeft({ refunds, moved }: BackupProgress): number | "several" {
  if (refunds) return "several"
  return moved ? moved.total - moved.included : 1
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
        <AddTracker
          screen={screen}
          {...(screen.paused && {
            line: { detail: copy.paused.detail, tone: "warning", failed: true },
          })}
        />
      </SheetShell>
    )
  if (ask === "approve" || screen.approving) {
    const left = promptsLeft(screen.progress)
    const more = left === "several" || left > 1
    const prompts =
      left === "several" ? copy.several : more ? fmt(copy.count, { count: left }) : copy.one
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
        <AddTracker screen={screen} line={{ detail: prompts }} />
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
  return (
    <SheetShell
      hero="key"
      title={copy.working.title}
      lead={copy.working.lead}
      primary={closeAction(actions, "plain")}
    >
      <AddTracker
        screen={screen}
        line={{
          detail: screen.linkExpiring ? copy.working.linkExpiring : copy.working.detail,
        }}
      />
    </SheetShell>
  )
}
