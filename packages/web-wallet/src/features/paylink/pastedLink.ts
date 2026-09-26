import { decodePaylinkInline } from "@obsidion/sdk"
import { decodeRequestInline } from "@obsidion/front-core"

/**
 * In-app route for pasted link text — a full URL from any host (`…/claim#…`, `…/request#…`,
 * `…/link#…`) or a bare fragment. Paylinks route to `/link`, payment
 * requests to `/request`; null when the text decodes as neither, so a stray paste never
 * navigates. Client-side routing here is what keeps the PXE warm — pasting into the address bar
 * costs a full reload.
 */
export function pastedLinkRoute(text: string): string | null {
  const t = text.trim()
  const fragment = t.includes("#") ? t.slice(t.indexOf("#") + 1) : t
  if (!fragment) return null
  try {
    decodePaylinkInline(fragment)
    return `/link#${fragment}`
  } catch {
    /* not a paylink */
  }
  try {
    decodeRequestInline(fragment)
    return `/request#${fragment}`
  } catch {
    return null
  }
}
