import { useEffect, useState } from "react"
import { accountServiceFor } from "../registration/registrationDeps"
import { useSession, type Session } from "../../session/session"

/** The invite host beside this wallet's: `wallet.<zone>` invites at `invite.<zone>`. Anywhere
 * else (a preview, a dev server) names production's. */
export const inviteLink = (code: string) => {
  const zone = /^wallet\.(.+)$/.exec(location.hostname)?.[1] ?? "zk.money"
  return `invite.${zone}/${code}`
}

export interface Invite {
  code?: string
  credited: boolean
}

export async function loadInvite(session: Pick<Session, "auth" | "page">): Promise<Invite> {
  const secretKey = await session.auth.getSecretKey()
  if (!secretKey) return { credited: false }
  const client = accountServiceFor(session.page.config, { secretKey })
  const [code, status] = await Promise.all([client.inviteCode(), client.inviteStatus()])
  return { code, credited: status.credited > 0 }
}

/** `enabled`: off where no account exists yet, so nothing is read. */
export function useInvite(enabled = true): Invite {
  const [invite, setInvite] = useState<Invite>({ credited: false })
  const session = useSession()
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const load = () =>
      loadInvite(session).then(
        (next) => alive && setInvite(next),
        (e) => console.warn("invite lookup failed", e),
      )
    void load()
    // A friend's deposit lands while this tab is away; the credit shows on return.
    const shown = () => {
      if (document.visibilityState !== "hidden") void load()
    }
    document.addEventListener("visibilitychange", shown)
    return () => {
      alive = false
      document.removeEventListener("visibilitychange", shown)
    }
  }, [enabled, session])
  return invite
}
