import { isZeroAddress } from "../utils/validate"
import { shortenAddressSm } from "../utils/shortenAddr"
import { logger } from "../utils/logger"
import { migrateContacts, legacyBook, CONTACT_STORAGE_KEY } from "../storageMigrations/contacts"
import type { Database } from "./database"
import { WalletError } from "./errors"
import {
  decodeRecord,
  loadRecords,
  persistentStore,
  timeKey,
  type RecordSet,
} from "./persistentStore"
import type { ReadonlyStore } from "./store"

/**
 * Address format a `Contact.address` is stored in:
 *   - `"aztec-l2"`            — a 32-byte Aztec L2 address (the real recipient).
 *   - `"ethereum-l1"`         — a 20-byte Ethereum L1 wallet address (deposit/recall).
 *   - `"pending-handshake"`   — a 20-byte XMTP/Ethereum-format handle from a QR
 *                               handshake before we know the peer's L2 address.
 *                               This is handshake state, not a payment route.
 */
export type AddressKind = "aztec-l2" | "ethereum-l1" | "pending-handshake"

export type L1WalletContactProvenance = "deposit-attested" | "saved-recipient"

/**
 * Root-level provenance for an L2 contact — distinct from the L1-only
 * `ContactL1Wallet.provenance`. Records *how* the L2 contact entered the book;
 * `"qr-scan"` marks a contact added via the QR/link handshake.
 */
export type ContactProvenance = "qr-scan"

export interface ContactAvatar {
  type: "image" | "gradient" | "initials"
  url?: string
  colorHex?: [string, string]
}

export interface ContactL1Wallet {
  provider: string
  walletId?: string
  walletName?: string
  imageUrl?: string
  provenance: L1WalletContactProvenance
  /**
   * The display name is a user-chosen label. Outranks auto-derived wallet names
   * in merges regardless of provenance — without it a label survives exactly
   * one deposit merge (`strongerProvenance` upgrades the row to
   * `deposit-attested`, after which the next deposit's wallet name wins).
   */
  userLabeled?: boolean
  /**
   * Lowercased prior addresses this row was edited away from. Deposit history
   * is immutable and independently feeds the withdraw "Recent" list, so
   * without this an address edit would resurrect the old address as a ghost
   * row (see `deriveRecentWithdrawWallets`).
   */
  replacedAddresses?: string[]
  /**
   * Set when the user removed this wallet from the withdraw picker. The row is
   * kept as a tombstone rather than hard-deleted — deposit history is immutable
   * and independently feeds the withdraw "Recent" list, so a hard delete would
   * let old deposit records resurrect the row. Consumers hide tombstoned rows
   * at read time; activity newer than this timestamp (a fresh deposit or a
   * manual re-save) revives the row (`mergeL1Contacts`).
   */
  deletedAt?: number
  lastUsedAt?: number
}

export interface Contact {
  name: string
  address: string
  /** Missing means legacy Aztec L2 contact. */
  addressKind?: AddressKind
  // L2-only / pending-handshake metadata
  tag?: string
  email?: string
  verified?: boolean
  /** How this L2 contact was added (e.g. `"qr-scan"`). Absent for legacy/manual adds. */
  provenance?: ContactProvenance
  /**
   * Added by the wallet, not the user: from an incoming transfer, or while a send that pays this
   * person's request is in flight. Its requests count as from a non-contact until the user adds or
   * pays it, or it pays one of the user's own requests.
   */
  autoAdded?: boolean
  /** Addresses this L2 contact held on retired rollups; its history there still matches them. */
  retiredAddresses?: string[]
  // L1-only (present iff addressKind === "ethereum-l1")
  avatar?: ContactAvatar
  l1Wallet?: ContactL1Wallet
}

/**
 * Identity descriptor for `removeEntry` and `modifyEntry`. The same Ethereum address string can
 * legally exist as both an L2 row and one or more L1 rows under different providers.
 *
 * - Omit `addressKind` (or pass `"aztec-l2"`) to target an L2 row by address.
 * - For an L1 row, pass `addressKind: "ethereum-l1"` plus the `provider` slug
 *   that identifies the wallet (e.g. `"rainbow"`, `"metamask"`).
 *
 * Examples:
 *   removeEntry({ address })                                          // L2 default
 *   removeEntry({ address, addressKind: "ethereum-l1", provider })    // L1 row
 */
export interface ContactIdentity {
  address: string
  addressKind?: AddressKind
  provider?: string
}

export interface UpsertL1WalletContactInput {
  name: string
  address: string
  provider: string
  walletId?: string
  walletName?: string
  imageUrl?: string
  provenance: L1WalletContactProvenance
  userLabeled?: boolean
  avatar?: ContactAvatar
  lastUsedAt?: number
}

export interface UpdateL1WalletContactInput {
  /** Identity of the row being edited. */
  originalAddress: string
  provider: string
  /** New values. An empty/placeholder name falls back to "External Wallet". */
  name: string
  address: string
}

