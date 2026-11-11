import { formatUnits } from "viem"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { bestEffortSync } from "@obsidion/core/errors"
import { tabStash, type TabKey } from "../../platform/storage/tabStash"
import { latestChainSeconds } from "./chainTime"
import { peekClaimStash, peekTicketSignup } from "./claimStash"
import { withExpiry } from "./claimWindow"
import { linkIdentity } from "./linkIdentity"
import type { WebWalletConfig } from "../../config/env"
import { decodeLink, viewLink, type ViewLinkDeps } from "./sponsoredPaylink"
import type { PaymentLink } from "./types"

const NOTE_RETRY_MS = 5_000
const NOTE_RETRIES = 12
/** How long the reads of a link retry a note they keep missing before they stop. */
export const LINK_READ_BUDGET_MS = NOTE_RETRIES * NOTE_RETRY_MS
const READ_CACHE_PREFIX = "obsidion.link-read:"

/** What a read of the escrow note says that never changes: the amount, the window, the memo and sender, the funding tx. */
type NoteRead = Pick<
  PaymentLink,
  "amount" | "claimableFrom" | "claimableUntil" | "memo" | "senderTag" | "txHash"
>
/** A note read with the link's token, which only the signup's marker carries. */
type KnownRead = NoteRead & Pick<PaymentLink, "tokenAddress">

function noteRead(link: Partial<PaymentLink>): NoteRead | null {
  if (link.claimableFrom == null) return null
  const { amount, claimableFrom, claimableUntil, memo, senderTag, txHash } = link
  return { amount, claimableFrom, claimableUntil, memo, senderTag, txHash }
}

function cacheKey(fragment: string): TabKey | null {
  try {
    return `${READ_CACHE_PREFIX}${linkIdentity(fragment)}`
  } catch {
    return null
  }
}

/** This tab's last read of the link, keyed by the link's identity so no secret is stored. */
function cachedRead(fragment: string): NoteRead | null {
  const key = cacheKey(fragment)
  try {
    const raw = key && tabStash.get(key)
    return raw ? (JSON.parse(raw) as NoteRead) : null
  } catch {
    return null
  }
}

function writeRead(fragment: string, read: NoteRead | null): void {
  const key = cacheKey(fragment)
  if (!key) return
  // A tab without storage reads the link again on the next page.
  bestEffortSync(() => {
    const kept = read && noteRead(read)
    if (kept) tabStash.set(key, JSON.stringify(kept))
    else tabStash.remove(key)
  }, undefined)
}

/** What the visitor page read before a ticket signup, off its marker. */
function markerRead(config: WebWalletConfig, fragment: string): KnownRead | null {
  const marker = peekTicketSignup(tabStash)
  if (!marker || marker.fragment !== fragment) return null
  const read = noteRead({
    amount:
      marker.amount === undefined
        ? undefined
        : formatUnits(BigInt(marker.amount), tokenDecimalsForNetwork(config.network)),
    claimableFrom: marker.claimableFrom,
    claimableUntil: marker.claimableUntil,
    memo: marker.memo,
    senderTag: marker.senderTag,
    txHash: marker.txHash,
  })
  return read && marker.tokenAddress ? { ...read, tokenAddress: marker.tokenAddress } : read
}

/** What this tab knows of the note before reading it: its own last read over the signup's marker. */
function knownRead(config: WebWalletConfig, fragment: string): KnownRead | null {
  const marker = markerRead(config, fragment)
  const cached = cachedRead(fragment)
  return marker || cached ? { ...marker, ...cached } : null
}

/** Whether this tab holds an earlier read of the link, which {@link seededLink} shows. */
export function readBefore(config: WebWalletConfig, fragment: string): boolean {
  return knownRead(config, fragment) !== null
}

/**
 * The decoded link with what this tab last read of its escrow note, so a reload or the hand-off to
 * Home shows the amount and the window at once while the link is read again. Throws as `decodeLink`.
 */
export function seededLink(config: WebWalletConfig, fragment: string): PaymentLink {
  const link = decodeLink(config, fragment)
  const read = knownRead(config, fragment)
  return read ? { ...link, ...read } : link
}

/**
 * Read a link's status, then keep re-reading while an unclaimed link's note is unread: the PXE
 * trails the tip, so a fresh escrow's note becomes readable only a few blocks after creation, and
 * `from_claimable` lives in that note. A read that misses the note keeps what an earlier read
 * found, since the note never changes, but reads on for what was not kept (the token, the email
 * and its commitment). `onLink` fires per read; the returned function cancels.
 */
export function watchLink(
  deps: ViewLinkDeps,
  fragment: string,
  onLink: (link: PaymentLink) => void,
  onError: (e: unknown) => void,
  /**
   * Runs once reads stop, so another escrow registration can safely start. `noteRead`: a read here
   * found an unclaimed link's note itself, so its token and an email link's email and commitment are
   * known, not only what this tab read before.
   */
  onSettled?: (noteRead: boolean) => void,
): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let known = knownRead(deps.session.page.config, fragment)
  const read = (attempt: number) =>
    viewLink(deps, fragment)
      .then((fresh) => {
        if (cancelled) return
        const missed = fresh.status === "unclaimed" && fresh.claimableFrom == null
        const link = missed && known ? { ...fresh, ...known } : fresh
        if (link.status === "unclaimed") {
          known = noteRead(link) ?? known
          if (known) writeRead(fragment, known)
        } else writeRead(fragment, null)
        onLink(link)
        if (missed && attempt < NOTE_RETRIES) {
          timer = setTimeout(() => read(attempt + 1), NOTE_RETRY_MS)
        } else {
          onSettled?.(!missed)
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        onError(e)
        onSettled?.(false)
      })
  read(0)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}

/**
 * The stashed link, read fresh, while it can still be claimed: a signup started with one opens on
 * the link's own signup instead. Null with none stashed, a closed link, or a failed read.
 */
export async function openStashedLink(deps: ViewLinkDeps): Promise<string | null> {
  const fragment = peekClaimStash(tabStash)
  if (!fragment) return null
  try {
    const [fresh, chainNow] = await Promise.all([
      viewLink(deps, fragment),
      latestChainSeconds(deps.wallet.node),
    ])
    const known = knownRead(deps.session.page.config, fragment)
    const missed = fresh.claimableFrom == null && known
    const link = withExpiry(missed ? { ...fresh, ...known } : fresh, chainNow)
    return link.status === "unclaimed" ? fragment : null
  } catch {
    return null
  }
}
