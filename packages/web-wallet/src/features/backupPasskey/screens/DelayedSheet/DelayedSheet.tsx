import { FactBox, SheetShell } from "@obsidion/web-ds"
import type { BackupActions, BackupDelay, Tracked } from "../../backupScreen"
import { AddTracker, closeAction, delayedLine } from "../AddTracker/AddTracker"
import copy from "./DelayedSheet.copy"

/** C6: a paid add held past its time, by the route, or on the sponsor's uses. */
export function DelayedSheet({
  screen,
  actions,
}: {
  screen: Tracked & { delay?: BackupDelay }
  actions: BackupActions
}) {
  return (
    <SheetShell
      hero="warning"
      title={copy.title}
      lead={screen.delay === "uses" ? copy.leadUses : copy.lead}
      primary={{
        label: copy.checkAgain,
        onClick: actions.check,
        loading: screen.checking,
        testId: "backup-check-again",
      }}
      secondary={closeAction(actions)}
    >
      <AddTracker screen={screen} line={delayedLine(screen)} />
      <FactBox facts={[{ label: copy.cancel, value: copy.cancelValue }]} />
    </SheetShell>
  )
}