const normalizeName = (name: string): string => name.trim().replace(/\s+/g, "").toLowerCase()
const normalizeAddress = (address: string): string => address.toLowerCase()
const addressKindOf = (entry: Contact): AddressKind => entry.addressKind ?? "aztec-l2"

/**
 * Provider slugs that don't pin a specific wallet app: the deposit path uses
 * `"unknown"` for unresolved senders and the withdraw-save path uses `"manual"`
 * for user-typed recipients. An L1 contact carrying one of these is treated as
 * "the same wallet" as any other row for the same address, so a user-saved
 * recipient and a later deposit-attested row collapse into
 * one contact instead of forking a duplicate. Two genuinely-different real
 * providers for one address stay distinct.
 */
/** Unresolved provider. */
const UNKNOWN_PROVIDER_SLUG = "unknown"
const GENERIC_L1_PROVIDERS: ReadonlySet<string> = new Set(["", UNKNOWN_PROVIDER_SLUG, "manual"])
const isGenericProvider = (provider: string | undefined): boolean =>
  !provider || GENERIC_L1_PROVIDERS.has(provider)

/** Display-name placeholder written for an L1 wallet with no user label / known wallet name. */
export const L1_PLACEHOLDER_NAME = "External Wallet"
/**
 * Whether an L1 wallet name is a real user label — non-empty (after trimming) and
 * not the "External Wallet" placeholder. The source of truth for the "show
 * the label, else the address" rule; the DS `ContactRow` mirrors this exact
 * rule (kept in lockstep by hand — it can't import front-core).
 */
export const isUserLabel = (name: string | null | undefined): boolean =>
  !!name && name.trim().length > 0 && name.trim() !== L1_PLACEHOLDER_NAME

/**
 * Whether two L1 provider slugs identify the same wallet for the same address.
 * A generic/unresolved provider (`unknown`/`manual`/empty) on either side
 * matches anything (a user-saved "manual"/"unknown" row and a deposit-attested
 * real-slug row are the same wallet); two genuinely-different real slugs stay
 * distinct. Shared by `sameL1WalletIdentity` (dedup-on-write) and
 * `matchesIdentity` (delete/modify targeting) so the two never drift — a delete
 * whose target provider came from the source record still hits the collapsed
 * row even after its provider upgraded to a real slug.
 */
export const l1WalletProvidersMatch = (a: string | undefined, b: string | undefined): boolean =>
  isGenericProvider(a) || isGenericProvider(b) || a === b

const sameL1WalletIdentity = (a: Contact, b: Contact): boolean => {
  if (addressKindOf(a) !== "ethereum-l1" || addressKindOf(b) !== "ethereum-l1") return false
  if (normalizeAddress(a.address) !== normalizeAddress(b.address)) return false
  return l1WalletProvidersMatch(a.l1Wallet?.provider, b.l1Wallet?.provider)
}

/**
 * Whether a contact's display name is a user-given label. The explicit
 * `userLabeled` flag is authoritative (it survives provenance upgrades on
 * merge); the saved-recipient-provenance check covers rows written before the
 * flag existed.
 */
const hasUserLabel = (contact: Contact): boolean => {
  if (!isUserLabel(contact.name)) return false
  return (
    contact.l1Wallet?.userLabeled === true || contact.l1Wallet?.provenance === "saved-recipient"
  )
}

/** Tombstoned by a user removal (see `ContactL1Wallet.deletedAt`). */
const isDeletedL1 = (contact: Contact): boolean => contact.l1Wallet?.deletedAt !== undefined

/**
 * Merge rule for the display name of two same-address L1 contacts. A user-given
 * label outranks an auto-derived deposit/provider name; among the same rank a
 * real label beats the "External Wallet" placeholder; the incoming (newer) side
 * wins ties so a rename takes effect.
 */
const mergeL1Name = (existing: Contact, incoming: Contact): string => {
  const exUserLabel = hasUserLabel(existing)
  const inUserLabel = hasUserLabel(incoming)
  if (inUserLabel) return incoming.name
  if (exUserLabel) return existing.name
  if (isUserLabel(incoming.name)) return incoming.name
  if (isUserLabel(existing.name)) return existing.name
  return incoming.name || existing.name
}

/**
 * Merge rule for the provider slug of two same-address L1 contacts. A real
 * wallet slug always wins over a generic (`unknown`/`manual`) one so the merged
 * row keeps a stable, real-provider identity (and a stable row id); the incoming
 * side wins when both are real.
 */
const mergeProvider = (existing: string | undefined, incoming: string | undefined): string => {
  if (!isGenericProvider(incoming)) return incoming as string
  if (!isGenericProvider(existing)) return existing as string
  // Both generic: canonicalize to `"unknown"` so the derived
  // row id (`l1:<provider>:<address>`) is stable regardless of
  // write/load order ("manual" vs "unknown" would otherwise flip the id).
  return UNKNOWN_PROVIDER_SLUG
}

/**
 * Field-merge two same-address L1 contacts into one. Prefers a user label over
 * an auto name (`mergeL1Name`), a real provider over a generic one
 * (`mergeProvider`), the strongest provenance (`strongerProvenance`), and the
 * most-recent `lastUsedAt`.
 */
