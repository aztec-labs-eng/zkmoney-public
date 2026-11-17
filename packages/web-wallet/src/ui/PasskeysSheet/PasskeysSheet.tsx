import { useState } from "react"
import { useNavigate } from "react-router-dom"
import type { SheetFrom } from "../../features/backupPasskey/backupFunnel"
import type { EntryAction } from "../../features/backupPasskey/backupPasskeyEntry"
import { LogoutPrompt, type LogoutKind } from "../../features/identity/LogoutPrompt/LogoutPrompt"
import { openMigrationDialog } from "../../features/migration/migrationDialog"
import { isLogoutBlockedByRegistration } from "../../features/registration/webRegistration"
import { useSession } from "../../session/session"
import { PasskeysModal } from "../PasskeysModal"

/**
 * The Passkeys sheet with the links a blocked add offers, each opening what clears the block, after
 * `onLeave` (by default `onClose`). Signing out opens the logout prompt over the sheet, so backing
 * out of it finds the sheet as it was.
 */
export function PasskeysSheet({
  from,
  onClose,
  onLeave = onClose,
}: {
  /** What opened it, which the backup's first screen is reported with. */
  from: SheetFrom
  onClose: () => void
  /** Closes the sheet for good when a link leaves it, where `onClose` goes back a step. */
  onLeave?: () => void
}) {
  const navigate = useNavigate()
  const session = useSession()
  const [logout, setLogout] = useState<LogoutKind>()
  const act = (action: EntryAction) => {
    switch (action) {
      case "signOut":
        return setLogout(isLogoutBlockedByRegistration(session) ? "blocked" : "confirm")
      case "migration":
        onLeave()
        return openMigrationDialog()
      case "activity":
      case "deposit":
      case "savings":
        onLeave()
        return void navigate(`/${action}`)
    }
  }
  return (
    <>
      <PasskeysModal from={from} onClose={onClose} onAction={act} />
      {logout && <LogoutPrompt kind={logout} onClose={() => setLogout(undefined)} />}
    </>
  )
}
