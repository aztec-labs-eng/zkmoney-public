import { viewLink, type ViewLinkDeps } from "./sponsoredPaylink"
import type { PaymentLink } from "./types"

const NOTE_RETRY_MS = 5_000
const NOTE_RETRIES = 12

/**
 * Read a link's status, then keep re-reading while it is unclaimed with unknown timing: the PXE
 * trails the tip, so a fresh escrow's note becomes readable only a few blocks after creation, and
 * `from_claimable` lives in that note. `onLink` fires per read; the returned function cancels.
 */
export function watchLink(
  deps: ViewLinkDeps,
  fragment: string,
  onLink: (link: PaymentLink) => void,
  onError: (e: unknown) => void,
  /** Runs once reads stop, so another escrow registration can safely start. */
  onSettled?: () => void,
): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = (attempt: number) =>
    viewLink(deps, fragment)
      .then((link) => {
        if (cancelled) return
        onLink(link)
        if (link.status === "unclaimed" && link.claimableFrom == null && attempt < NOTE_RETRIES) {
          timer = setTimeout(() => read(attempt + 1), NOTE_RETRY_MS)
        } else {
          onSettled?.()
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        onError(e)
        onSettled?.()
      })
  read(0)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}
