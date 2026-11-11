/**
 * Storage migration: the contact book older builds saved as one blob. Remove when no supported
 * build older than the one that writes `acct/contacts` v1 remains and the rollup migration
 * reads no legacy book.
 */
import { isValidContact, reconcileL1Duplicates, type StoredContact } from "../engine/contacts"
import type { Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { encodeRecord, timeKey } from "../engine/persistentStore"

export const CONTACT_STORAGE_KEY = "obsidion_contacts"

/** The blob's entries, unchecked; undefined when it does not parse as a list. */
export function legacyBook(raw: string): unknown[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined // the decode boundary: the caller decides what an unreadable book means
  }
  return Array.isArray(parsed) ? parsed : undefined
}

/**
 * Version 1 carries the blob's valid entries in blob order, each keyed by its place in the blob,
 * with duplicate L1 rows merged into the first. The chain cannot give contacts back. A blob that
 * does not read as a list fails the open; an invalid entry is skipped. The blob is never written
 * again and stays for one release.
 */
export async function migrateContacts(
  from: number | undefined,
  w: Write,
  prefix: string,
): Promise<void> {
  if (from !== undefined) throw new WalletError("invariant", `contacts: unknown version ${from}`)
  const raw = await w.get(CONTACT_STORAGE_KEY)
  if (raw === undefined) return
  const book = legacyBook(raw)
  if (!book) throw new WalletError("unknown", "contacts: the saved book does not read as a list")
  const carried = book.flatMap((entry, index): StoredContact[] =>
    isValidContact(entry) ? [{ ...entry, id: timeKey(index) }] : [],
  )
  for (const contact of reconcileL1Duplicates(carried))
    w.put(`${prefix}/${contact.id}`, encodeRecord(contact))
}
