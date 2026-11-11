import { SheetShell } from "@obsidion/web-ds"
import { fmt } from "../../../../lib/fmt"
import type { BackupScreenProps } from "../../backupScreen"
import {
  AddTracker,
  closeAction,
  minutes,
  retryAction,
  type StepLine,
} from "../AddTracker/AddTracker"
import { DelayedSheet } from "../DelayedSheet/DelayedSheet"
import copy from "./AddingScreen.copy"

/** A5: the add waits on the network after paying, safe to close. C6 once it is delayed. */
export function AddingScreen({ screen, actions }: BackupScreenProps<"adding">) {
  if (screen.delay) return <DelayedSheet screen={screen} actions={actions} />
  const { timing, failure } = screen
  const line: StepLine | undefined = timing
    ? {
        detail:
          timing.leftMs > 0 ? fmt(copy.left, { minutes: minutes(timing.leftMs) }) : copy.almost,
      }
    : screen.progress.stage === "landing"
    ? { detail: copy.landing }
    : undefined
  return (
    <SheetShell
      hero={failure ? "warning" : "key"}
      title={copy.title}
      lead={timing ? fmt(copy.lead, { minutes: minutes(timing.takesMs) }) : copy.leadUntimed}
      primary={failure ? retryAction(screen, actions) : closeAction(actions, "plain")}
      secondary={failure ? closeAction(actions) : undefined}
    >
      <AddTracker screen={screen} line={line} />
    </SheetShell>
  )
}
