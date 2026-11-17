/** The analytics a session owes from its backup passkey attempts: each step they reach. */
import { task, type BackupFunnel, type BackupRotations, type Task } from "@obsidion/front-core"
import { reportBackupFunnel } from "../features/backupPasskey/backupFunnel"

/**
 * Reports each time the attempts change, once they are read. Each step is reported once, on durable
 * state, so a report again finds nothing new, and a step reached while the sheet was closed or the
 * tab away is reported on the next change.
 */
export function backupReports({
  rotations,
  funnel,
}: {
  rotations: Pick<BackupRotations, "view">
  funnel: BackupFunnel
}): Task {
  return task("backupReports", {
    needs: {},
    on: { view: rotations.view },
    every: "once",
    run: async ({ view: { records, loaded, failed } }) => {
      if (!loaded || failed) return
      await reportBackupFunnel(records, funnel)
    },
  })
}
