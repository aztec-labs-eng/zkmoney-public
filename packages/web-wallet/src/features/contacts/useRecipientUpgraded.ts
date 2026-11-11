import { useEffect, useState } from "react"
import { useSession } from "../../session/session"
import { recipientUpgraded } from "./contactPay"

/** {@link recipientUpgraded} for a page: `undefined` while it reads, and `true` without a tag. */
export function useRecipientUpgraded(tag: string | undefined): boolean | undefined {
  const session = useSession()
  const [answer, setAnswer] = useState<{ tag: string; upgraded: boolean }>()
  // eslint-disable-next-line local/effect-hook -- ZKM-1806
  useEffect(() => {
    if (!tag) return
    let live = true
    void recipientUpgraded(session, tag).then((upgraded) => live && setAnswer({ tag, upgraded }))
    return () => {
      live = false
    }
  }, [session, tag])
  if (!tag) return true
  return answer?.tag === tag ? answer.upgraded : undefined
}
