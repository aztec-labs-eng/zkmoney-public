/**
 * The account's contacts from the wallet databases this browser kept for retired rollups, carried
 * into the active book once per account. An L2 contact needs its tag: only the tag finds the
 * person's address once they upgrade.
 */
import type { IStorageAdapter } from "../storages/adapter"
import { storedContacts, type Contact, type Contacts } from "../../engine/contacts"
import type { RetiredDatabase } from "./historicActivityImport"

export const HISTORIC_CONTACTS_IMPORTED_KEY = "@obsidion/historic-contacts/imported/v1"

export interface HistoricContactsImportDeps {
  /** The account's storage on the active rollup, where the marker lives. */
  // eslint-disable-next-line local/legacy-store -- ZKM-1625
  storage: IStorageAdapter
  /** `read` over each retired rollup's database; rejects when one could not be read. */
  readOtherDatabases<T>(read: (db: RetiredDatabase) => T): Promise<T[]>
  contacts: Pick<Contacts, "importContacts">
  /** Whether the account the import started for is still the active one; false stops it before a write. */
  ownsStorage?: () => boolean
  /** Runs the writes while no account switch may commit; absent, they run as they are. */
  holdSession?: <T>(fn: () => Promise<T>) => Promise<T>
}

/** Imports once per account and returns how many contacts were added; null when already done. */
export async function importHistoricContacts(
  deps: HistoricContactsImportDeps,
): Promise<number | null> {
  if ((await deps.storage.getItem(HISTORIC_CONTACTS_IMPORTED_KEY)) !== null) return null
  const books = await deps.readOtherDatabases((db) => storedContacts(db))
  const writes = async () => {
    if (deps.ownsStorage && !deps.ownsStorage()) {
      throw new Error("the account changed during the import")
    }
    const added = await deps.contacts.importContacts(books.flat().filter(carriesOver))
    await deps.storage.setItem(HISTORIC_CONTACTS_IMPORTED_KEY, String(Date.now()))
    return added
  }
  return deps.holdSession ? deps.holdSession(writes) : writes()
}

function carriesOver(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Partial<Contact>
  if (entry.addressKind === "ethereum-l1") return true
  return (entry.addressKind ?? "aztec-l2") === "aztec-l2" && !!entry.tag
}
