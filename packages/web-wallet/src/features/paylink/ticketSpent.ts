import { walletStorage } from "../../platform/storage/walletStorage"
import { linkIdentity } from "./linkIdentity"

/**
 * Links whose golden ticket the claim server refused as spent, by identity, never the bearer
 * fragment. Only this browser's own refusals are known: nothing public says whether a ticket is
 * spent, so a ticket spent elsewhere still reads as available until its redeem is refused.
 */
const KEY = "obsidion.ticket-spent"

function identityOf(fragment: string): string | null {
  try {
    return linkIdentity(fragment)
  } catch {
    return null
  }
}

function spentIds(): string[] {
  try {
    const ids = JSON.parse(walletStorage.getItem(KEY) ?? "[]")
    return Array.isArray(ids) ? ids : []
  } catch {
    return []
  }
}

export function rememberTicketSpent(fragment: string): void {
  const id = identityOf(fragment)
  if (!id) return
  walletStorage.setItem(KEY, JSON.stringify([...new Set([...spentIds(), id])]))
}

/** The link's ticket is known spent: it is treated as a link with no ticket. */
export function ticketKnownSpent(fragment: string): boolean {
  const id = identityOf(fragment)
  return id !== null && spentIds().includes(id)
}
