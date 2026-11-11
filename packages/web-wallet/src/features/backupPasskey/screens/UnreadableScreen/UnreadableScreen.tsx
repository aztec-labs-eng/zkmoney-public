import { InfoBox, SheetShell } from "@obsidion/web-ds"
import { backupPasskeySettingsEnabled } from "../../../../config/features"
import { panelCopy } from "../../backupPasskeyCopy"
import { BackupStandIn } from "../../BackupPasskeyPanel"
import type { BackupRead, BackupScreenProps } from "../../backupScreen"
import copy from "./UnreadableScreen.copy"

const RETRY_IDS: Record<BackupRead, string> = {
  keys: "backup-keys-retry",
  records: "backup-store-retry",
  deps: "backup-deps-retry",
  entry: "backup-entry-retry",
}

/**
 * B3, a read that failed: what did not load, that nothing changed, and a retry. Only the add's own
 * read has a screen to close back to. With the flag off, a key or record read keeps today's line.
 */
export function UnreadableScreen({ screen, actions }: BackupScreenProps<"unreadable">) {
  if (!backupPasskeySettingsEnabled) return <BackupStandIn screen={screen} actions={actions} />
  const { read } = screen
  const device = read === "records"
  return (
    <SheetShell
      hero="error"
      title={copy.title[read]}
      lead={device ? copy.lead.device : copy.lead.online}
      primary={{
        label: device ? copy.reload : copy.tryAgain,
        onClick: () => actions.retryRead(read),
        testId: RETRY_IDS[read],
      }}
      {...(read === "entry" && {
        secondary: { label: copy.close, onClick: () => actions.start() },
      })}
    >
      {screen.cancelled && <InfoBox title={copy.cancelled}>{panelCopy.leftoverPasskey}</InfoBox>}
    </SheetShell>
  )
}
