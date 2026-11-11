import { SheetShell } from "@obsidion/web-ds"
import { backupPasskeySettingsEnabled } from "../../../../config/features"
import { BackupStandIn } from "../../BackupPasskeyPanel"
import type { BackupScreenProps } from "../../backupScreen"
import copy from "./UnavailableScreen.copy"

/**
 * B2, no route on this network: entered from A1's button, or raised over the step a missing route
 * stopped. Close goes back to where it was entered from. With the flag off, a saved attempt keeps
 * today's line.
 */
export function UnavailableScreen({ screen, actions }: BackupScreenProps<"unavailable">) {
  if (!backupPasskeySettingsEnabled) return <BackupStandIn screen={screen} actions={actions} />
  return (
    <SheetShell
      hero="warning"
      title={copy.title}
      lead={copy.lead}
      primary={{
        label: copy.close,
        style: "plain",
        onClick: () => (screen.under ? actions.dismiss() : actions.start()),
        testId: "backup-unavailable-close",
      }}
    />
  )
}
