import { useEffect, useState } from "react"
import { getConfig } from "../../config/env"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { accountServiceFor } from "../onboarding/oxideOnboarding"

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

async function loadInvite(): Promise<Invite> {
  const secretKey = await getAuthService().getSecretKey()
  if (!secretKey) return { credited: false }
  const client = accountServiceFor(getConfig(), { secretKey })
  const [code, status] = await Promise.all([client.inviteCode(), client.inviteStatus()])
  return { code, credited: status.credited > 0 }
}

/** `enabled`: off where no account exists yet, so nothing is read. */
export function useInvite(enabled = true): Invite {
  const [invite, setInvite] = useState<Invite>({ credited: false })
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const load = () =>
      loadInvite().then(
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
  }, [enabled])
  return invite
}
