import { useEffect } from "react"
import { useResource } from "@obsidion/front-core"
import { logout } from "../identity/logout"
import { isLogoutBlockedByRegistration } from "../registration/webRegistration"
import type { CutoverAccount } from "./parts"
import { session, useSession } from "../../session/session"

// The PXE to stop before a sign-out; the mount keeps it current.
let stopPxe: () => Promise<void> = () => Promise.resolve()

/** Keeps the pill's logout pointed at the booted PXE. Mounted once, inside the wallet gate. */
export function CutoverLogoutMount() {
  const obsidionWallet = useResource(useSession().wallet)
  useEffect(() => {
    stopPxe = () => obsidionWallet?.pxe.stop() ?? Promise.resolve()
    return () => {
      stopPxe = () => Promise.resolve()
    }
  }, [obsidionWallet])
  return null
}

/** The tag pill's account, with its menu's logout; none for an account without a tag. */
export function cutoverAccount(): CutoverAccount | undefined {
  const tag = session().identity.get().value?.handle
  return tag
    ? {
        tag,
        logout: {
          blocked: () => isLogoutBlockedByRegistration(session()),
          run: () => logout(session(), () => stopPxe()),
        },
      }
    : undefined
}
