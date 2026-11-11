import { logout, stopPageWallet } from "../identity/logout"
import { isLogoutBlockedByRegistration } from "../registration/webRegistration"
import type { CutoverAccount } from "./parts"
import { useSession } from "../../session/session"

/** The tag pill's account, with its menu's logout; none for an account without a tag. */
export function useCutoverAccount(): CutoverAccount | undefined {
  const session = useSession()
  const tag = session.identity.get().value?.handle
  return tag
    ? {
        tag,
        logout: {
          blocked: () => isLogoutBlockedByRegistration(session),
          run: () => logout(session.page, () => stopPageWallet(session.page)),
        },
      }
    : undefined
}