const mergeL1Contacts = <C extends Contact>(existing: C, incoming: Contact): C => {
  const ew = existing.l1Wallet
  const iw = incoming.l1Wallet
  const replacedAddresses = [
    ...new Set([...(ew?.replacedAddresses ?? []), ...(iw?.replacedAddresses ?? [])]),
  ]
  const lastUsedAt = Math.max(ew?.lastUsedAt ?? 0, iw?.lastUsedAt ?? 0)
  const deletedAt = Math.max(ew?.deletedAt ?? 0, iw?.deletedAt ?? 0)
  return {
    ...existing,
    name: mergeL1Name(existing, incoming),
    address: incoming.address,
    addressKind: "ethereum-l1",
    avatar: incoming.avatar ?? existing.avatar,
    l1Wallet: {
      provider: mergeProvider(ew?.provider, iw?.provider),
      walletId: iw?.walletId ?? ew?.walletId,
      walletName: iw?.walletName ?? ew?.walletName,
      imageUrl: iw?.imageUrl ?? ew?.imageUrl,
      provenance: strongerProvenance(ew?.provenance, iw?.provenance ?? "saved-recipient"),
      userLabeled: ew?.userLabeled || iw?.userLabeled || undefined,
      replacedAddresses: replacedAddresses.length > 0 ? replacedAddresses : undefined,
      // Activity newer than the removal revives a tombstone; deletion wins ties.
      deletedAt: deletedAt > 0 && deletedAt >= lastUsedAt ? deletedAt : undefined,
      lastUsedAt,
    },
  }
}

/**
 * Collapses duplicate L1 rows that `sameL1WalletIdentity` treats as one wallet (e.g. a `"manual"`
 * saved-recipient row and a real-slug deposit-attested row for one address). Order-preserving;
 * merges into the first row. The storage migration runs it once.
 */
export const reconcileL1Duplicates = <C extends Contact>(entries: readonly C[]): C[] => {
  const result: C[] = []
  for (const entry of entries) {
    if (addressKindOf(entry) !== "ethereum-l1") {
      result.push(entry)
      continue
    }
    const existingIndex = result.findIndex((e) => sameL1WalletIdentity(e, entry))
    if (existingIndex === -1) {
      result.push(entry)
    } else {
      result[existingIndex] = mergeL1Contacts(result[existingIndex], entry)
    }
  }
  return result
}

const sameAddressIdentity = (a: Contact, b: Contact): boolean => {
  const kindA = addressKindOf(a)
  const kindB = addressKindOf(b)
  if (kindA !== kindB) return false
  if (kindA === "ethereum-l1") return sameL1WalletIdentity(a, b)
  return normalizeAddress(a.address) === normalizeAddress(b.address)
}

const sameTag = (a: Contact, b: Contact): boolean =>
  !!a.tag && !!b.tag && a.tag.toLowerCase() === b.tag.toLowerCase()

const withoutAutoAdded = <C extends Contact>(entry: C): C => {
  const approved = { ...entry }
  delete approved.autoAdded
  return approved
}

/**
 * Loose collision check for the idempotent `addOrMergeContact` path: two
 * entries "are the same contact" if they match by address-identity OR share a
 * `tag` OR share a normalized display name. Unlike `sameAddressIdentity` (which
 * keys strictly on the address), this also folds tag/name collisions into a
 * no-op so the qr-scan add never trips the throwing duplicate validators.
 */
const collidesIdentity = (a: Contact, b: Contact): boolean => {
  if (sameAddressIdentity(a, b)) return true
  if (a.tag && b.tag && a.tag === b.tag) return true
  return normalizeName(a.name) === normalizeName(b.name)
}

const matchesIdentity = (entry: Contact, target: ContactIdentity): boolean => {
  const targetKind = target.addressKind ?? "aztec-l2"
  if (addressKindOf(entry) !== targetKind) return false
  if (targetKind === "ethereum-l1") {
    if (!l1WalletProvidersMatch(entry.l1Wallet?.provider, target.provider)) return false
  }
  return normalizeAddress(entry.address) === normalizeAddress(target.address)
}

const strongerProvenance = (
  current: L1WalletContactProvenance | undefined,
  incoming: L1WalletContactProvenance,
): L1WalletContactProvenance => {
  if (current === "deposit-attested" || incoming === "deposit-attested") return "deposit-attested"
  return incoming
}

/** A contact as the book saves it. `id` sorts in book order: the first match is the first saved. */
export type StoredContact = Contact & { id: string }

/** The book after a change, and what the change returns. */
type Changed<T> = [book: StoredContact[], result: T]

/** Ids for new contacts, each after every id in `book`, in the order asked. */
export function contactIds(book: readonly StoredContact[], now: number): () => string {
  const last = book.at(-1)
  let next = Math.max(now, last ? Number(last.id.slice(0, 16)) + 1 : 0)
  return () => timeKey(next++)
}

const added = (entry: Contact, id: () => string): StoredContact => ({ ...entry, id: id() })
/** `entry` in the place of `held`. */
const replacing = (held: StoredContact, entry: Contact): StoredContact => ({
  ...entry,
  id: held.id,
})

