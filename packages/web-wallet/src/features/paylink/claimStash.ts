/**
 * Inbound-paylink handoff: /link stashes the fragment here and sends a signed-in visitor to Home,
 * where ClaimLinkModal replays it (ULT-671 page 6). sessionStorage so the prompt survives a
 * refresh but not the tab; cleared when the modal is declined, closed, or the claim settles.
 */
export const CLAIM_STASH_KEY = "obsidion.pending-claim"

/**
 * The link is paying for the signup it opened: the visitor chose "Receive to zk.money" on a
 * network that issues golden tickets. Only this marker turns a stashed link into a ticket-funded
 * registration; a link stashed for an ordinary claim on Home never does.
 */
export const TICKET_STASH_KEY = "obsidion.pending-claim.ticket"

export interface TicketSignupStash {
  fragment: string
  /** What the link must hold, base units, as `/domain/info` advertised it. Absent on a marker
   *  rebuilt from the terms the ticket bought (`boundTicketSignup`). */
  threshold?: string
  /** The reduced schedule the ticket buys, base units. */
  schedule: { fee: string; minDeposit: string }
  /** The note's amount, base units, once the witness read it. */
  amount?: string
  memo?: string
  /** The prover tip the split committed to before the terms exist, base units. */
  proverTip?: string
  /** The speed the split committed to with it. */
  speed?: "standard" | "faster"
}

/** sessionStorage-shaped seam. */
interface StringStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function stashClaimLink(fragment: string, store: StringStore = sessionStorage): void {
  store.setItem(CLAIM_STASH_KEY, fragment)
}

/** Non-destructive read — Home keeps prompting until the stash is explicitly cleared. */
export function peekClaimStash(store: StringStore = sessionStorage): string | null {
  return store.getItem(CLAIM_STASH_KEY)
}

/** With `fragment`, clears only that link — a settling claim must not drop a newer stash. */
export function clearClaimStash(fragment?: string, store: StringStore = sessionStorage): void {
  if (fragment !== undefined && store.getItem(CLAIM_STASH_KEY) !== fragment) return
  store.removeItem(CLAIM_STASH_KEY)
  store.removeItem(TICKET_STASH_KEY)
}

export function stashTicketSignup(
  stash: TicketSignupStash,
  store: StringStore = sessionStorage,
): void {
  store.setItem(CLAIM_STASH_KEY, stash.fragment)
  store.setItem(TICKET_STASH_KEY, JSON.stringify(stash))
}

/** The ticket-funded signup waiting on this tab, or null: a marker for another link is stale. */
export function peekTicketSignup(store: StringStore = sessionStorage): TicketSignupStash | null {
  const raw = store.getItem(TICKET_STASH_KEY)
  if (raw === null) return null
  try {
    const stash = JSON.parse(raw) as TicketSignupStash
    return stash.fragment === store.getItem(CLAIM_STASH_KEY) ? stash : null
  } catch {
    return null
  }
}

export function updateTicketSignup(
  patch: Partial<Omit<TicketSignupStash, "fragment">>,
  store: StringStore = sessionStorage,
): void {
  const stash = peekTicketSignup(store)
  if (!stash) return
  store.setItem(TICKET_STASH_KEY, JSON.stringify({ ...stash, ...patch }))
}

/** Drops the ticket intent and leaves the link stashed for an ordinary claim on Home. */
export function clearTicketSignup(store: StringStore = sessionStorage): void {
  store.removeItem(TICKET_STASH_KEY)
}
