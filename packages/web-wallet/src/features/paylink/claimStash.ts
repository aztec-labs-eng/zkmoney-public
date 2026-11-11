/**
 * Inbound-paylink handoff: /link stashes the fragment here and sends a signed-in visitor to Home,
 * where ClaimLinkModal replays it (ULT-671 page 6). Kept for the tab, so the prompt survives a
 * refresh; cleared when the modal is declined, closed, or the claim settles.
 */
import type { tabStash } from "../../platform/storage/tabStash"

export const CLAIM_STASH_KEY = "obsidion.pending-claim"

/**
 * The link is paying for the signup it opened: the visitor chose "Receive to zk.money" on a
 * network that issues golden tickets, or a signup elsewhere sent the link here to pick a name.
 * Only this marker turns a stashed link into a link-funded registration; a link stashed for an
 * ordinary claim on Home never does.
 */
export const TICKET_STASH_KEY = "obsidion.pending-claim.ticket"

/** Router state that opens a link's page on its signup: "Receive to zk.money" is chosen. */
export const RECEIVE_TO_ACCOUNT = { receive: "account" } as const

export const receivesToAccount = (state: unknown): boolean =>
  (state as { receive?: unknown } | null)?.receive === RECEIVE_TO_ACCOUNT.receive

export interface TicketSignupStash {
  fragment: string
  /** What the link must hold, base units, as `/domain/info` advertised it. Absent on a marker
   *  rebuilt from the terms the ticket bought (`boundTicketSignup`). */
  threshold?: string
  /** The reduced schedule the ticket buys, base units; for a `paid` signup, the name's own. */
  schedule: { fee: string; minDeposit: string }
  /** No ticket: the link pays the name's own price, deposit and fees, when its note covers it. */
  paid?: true
  /** The note's amount, base units, once the witness read it. */
  amount?: string
  memo?: string
  senderTag?: string
  /** The rest of the visitor page's read of the note, so Home claims without reading it first. */
  claimableFrom?: number
  claimableUntil?: number
  tokenAddress?: string
  txHash?: string
  /** The prover tip the split committed to before the terms exist, base units. */
  proverTip?: string
  /** The speed the split committed to with it. */
  speed?: "standard" | "faster"
  /** The withdrawal fee that split was priced with, base units. */
  withdrawalFee?: string
}

type TabStash = typeof tabStash

export function stashClaimLink(stash: TabStash, fragment: string): void {
  stash.set(CLAIM_STASH_KEY, fragment)
}

/** Non-destructive read — Home keeps prompting until the stash is explicitly cleared. */
export function peekClaimStash(stash: TabStash): string | null {
  return stash.get(CLAIM_STASH_KEY)
}

/** Clears only `fragment`'s link — a settling claim must not drop a newer stash. */
export function clearClaimStash(stash: TabStash, fragment: string): void {
  if (stash.get(CLAIM_STASH_KEY) !== fragment) return
  stash.remove(CLAIM_STASH_KEY)
  stash.remove(TICKET_STASH_KEY)
}

export function stashTicketSignup(stash: TabStash, ticket: TicketSignupStash): void {
  stash.set(CLAIM_STASH_KEY, ticket.fragment)
  stash.set(TICKET_STASH_KEY, JSON.stringify(ticket))
}

/** The ticket-funded signup waiting on this tab, or null: a marker for another link is stale. */
export function peekTicketSignup(stash: TabStash): TicketSignupStash | null {
  const raw = stash.get(TICKET_STASH_KEY)
  if (raw === null) return null
  try {
    const ticket = JSON.parse(raw) as TicketSignupStash
    return ticket.fragment === stash.get(CLAIM_STASH_KEY) ? ticket : null
  } catch {
    return null
  }
}

export function updateTicketSignup(
  stash: TabStash,
  patch: Partial<Omit<TicketSignupStash, "fragment">>,
): void {
  const ticket = peekTicketSignup(stash)
  if (!ticket) return
  stash.set(TICKET_STASH_KEY, JSON.stringify({ ...ticket, ...patch }))
}

/** Drops the ticket intent and leaves the link stashed for an ordinary claim on Home. */
export function clearTicketSignup(stash: TabStash): void {
  stash.remove(TICKET_STASH_KEY)
}