/**
 * Shape validation only. Address-format value validation runs at write time via
 * `validate.ts > addContactSchema`; this keeps corrupt saved entries out of the book.
 *
 * Rules (aligned with `addContactSchema` shape semantics):
 *   - L1 row (`addressKind === "ethereum-l1"`): require `l1Wallet` shape with
 *     non-empty `provider` and known `provenance`.
 *   - L2 row with stray `l1Wallet`: still validate `l1Wallet` shape (drop on
 *     malformed) — `addContactSchema` validates the field whenever present.
 *   - Legacy L2 row without `l1Wallet`: no L1 validation.
 */
export function isValidContact(value: unknown): value is Contact {
  if (value === null || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (typeof v.name !== "string" || typeof v.address !== "string") return false
  // Match `validate.ts > addContactSchema` — `name: z.string().min(1)`. An
  // empty name on disk surfaces as a blank contact row in the UI; drop it.
  if (v.name.length === 0) return false
  if (v.tag !== undefined && typeof v.tag !== "string") return false
  if (v.email !== undefined && typeof v.email !== "string") return false
  if (v.verified !== undefined && typeof v.verified !== "boolean") return false
  if (v.provenance !== undefined && v.provenance !== "qr-scan") return false
  if (v.autoAdded !== undefined && typeof v.autoAdded !== "boolean") return false
  if (
    v.retiredAddresses !== undefined &&
    (!Array.isArray(v.retiredAddresses) || v.retiredAddresses.some((a) => typeof a !== "string"))
  ) {
    return false
  }

  const addressKind = v.addressKind
  if (
    addressKind !== undefined &&
    addressKind !== "aztec-l2" &&
    addressKind !== "ethereum-l1" &&
    addressKind !== "pending-handshake"
  ) {
    return false
  }
  if (addressKind === "pending-handshake" && v.provenance !== "qr-scan") return false

  if (v.avatar !== undefined && !isValidAvatar(v.avatar)) return false

  const l1Wallet = v.l1Wallet
  if (l1Wallet !== undefined) {
    if (!isValidL1Wallet(l1Wallet)) return false
  } else if (addressKind === "ethereum-l1") {
    // L1 rows require l1Wallet metadata; otherwise dedup can't disambiguate.
    return false
  }

  return true
}

function isValidAvatar(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (v.type !== "image" && v.type !== "gradient" && v.type !== "initials") return false
  if (v.url !== undefined && typeof v.url !== "string") return false
  if (v.colorHex !== undefined) {
    if (!Array.isArray(v.colorHex) || v.colorHex.length !== 2) return false
    if (typeof v.colorHex[0] !== "string" || typeof v.colorHex[1] !== "string") return false
  }
  return true
}

function isValidL1Wallet(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (typeof v.provider !== "string" || v.provider.length === 0) return false
  if (v.provenance !== "deposit-attested" && v.provenance !== "saved-recipient") return false
  if (v.walletId !== undefined && typeof v.walletId !== "string") return false
  if (v.walletName !== undefined && typeof v.walletName !== "string") return false
  if (v.imageUrl !== undefined && typeof v.imageUrl !== "string") return false
  if (v.userLabeled !== undefined && typeof v.userLabeled !== "boolean") return false
  if (v.replacedAddresses !== undefined) {
    if (!Array.isArray(v.replacedAddresses)) return false
    if (v.replacedAddresses.some((address) => typeof address !== "string")) return false
  }
  if (v.deletedAt !== undefined && typeof v.deletedAt !== "number") return false
  if (v.lastUsedAt !== undefined && typeof v.lastUsedAt !== "number") return false
  return true
}

/** The `autoAdded` row at the address of an entry the user adds, or -1. */
function autoAddedIndex(book: readonly Contact[], entry: Contact): number {
  if (entry.autoAdded) return -1
  return book.findIndex((e) => e.autoAdded && sameAddressIdentity(e, entry))
}

function validateDuplicateEntry(book: readonly Contact[], entry: Contact, exclude?: Contact): void {
  const others = book.filter((e) => e !== exclude)
  if (others.some((e) => sameAddressIdentity(e, entry))) {
    throw new WalletError("contact.duplicate", "Duplicate entry - address")
  }
  if (entry.tag && others.some((e) => e.tag === entry.tag)) {
    throw new WalletError("contact.duplicate", "Duplicate entry - tag")
  }
  if (entry.email && others.some((e) => e.email === entry.email)) {
    throw new WalletError("contact.duplicate", "Duplicate entry - email")
  }
  validateDuplicateName(book, entry.name, exclude)
}

function validateDuplicateName(book: readonly Contact[], name: string, exclude?: Contact): void {
  const normalized = normalizeName(name)
  if (book.some((e) => normalizeName(e.name) === normalized && e !== exclude)) {
    throw new WalletError("contact.nameTaken", "Duplicate entry - name")
  }
}

/**
 * Adding a person the wallet added (`autoAdded`) approves the existing row instead. When that row
 * has another tag at the same address (e.g. the tag changed since the wallet added it), the user's
 * entry replaces it.
 */
export function addEntry(
  book: readonly StoredContact[],
  entry: Contact,
  id: () => string,
): Changed<void> {
  const next = [...book]
  const index = autoAddedIndex(next, entry)
  if (index === -1) {
    validateDuplicateEntry(next, entry)
    next.push(added(entry, id))
  } else if (sameTag(next[index], entry)) {
    next[index] = withoutAutoAdded(next[index])
  } else {
    validateDuplicateEntry(next, entry, next[index])
    next[index] = replacing(next[index], entry)
  }
  return [next, undefined]
}

export function addEntries(
  book: readonly StoredContact[],
  entries: readonly Contact[],
  id: () => string,
): Changed<void> {
  for (const entry of entries) validateDuplicateEntry(book, entry)
  return [[...book, ...entries.map((entry) => added(entry, id))], undefined]
}

/**
 * Adds another book's contacts, skipping each one this book already holds by address or tag. A
 * skipped L2 contact's addresses join the held contact's `retiredAddresses`, so its history still
 * shows. An L2 contact whose name another contact holds falls back to its tag; wallet names may
 * repeat. Returns how many were added.
 */
export function importContacts(
  book: readonly StoredContact[],
  entries: readonly unknown[],
  id: () => string,
): Changed<number> {
  const next = [...book]
  let count = 0
  for (const candidate of entries) {
    if (!isValidContact(candidate)) continue
    const heldIndex = next.findIndex((e) => sameTag(e, candidate))
    if (heldIndex !== -1) {
      next[heldIndex] = withRetiredAddresses(next[heldIndex], candidate)
      continue
    }
    if (next.some((e) => sameAddressIdentity(e, candidate))) continue
    const taken = (name: string) => next.some((e) => normalizeName(e.name) === normalizeName(name))
    let entry = candidate
    if (addressKindOf(entry) !== "ethereum-l1" && taken(entry.name)) {
      if (!entry.tag || taken(entry.tag)) continue
      entry = { ...entry, name: entry.tag }
    }
    next.push(added(entry, id))
    count++
  }
  return [next, count]
}

/** `held` with `from`'s L2 addresses among its retired ones, when both are L2 rows. */
function withRetiredAddresses(held: StoredContact, from: Contact): StoredContact {
  if (addressKindOf(held) !== "aztec-l2" || addressKindOf(from) !== "aztec-l2") return held
  const known = new Set([held.address, ...(held.retiredAddresses ?? [])].map(normalizeAddress))
  const fresh: string[] = []
  for (const address of [from.address, ...(from.retiredAddresses ?? [])]) {
    if (known.has(normalizeAddress(address))) continue
    known.add(normalizeAddress(address))
    fresh.push(address)
  }
  if (fresh.length === 0) return held
  return { ...held, retiredAddresses: [...(held.retiredAddresses ?? []), ...fresh] }
}

/**
 * Points the L2 contact with `tag` at `l2Address`, unless another contact holds that address. The
 * old address joins `retiredAddresses`.
 */
export function updateL2Address(
  book: readonly StoredContact[],
  tag: string,
  l2Address: string,
): Changed<void> {
  const needle = tag.toLowerCase()
  const index = book.findIndex(
    (e) => addressKindOf(e) === "aztec-l2" && e.tag?.toLowerCase() === needle,
  )
  if (index === -1) return [[...book], undefined]
  const address = normalizeAddress(l2Address)
  if (normalizeAddress(book[index].address) === address) return [[...book], undefined]
  if (book.some((e) => addressKindOf(e) === "aztec-l2" && normalizeAddress(e.address) === address))
    return [[...book], undefined]
  const next = [...book]
  const { address: retired, retiredAddresses = [] } = next[index]
  next[index] = {
    ...next[index],
    address: l2Address,
    retiredAddresses: [...retiredAddresses, retired],
  }
  return [next, undefined]
}

/**
 * Auto-attestation upsert. Identity-merges by `(provider, addressLower)`
 * (`sameL1WalletIdentity`). This path **does not** run cross-kind
 * name uniqueness — blocking a deposit-attest because the user happens to
 * have an L2 contact with the same name would silently break the
 * deposit→withdraw recall product principle. User-initiated paths
 * (`addEntry`, `modifyEntry`) still validate names.
 */
export function upsertL1WalletContact(
  book: readonly StoredContact[],
  input: UpsertL1WalletContactInput,
  now: number,
  id: () => string,
): Changed<Contact> {
  const incoming: Contact = {
    name: input.name,
    address: input.address,
    addressKind: "ethereum-l1",
    avatar: input.avatar ?? (input.imageUrl ? { type: "image", url: input.imageUrl } : undefined),
    l1Wallet: {
      provider: input.provider,
      walletId: input.walletId,
      walletName: input.walletName,
      imageUrl: input.imageUrl,
      provenance: input.provenance,
      userLabeled: input.userLabeled,
      lastUsedAt: input.lastUsedAt ?? now,
    },
  }
  // A generic-provider row (a "manual" saved recipient / "unknown" deposit) collapses into any
  // same-address row, so a user-saved label and a later deposit attestation for one address merge
  // into one contact (`mergeL1Contacts` keeps the user label and takes the real provider).
  const next = [...book]
  const existingIndex = next.findIndex((entry) => sameL1WalletIdentity(entry, incoming))
  if (existingIndex === -1) {
    next.push(added(incoming, id))
    return [next, incoming]
  }
  const merged = mergeL1Contacts(next[existingIndex], incoming)
  next[existingIndex] = merged
  return [next, merged]
}

/** Names an L1 contact only if it is still live and unlabeled: one renamed or removed stays so. */
export function nameUnlabeledL1Contact(
  book: readonly StoredContact[],
  identity: { address: string; provider: string },
  name: string,
): Changed<boolean> {
  const probe: Contact = {
    name,
    address: identity.address,
    addressKind: "ethereum-l1",
    l1Wallet: { provider: identity.provider, provenance: "saved-recipient" },
  }
  const index = book.findIndex((entry) => sameL1WalletIdentity(entry, probe))
  const entry = book[index]
  if (!entry || isDeletedL1(entry) || isUserLabel(entry.name)) return [[...book], false]
  const next = [...book]
  next[index] = { ...entry, name }
  return [next, true]
}

/**
 * User edit of an L1 wallet row (label and/or address), keyed by L1 identity
 * `(provider, originalAddress)`. Rewrites the row in place; when the address
 * changed, the prior address is recorded in `replacedAddresses` so
 * deposit-history echoes of it stop surfacing. A row backed only by deposit
 * history (no contact) is created as a fresh `saved-recipient` entry. Like
 * `upsertL1WalletContact`, this path skips name uniqueness — L1 rows
 * key on `(provider, address)` only. Throws when the new address collides
 * with a different existing L1 row.
 */
export function updateL1WalletContact(
  book: readonly StoredContact[],
  input: UpdateL1WalletContactInput,
  now: number,
  id: () => string,
): Changed<Contact> {
  const trimmedName = input.name.trim()
  const name = isUserLabel(trimmedName) ? trimmedName : L1_PLACEHOLDER_NAME
  const userLabeled = isUserLabel(trimmedName) ? true : undefined
  const addressChanged = normalizeAddress(input.originalAddress) !== normalizeAddress(input.address)

  const identity: ContactIdentity = {
    address: input.originalAddress,
    addressKind: "ethereum-l1",
    provider: input.provider,
  }
  // Prefer a live row — the picker only offers live rows for editing, so a
  // tombstone match is a fallback (and an edit revives it, see below).
  const liveIndex = book.findIndex(
    (entry) => matchesIdentity(entry, identity) && !isDeletedL1(entry),
  )
  const index =
    liveIndex !== -1 ? liveIndex : book.findIndex((entry) => matchesIdentity(entry, identity))

  if (index === -1) {
    const created: Contact = {
      name,
      address: input.address,
      addressKind: "ethereum-l1",
      l1Wallet: {
        provider: input.provider,
        provenance: "saved-recipient",
        userLabeled,
        lastUsedAt: now,
      },
    }
    const [kept, absorbed] = absorbDeletedL1Collisions(book, created)
    const replaced = new Set(absorbed)
    if (addressChanged) replaced.add(normalizeAddress(input.originalAddress))
    replaced.delete(normalizeAddress(input.address))
    created.l1Wallet!.replacedAddresses = replaced.size > 0 ? [...replaced] : undefined
    return [[...kept, added(created, id)], created]
  }

  const original = book[index]
  const wallet = original.l1Wallet as ContactL1Wallet
  const replaced = new Set(wallet.replacedAddresses ?? [])
  let next = [...book]
  if (addressChanged) {
    replaced.add(normalizeAddress(original.address))
    const [kept, absorbed] = absorbDeletedL1Collisions(
      book,
      { ...original, address: input.address },
      original,
    )
    next = kept
    for (const address of absorbed) replaced.add(address)
    // The new address is live again (A→B→A round-trip) — stop suppressing it.
    replaced.delete(normalizeAddress(input.address))
  }
  const updated: StoredContact = {
    ...original,
    name,
    address: input.address,
    l1Wallet: {
      ...wallet,
      userLabeled,
      replacedAddresses: replaced.size > 0 ? [...replaced] : undefined,
      // A user edit is a use — it revives a tombstoned row.
      deletedAt: undefined,
    },
  }
  next[next.indexOf(original)] = updated
  return [next, updated]
}

/**
 * Collision handling for a rewritten/created L1 row: a LIVE row with the
 * same identity is a real conflict (throws); tombstoned rows are absorbed —
 * their address is live again under the new row, which inherits their
 * `replacedAddresses` (returned for the caller to union in).
 */
function absorbDeletedL1Collisions(
  book: readonly StoredContact[],
  candidate: Contact,
  exclude?: Contact,
): [kept: StoredContact[], replaced: string[]] {
  const colliders = book.filter(
    (entry) => entry !== exclude && sameL1WalletIdentity(entry, candidate),
  )
  if (colliders.some((entry) => !isDeletedL1(entry))) {
    throw new WalletError("contact.duplicate", "A saved wallet with this address already exists")
  }
  return [
    book.filter((entry) => !colliders.includes(entry)),
    colliders.flatMap((entry) => entry.l1Wallet?.replacedAddresses ?? []),
  ]
}

/**
 * No-op-on-duplicate contact add, for callers (the QR handshake scanner and receiver) that must not
 * throw when the contact already exists. Unlike `addEntry`, which throws on any address, tag or
 * name collision, it returns the existing entry unchanged when a row collides by address, tag or
 * normalized name, and otherwise adds the entry. It returns `entry` itself when it added it.
 *
 * A QR/link handshake hands over an identity the scanner chose to scan. A throw here would surface
 * as "Invalid QR code" with no add, or, on the receiver side, defer the connect-back so the driver
 * presents it again every poll. A collision is a no-op so the handshake loop ends.
 *
 * A pending handshake row upgrades to a real L2 row when a later scan or connect-back brings the
 * address. An entry without `autoAdded` approves an `autoAdded` row with the same address and tag;
 * a row with another tag stays as it is.
 */
export function addOrMergeContact(
  book: readonly StoredContact[],
  entry: Contact,
  id: () => string,
): Changed<Contact> {
  const existingIndex = book.findIndex((e) => collidesIdentity(e, entry))
  const existing = existingIndex === -1 ? undefined : book[existingIndex]
  const next = [...book]
  if (existing) {
    if (addressKindOf(existing) === "pending-handshake" && addressKindOf(entry) === "aztec-l2") {
      next[existingIndex] = replacing(existing, entry)
      return [next, entry]
    }
    const index = autoAddedIndex(book, entry)
    if (index !== -1 && sameTag(book[index], entry)) {
      const approved = withoutAutoAdded(book[index])
      next[index] = approved
      return [next, approved]
    }
    return [next, existing]
  }
  next.push(added(entry, id))
  return [next, entry]
}

/** Makes the wallet-added L2 row at `l2Address` a full contact. Undefined when there is none. */
export function approveAutoAdded(
  book: readonly StoredContact[],
  l2Address: string,
): Changed<Contact | undefined> {
  const needle = normalizeAddress(l2Address)
  const index = book.findIndex(
    (e) => e.autoAdded && addressKindOf(e) === "aztec-l2" && normalizeAddress(e.address) === needle,
  )
  if (index === -1) return [[...book], undefined]
  const next = [...book]
  const approved = withoutAutoAdded(book[index])
  next[index] = approved
  return [next, approved]
}

export function modifyEntry(
  book: readonly StoredContact[],
  entry: Contact,
  original: ContactIdentity,
): Changed<void> {
  const originalEntry = book.find((e) => matchesIdentity(e, original))
  if (!originalEntry) throw new WalletError("unknown", "Original entry not found")
  if (!sameAddressIdentity(originalEntry, entry)) {
    validateDuplicateEntry(book, entry, originalEntry)
  } else {
    validateDuplicateName(book, entry.name, originalEntry)
  }
  const next = [...book]
  next[next.indexOf(originalEntry)] = replacing(originalEntry, entry)
  return [next, undefined]
}

export function removeEntry(
  book: readonly StoredContact[],
  target: ContactIdentity,
): Changed<void> {
  return [book.filter((entry) => !matchesIdentity(entry, target)), undefined]
}

/** A book change: `now` is the wall time, `id` mints ids for the contacts it adds. */
type BookChange<T> = (book: readonly StoredContact[], now: number, id: () => string) => Changed<T>

/**
 * The account's contact book. Every change reads the saved book, applies one rule above, and saves
 * the records it changed in one write.
 */
export interface Contacts {
  /** Settles once the open's migration is saved. */
  readonly ready: Promise<void>
  /** The book, in book order. */
  readonly view: ReadonlyStore<RecordSet<StoredContact>>
  /** The book once read; rejects when the read failed. */
  all(): Promise<readonly StoredContact[]>
  addEntry(entry: Contact): Promise<void>
  addEntries(entries: readonly Contact[]): Promise<void>
  importContacts(entries: readonly unknown[]): Promise<number>
  updateL2Address(tag: string, l2Address: string): Promise<void>
  upsertL1WalletContact(input: UpsertL1WalletContactInput): Promise<Contact>
  nameUnlabeledL1Contact(
    identity: { address: string; provider: string },
    name: string,
  ): Promise<boolean>
  updateL1WalletContact(input: UpdateL1WalletContactInput): Promise<Contact>
  addOrMergeContact(entry: Contact): Promise<Contact>
  approveAutoAdded(l2Address: string): Promise<Contact | undefined>
  modifyEntry(entry: Contact, original: ContactIdentity): Promise<void>
  removeEntry(target: ContactIdentity): Promise<void>
}

const PREFIX = "acct/contacts"

export function createContacts({
  db,
  now,
}: {
  /** The account's database. */
  db: Database
  now: () => number
}): Contacts {
  const store = persistentStore<StoredContact>(db, {
    prefix: PREFIX,
    version: 1,
    id: (contact) => contact.id,
    migrate: (from, w) => migrateContacts(from, w, PREFIX),
    load: "all",
  })
  const change = async <T>(rule: BookChange<T>): Promise<T> => {
    await store.ready
    return db.write(async (w) => {
      const saved = (await db.range(`${PREFIX}/`)).map(
        ([, raw]) => decodeRecord(raw) as StoredContact,
      )
      const at = now()
      const [book, result] = rule(saved, at, contactIds(saved, at))
      const before = new Map(saved.map((contact) => [contact.id, contact]))
      for (const contact of book) {
        if (before.get(contact.id) !== contact) await store.put(contact, w)
        before.delete(contact.id)
      }
      for (const id of before.keys()) await store.remove(id, w)
      return result
    })
  }
  return {
    ready: store.ready,
    view: store.view,
    all: () => loadRecords(store.view),
    addEntry: (entry) => change((book, _, id) => addEntry(book, entry, id)),
    addEntries: (entries) => change((book, _, id) => addEntries(book, entries, id)),
    importContacts: (entries) => change((book, _, id) => importContacts(book, entries, id)),
    updateL2Address: (tag, address) => change((book) => updateL2Address(book, tag, address)),
    upsertL1WalletContact: (input) =>
      change((book, at, id) => upsertL1WalletContact(book, input, at, id)),
    nameUnlabeledL1Contact: (identity, name) =>
      change((book) => nameUnlabeledL1Contact(book, identity, name)),
    updateL1WalletContact: (input) =>
      change((book, at, id) => updateL1WalletContact(book, input, at, id)),
    addOrMergeContact: (entry) => change((book, _, id) => addOrMergeContact(book, entry, id)),
    approveAutoAdded: (address) => change((book) => approveAutoAdded(book, address)),
    modifyEntry: (entry, original) => change((book) => modifyEntry(book, entry, original)),
    removeEntry: (target) => change((book) => removeEntry(book, target)),
  }
}

/**
 * The contacts a database no contacts store is open on holds, such as a retired rollup's: this
 * store's records in book order once it opened there, else the legacy blob's entries, unchecked.
 */
export function storedContacts(db: {
  get(key: string): string | null | undefined
  keys(prefix: string): string[]
}): unknown[] {
  if (typeof db.get("acct/meta/contacts") === "string") {
    return db
      .keys(`${PREFIX}/`)
      .sort()
      .flatMap((key) => {
        const raw = db.get(key)
        return typeof raw === "string" ? [decodeRecord(raw)] : []
      })
  }
  const raw = db.get(CONTACT_STORAGE_KEY)
  if (raw === null || raw === undefined) return []
  const book = legacyBook(raw)
  if (!book) logger.warn("[historicContacts] a retired database holds a malformed contact book")
  return book ?? []
}

export interface ContactRow {
  id: string
  name: string
  tag: string
  address: string
  addressKind: "aztec-l2" | "ethereum-l1"
  provider?: string
  provenance?: "deposit-attested" | "saved-recipient"
  /** See `Contact.autoAdded`. */
  autoAdded?: boolean
}

/** Whether a contact shows in the payment directory: L1 wallets and tagged L2 contacts. */
export function isPaymentContactEntry(entry: Contact): boolean {
  const addressKind = entry.addressKind ?? "aztec-l2"
  if (!entry.address) return false
  // A token mint is not a routable wallet: hide a zero-address contact an older build saved.
  if (isZeroAddress(entry.address)) return false
  // A wallet the user removed stays saved as a tombstone (`ContactL1Wallet.deletedAt`).
  if (entry.l1Wallet?.deletedAt !== undefined) return false
  return addressKind === "ethereum-l1" || (addressKind === "aztec-l2" && !!entry.tag)
}

export function contactRowFromEntry(entry: Contact): ContactRow {
  const isL1 = (entry.addressKind ?? "aztec-l2") === "ethereum-l1"
  // `isPaymentContactEntry` gates this map, so a non-L1 entry is a tagged L2 contact.
  const addressKind: "aztec-l2" | "ethereum-l1" = isL1 ? "ethereum-l1" : "aztec-l2"
  const tag = isL1 ? shortenAddressSm(entry.address) : entry.tag!
  const provider = entry.l1Wallet?.provider ?? "unknown"

  return {
    id: isL1 ? `l1:${provider}:${entry.address.toLowerCase()}` : entry.tag!,
    name: entry.name,
    tag,
    address: entry.address,
    addressKind,
    provider: entry.l1Wallet?.provider,
    provenance: entry.l1Wallet?.provenance,
    ...(entry.autoAdded && { autoAdded: true }),
  }
}

/** The payment directory over the book. `hydrated`: a read landed; `failed`: the last one failed. */
export interface ContactDirectory {
  contacts: ContactRow[]
  hydrated: boolean
  failed: boolean
}

export function selectContactDirectory(book: RecordSet<Contact>): ContactDirectory {
  return {
    contacts: book.records.filter(isPaymentContactEntry).map(contactRowFromEntry),
    hydrated: book.loaded,
    failed: book.failed,
  }
}
