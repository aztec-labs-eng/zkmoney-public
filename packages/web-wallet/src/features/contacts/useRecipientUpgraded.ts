import { useEffect, useState } from "react"
import { recipientUpgraded } from "./contactPay"

/** {@link recipientUpgraded} for a page: `undefined` while it reads, and `true` without a tag. */
export function useRecipientUpgraded(tag: string | undefined): boolean | undefined {
  const [answer, setAnswer] = useState<{ tag: string; upgraded: boolean }>()
  useEffect(() => {
    if (!tag) return
    let live = true
    void recipientUpgraded(tag).then((upgraded) => live && setAnswer({ tag, upgraded }))
    return () => {
      live = false
    }
  }, [tag])
  if (!tag) return true
  return answer?.tag === tag ? answer.upgraded : undefined
}
