import type { BackupScreenProps } from "../../backupScreen"
import { BackupStandIn } from "../../BackupPasskeyPanel"

/** A read the backup area waits on. */
export function LoadingScreen({ screen, actions }: BackupScreenProps<"loading">) {
  return <BackupStandIn screen={screen} actions={actions} />
}
