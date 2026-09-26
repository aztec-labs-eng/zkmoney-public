import type { ContactRow } from "../hooks/useContactsDirectory"

/**
 * Strips the display formatting `@${tag}.zk.money` produces back to a bare tag the contacts
 * directory's `lookup(idOrTag)` indexes on. Returns the original input unchanged when no formatting
 * is detected — handy for counterparty strings that are already bare (e.g. names or addresses).
 */
function bareTagFromCounterparty(counterparty: string): string {
  let bare = counterparty.trim()
  if (bare.startsWith("@")) bare = bare.slice(1)
  if (bare.endsWith(".zk.money")) bare = bare.slice(0, -".zk.money".length)
  return bare
}

/**
 * Subset of `useContactsDirectory`'s return shape that counterparty resolution needs. Accepting the
 * raw `contacts` array lets the resolvers scan L1 AND L2 entries by address — the directory's
 * `lookupByAddress` deliberately skips L1 rows, which would otherwise leave deposit/withdrawal
 * counterparties unresolved.
 */
export interface TxContactDirectory {
  contacts: ContactRow[]
  lookup: (idOrTag: string) => ContactRow | undefined
}

/**
 * Resolves a single counterparty value (an L1/L2 address, a bare tag like `"alice"`, or a decorated
 * tag like `"@alice.zk.money"`) to a saved contact row — `resolveContactForTx` with the value
 * serving as both display string and address candidate.
 */
export function resolveContactByCounterparty(
  value: string,
  directory: TxContactDirectory,
): ContactRow | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return resolveContactForTx(trimmed, trimmed, directory)
}

/**
 * Best-effort lookup for the contact attached to a tx row's counterparty. Tries three resolution
 * strategies in order:
 *   1. address-keyed lookup against the full `contacts` list (includes L1 so deposit/withdrawal
 *      counterparties resolve to the linked-wallet contact)
 *   2. bare-tag lookup (strip `@` and `.zk.money` from the display string, then index by tag)
 *   3. raw counterparty lookup (for already-bare display labels)
 * Returns `undefined` when no match exists — callers keep their unenriched fallback rendering.
 */
export function resolveContactForTx(
  counterparty: string,
  counterpartyAddress: string | undefined,
  directory: TxContactDirectory,
): ContactRow | undefined {
  if (counterpartyAddress) {
    const needle = counterpartyAddress.toLowerCase()
    const byAddr = directory.contacts.find((c) => c.address.toLowerCase() === needle)
    if (byAddr) return byAddr
  }
  const bare = bareTagFromCounterparty(counterparty)
  return directory.lookup(bare) ?? directory.lookup(counterparty)
}
