import { beforeEach, describe, expect, it } from "vitest"
import {
  HISTORIC_CONTACTS_IMPORTED_KEY,
  importHistoricContacts,
  retiredDatabaseOf,
  type RetiredDatabase,
} from "../../src/core"
import { createContacts, type Contact, type Contacts } from "../../src/engine/contacts"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { encodeRecord, timeKey } from "../../src/engine/persistentStore"
import { CONTACT_STORAGE_KEY } from "../../src/storageMigrations/contacts"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"

const V5_ALICE = "0x" + "a5".repeat(32)
const V6_ALICE = "0x" + "a6".repeat(32)

const alice: Contact = { name: "alice", address: V5_ALICE, tag: "alice", verified: true }
const wallet: Contact = {
  name: "Cold wallet",
  address: "0x" + "11".repeat(20),
  addressKind: "ethereum-l1",
  l1Wallet: { provider: "metamask", provenance: "saved-recipient", userLabeled: true },
}
const tagless: Contact = { name: "0xbob", address: "0x" + "b0".repeat(32) }
const pending: Contact = {
  name: "carol",
  address: "0x" + "c0".repeat(20),
  addressKind: "pending-handshake",
  provenance: "qr-scan",
  tag: "carol",
}

const book = (version: string, contacts: unknown) =>
  retiredDatabaseOf(version, { [CONTACT_STORAGE_KEY]: JSON.stringify(contacts) })

/** A retired database a contacts store opened on: its records, and the blob it left behind. */
const recordsBook = (version: string, contacts: Contact[], blob: unknown[] = []) =>
  retiredDatabaseOf(version, {
    [CONTACT_STORAGE_KEY]: JSON.stringify(blob),
    "acct/meta/contacts": "1",
    // Saved out of order: the book reads in id order.
    ...Object.fromEntries(
      contacts
        .map((c, i) => [`acct/contacts/${timeKey(i)}`, encodeRecord({ ...c, id: timeKey(i) })])
        .reverse(),
    ),
  })

const readOf =
  (dbs: RetiredDatabase[]) =>
  <T>(read: (db: RetiredDatabase) => T) =>
    Promise.resolve(dbs.map(read))

const openContacts = () =>
  createContacts({ db: openDatabase(memoryBackend()), now: () => Date.now() })
/** The book without its ids. */
const entries = async (contacts: Contacts) =>
  (await contacts.all()).map(({ id, ...contact }) => (void id, contact))

describe("importHistoricContacts", () => {
  let storage: InMemoryStorageAdapter
  let contacts: Contacts

  beforeEach(() => {
    storage = new InMemoryStorageAdapter()
    contacts = openContacts()
  })

  const run = (dbs: RetiredDatabase[]) =>
    importHistoricContacts({ storage, readOtherDatabases: readOf(dbs), contacts })

  it("carries tagged L2 contacts and wallet contacts, and leaves the rest behind", async () => {
    expect(await run([book("5", [alice, wallet, tagless, pending])])).toBe(2)
    expect(await entries(contacts)).toEqual([alice, wallet])
  })

  it("runs once per account", async () => {
    await run([book("5", [alice])])
    await contacts.removeEntry({ address: V5_ALICE })
    expect(await run([book("5", [alice])])).toBeNull()
    expect(await entries(contacts)).toEqual([])
  })

  it("keeps a held tag's row and adds the imported address to its retired ones", async () => {
    const upgraded = { ...alice, name: "Alice", address: V6_ALICE }
    await contacts.addEntry(upgraded)
    expect(await run([book("5", [{ ...alice, tag: "Alice" }])])).toBe(0)
    expect(await entries(contacts)).toEqual([{ ...upgraded, retiredAddresses: [V5_ALICE] }])
  })

  it("keeps every retired address of a tag held in several books", async () => {
    const V4_ALICE = "0x" + "a4".repeat(32)
    await run([book("4", [{ ...alice, address: V4_ALICE }]), book("5", [alice])])
    expect(await entries(contacts)).toEqual([
      { ...alice, address: V4_ALICE, retiredAddresses: [V5_ALICE] },
    ])
  })

  it("names a contact by its tag when another contact holds its name", async () => {
    await contacts.addEntry({ name: "Ali", address: V6_ALICE, tag: "ali" })
    await run([book("5", [{ ...alice, name: "Ali" }])])
    expect((await entries(contacts)).map((c) => c.name)).toEqual(["Ali", "alice"])
  })

  it("keeps wallet contacts that share a name", async () => {
    const other = { ...wallet, address: "0x" + "22".repeat(20) }
    expect(await run([book("5", [wallet, other])])).toBe(2)
  })

  it("leaves no marker when a database cannot be read", async () => {
    await expect(
      importHistoricContacts({
        storage,
        readOtherDatabases: () => Promise.reject(new Error("held by another tab")),
        contacts,
      }),
    ).rejects.toThrow("held by another tab")
    expect(await storage.getItem(HISTORIC_CONTACTS_IMPORTED_KEY)).toBeNull()
  })

  it("reads a book a contacts store kept, not the blob it left behind", async () => {
    const stale = { ...wallet, address: "0x" + "33".repeat(20) }
    expect(await run([recordsBook("5", [alice, wallet], [stale])])).toBe(2)
    expect(await entries(contacts)).toEqual([alice, wallet])
  })

  it("skips a malformed book", async () => {
    const broken = retiredDatabaseOf("4", { [CONTACT_STORAGE_KEY]: "{" })
    expect(await run([broken, book("5", [alice])])).toBe(1)
  })

  it("writes nothing once the account changed", async () => {
    await expect(
      importHistoricContacts({
        storage,
        readOtherDatabases: readOf([book("5", [alice])]),
        contacts,
        ownsStorage: () => false,
      }),
    ).rejects.toThrow("the account changed")
    expect(await entries(contacts)).toEqual([])
    expect(await storage.getItem(HISTORIC_CONTACTS_IMPORTED_KEY)).toBeNull()
  })
})

describe("Contacts.updateL2Address", () => {
  let contacts: Contacts

  beforeEach(() => {
    contacts = openContacts()
  })

  it("points the tag's contact at its new address", async () => {
    await contacts.addEntry(alice)
    await contacts.updateL2Address("ALICE", V6_ALICE)
    expect(await entries(contacts)).toEqual([
      { ...alice, address: V6_ALICE, retiredAddresses: [V5_ALICE] },
    ])
  })

  it("leaves it when another contact holds the address", async () => {
    await contacts.addEntry(alice)
    await contacts.addEntry({ name: "other", address: V6_ALICE, tag: "other" })
    await contacts.updateL2Address("alice", V6_ALICE)
    expect((await entries(contacts))[0].address).toBe(V5_ALICE)
  })
})
