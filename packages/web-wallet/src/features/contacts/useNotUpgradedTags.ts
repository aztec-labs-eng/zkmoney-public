import { useEffect, useState } from "react"
import { accountContacts } from "../../session/contacts"
import { useSession } from "../../session/session"

/**
 * The tags among `tags` still on a retired rollup. A contact carried over from one keeps its old
 * address until its tag resolves here; then the book takes the new one.
 */
export function useNotUpgradedTags(tags: readonly string[]): ReadonlySet<string> {
  const session = useSession()
  const [stale, setStale] = useState<ReadonlySet<string>>(new Set())
  const key = [...new Set(tags.map((t) => t.toLowerCase()))].sort().join("\n")
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!key) return
    let live = true
    void Promise.all(
      key.split("\n").map(async (tag) => {
        // Each list visit reads again. A failed read gives undefined.
        const resolution = await session.page.chain
          .tagResolution(tag)
          .read()
          .catch(() => undefined)
        if (resolution?.status === "resolved") {
          await accountContacts(session)
            .updateL2Address(tag, resolution.l2Address)
            .catch(() => undefined)
        }
        return resolution?.status === "staleRollup" ? tag : undefined
      }),
    ).then((found) => live && setStale(new Set(found.filter((t) => t !== undefined))))
    return () => {
      live = false
    }
  }, [key, session])
  return stale
}
