/**
 * Pure view logic for the contacts screens: search filtering, the inline add panel state machine,
 * detail lookup/labeling, and the minimal detail's action set. Kept UI-free so vitest covers it.
 */
import {
  contactRowFromEntry,
  isPaymentContactEntry,
  isUserLabel,
  normalizeTag,
  shortenAddressSm,
  type Contact,
  type ContactRow,
  type InlineResolveResult,
  type RegistryTagResolution,
} from "@obsidion/front-core"

/** The cached type-ahead address is display-only; a commit persists it only when the
 *  fresh-manifest resolution confirms the same address for the same tag. */
export function freshResolutionConfirms(
  cached: InlineResolveResult | null,
  tag: string,
  fresh: RegistryTagResolution,
): boolean {
  return (
    fresh.status === "resolved" &&
    cached?.tag === tag &&
    cached.status === "found" &&
    cached.address === fresh.l2Address
  )
}

/** Case-insensitive substring filter over name and tag. Empty query returns everything. */
export function filterContacts(contacts: ContactRow[], query: string): ContactRow[] {
  const q = query.trim().replace(/^@/, "").toLowerCase()
  if (!q) return contacts
  return contacts.filter((c) => c.name.toLowerCase().includes(q) || c.tag.toLowerCase().includes(q))
}

/** Inline registry resolution fires only when the query has no exact local match (san
 *  already-saved tag surfaces as its directory row, never as a duplicate add offer). The user's
 *  own tag never resolves — it must not surface as an add offer. */
export function shouldResolveInline(
  contacts: ContactRow[],
  query: string,
  ownTag?: string,
): boolean {
  const tag = normalizeTag(query)
  if (!tag) return false
  if (ownTag && normalizeTag(ownTag) === tag) return false
  return !contacts.some((c) => c.tag === tag || c.id === tag)
}

export type InlinePanelState =
  | { kind: "none" }
  | { kind: "looking-up"; tag: string }
  | { kind: "add-offer"; tag: string }
  | { kind: "no-user-found"; tag: string }

/** Panel under the search field: looking-up → add-offer | no-user-found. */
export function inlinePanelState(
  contacts: ContactRow[],
  query: string,
  lastResolved: InlineResolveResult | null,
  ownTag?: string,
): InlinePanelState {
  const tag = normalizeTag(query)
  if (!tag || !shouldResolveInline(contacts, query, ownTag)) return { kind: "none" }
  if (!lastResolved || lastResolved.tag !== tag || lastResolved.status === "resolving") {
    return { kind: "looking-up", tag }
  }
  if (lastResolved.status === "found") return { kind: "add-offer", tag }
  return { kind: "no-user-found", tag }
}

/** Resolve a detail-route param (directory row id, tag, or address) to its stored entry. */
export function findContactEntry(entries: Contact[], idOrTag: string): Contact | undefined {
  const needle = decodeURIComponent(idOrTag)
  const tag = normalizeTag(needle)
  return entries.find(
    (e) =>
      e.tag === tag ||
      e.address.toLowerCase() === needle.toLowerCase() ||
      (isPaymentContactEntry(e) && contactRowFromEntry(e).id === needle),
  )
}

/** One-line address-kind description for the detail header. */
export function addressKindLabel(entry: Contact): string {
  switch (entry.addressKind ?? "aztec-l2") {
    case "ethereum-l1":
      return "Ethereum wallet (L1)"
    case "pending-handshake":
      return "Handshake pending — not yet payable"
    default:
      return "zk.money (Aztec L2)"
  }
}

/** Identity descriptor for `ContactStorage.removeEntry`, kind-aware so pending-handshake and L1
 *  rows delete correctly. */
export function removeIdentityOf(entry: Contact): {
  address: string
  addressKind?: Contact["addressKind"]
  provider?: string
} {
  return {
    address: entry.address,
    addressKind: entry.addressKind,
    provider: entry.l1Wallet?.provider,
  }
}

/** Detail-header copy for an L1 wallet, matching DS `ContactRow` (`isL1`). */
export function l1ContactHeader(entry: Contact): { title: string; subtitle: string } {
  const truncated = shortenAddressSm(entry.address)
  return isUserLabel(entry.name)
    ? { title: entry.name.trim(), subtitle: truncated }
    : { title: truncated, subtitle: "Ethereum wallet" }
}

/** Prefill for the L1 rename field: a real label, else empty (not "External Wallet"). */
export function l1AliasDraft(entry: Contact): string {
  return isUserLabel(entry.name) ? entry.name.trim() : ""
}

/** The name a user gave a zk.money contact, if any. A contact saves under its tag, and a connect
 *  can save one under its messaging address before the tag resolves; neither is a rename. */
export function l2ContactLabel(entry: Pick<Contact, "name" | "tag">): string | undefined {
  const name = entry.name.trim()
  if (!name || !entry.tag || name === entry.tag || /^0x[0-9a-f]+$/i.test(name)) return undefined
  return name
}

/** How Activity and other lists name a saved contact: its rename, else its @tag; an Ethereum
 *  wallet by its label. */
export function contactDisplayName(contact: Pick<ContactRow, "name" | "tag" | "addressKind">): string {
  if (contact.addressKind === "ethereum-l1") return contact.name
  return l2ContactLabel(contact) ?? `@${contact.tag}`
}

/** Detail header for a zk.money contact: a renamed one leads with its name over its full tag. */
export function l2ContactHeader(entry: Contact): { title: string; subtitle: string } {
  const handle = entry.tag ?? entry.name
  const label = l2ContactLabel(entry)
  return label ? { title: label, subtitle: `@${handle}.zk.money` } : { title: `@${handle}`, subtitle: ".zk.money" }
}
