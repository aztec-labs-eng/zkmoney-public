import { SheetShell } from "@obsidion/web-ds"
import type { BackupScreenProps } from "../../backupScreen"
import { panelCopy } from "../../backupPasskeyCopy"
import { BackupStandIn } from "../../BackupPasskeyPanel"

/**
 * Funding that has to go back: today's recovery card in the sheet frame. Its mark stays a warning
 * once the funds are back, since the backup was still not added.
 */
export function RecoveryScreen({ screen, actions }: BackupScreenProps<"recovery">) {
  return (
    <SheetShell hero="warning" title={panelCopy.title}>
      <BackupStandIn screen={screen} actions={actions} />
    </SheetShell>
  )
}
