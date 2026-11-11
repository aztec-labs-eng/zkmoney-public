import { ChecklistRow, SheetCard, SheetShell } from "@obsidion/web-ds"
import { backupPasskeySettingsEnabled } from "../../../../config/features"
import { fmt } from "../../../../lib/fmt"
import { BackupStandIn } from "../../BackupPasskeyPanel"
import { keyName, type BackupScreenProps } from "../../backupScreen"
import copy from "./FirstPasskeyScreen.copy"

/**
 * B4, signed in with the backup: entered from A1's button, or raised over the step only the first
 * passkey can sign. Names the key signed in and the one to sign in with. A one-key account does not
 * list the session's key, so that row may have no name. With the flag off, a saved attempt keeps
 * today's line.
 */
export function FirstPasskeyScreen({ screen, actions }: BackupScreenProps<"firstPasskey">) {
  if (!backupPasskeySettingsEnabled) return <BackupStandIn screen={screen} actions={actions} />
  const { keys } = screen
  const signingName = keyName(keys.find((key) => key.signsHere))
  const neededName = keyName(
    keys.find((key) => key.role === "sign-up" && !key.signsHere) ??
      keys.find((key) => !key.signsHere),
  )
  return (
    <SheetShell
      hero="warning"
      title={copy.title}
      lead={copy.lead}
      primary={{
        label: copy.signOut,
        onClick: () => actions.act?.("signOut"),
        testId: "backup-first-passkey-sign-out",
      }}
      secondary={{
        label: copy.close,
        onClick: () => (screen.under ? actions.dismiss() : actions.start()),
      }}
    >
      <SheetCard>
        <ChecklistRow
          done
          label={copy.backup}
          detail={signingName ? fmt(copy.signedIn.at, { where: signingName }) : copy.signedIn.plain}
        />
        <ChecklistRow
          done={false}
          label={copy.signUp}
          detail={neededName ? fmt(copy.needed.at, { where: neededName }) : copy.needed.plain}
        />
      </SheetCard>
    </SheetShell>
  )
}
