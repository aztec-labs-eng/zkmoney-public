import { decodeLinkFragment, decodePaylinkInline, LinkKind } from "@obsidion/sdk"
import { decodeRequestInline } from "@obsidion/front-core"
import { bestEffortSync } from "@obsidion/core/errors"

/**
 * In-app route for pasted link text — a full URL from any host (`…/claim#…`, `…/request#…`,
 * `…/link#…`, `…/p#…`, `…/pay/<tag>#…`) or a bare fragment. Paylinks route to `/link`, payment
 * requests to `/request`; null when the text decodes as neither, so a stray paste never
 * navigates. Client-side routing here is what keeps the PXE warm — pasting into the address bar
 * costs a full reload.
 */
export function pastedLinkRoute(text: string): string | null {
  const t = text.trim()
  const fragment = t.includes("#") ? t.slice(t.indexOf("#") + 1) : t
  if (!fragment) return null
  const short = decodeLinkFragment(fragment)
  if (short) return short.kind === LinkKind.Paylink ? `/link#${fragment}` : `/request#${fragment}`
  // A paste that is not a paylink may be a request.
  const paylink = bestEffortSync(() => {
    decodePaylinkInline(fragment)
    return true
  }, false)
  if (paylink) return `/link#${fragment}`
  try {
    decodeRequestInline(fragment)
    return `/request#${fragment}`
  } catch {
    return null
  }
}
