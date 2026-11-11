import { useSession } from "../../../session/session"
import { LogoutBlockedModal } from "../../../ui/LogoutBlockedModal"
import { LogoutModal } from "../../../ui/LogoutModal"
import { logout, stopPageWallet } from "../logout"

/** `blocked`: the warning while the tag is still registering. */
export type LogoutKind = "confirm" | "blocked"

/** Asks before signing out. The opener picks the kind as it opens. */
export function LogoutPrompt({ kind, onClose }: { kind: LogoutKind; onClose: () => void }) {
  const session = useSession()
  const confirm = () => void logout(session.page, () => stopPageWallet(session.page))
  return kind === "blocked" ? (
    <LogoutBlockedModal onClose={onClose} onConfirm={confirm} />
  ) : (
    <LogoutModal onClose={onClose} onConfirm={confirm} />
  )
}
