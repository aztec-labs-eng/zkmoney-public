import { beforeEach, describe, expect, it } from "vitest"
import {
  CONTACT_STORAGE_KEY,
  ContactStorage,
  HISTORIC_CONTACTS_IMPORTED_KEY,
  importHistoricContacts,
  retiredDatabaseOf,
  type Contact,
  type RetiredDatabase,
} from "../../src/core"
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

const readOf =
  (dbs: RetiredDatabase[]) =>
  <T>(read: (db: RetiredDatabase) => T) =>
    Promise.resolve(dbs.map(read))

describe("importHistoricContacts", () => {
  let storage: InMemoryStorageAdapter
  let contacts: ContactStorage

  beforeEach(() => {
    ContactStorage.resetForTests()
    storage = new InMemoryStorageAdapter()
    contacts = ContactStorage.get(storage)
  })

  const run = (dbs: RetiredDatabase[]) =>
    importHistoricContacts({ storage, readOtherDatabases: readOf(dbs), contacts })

  it("carries tagged L2 contacts and wallet contacts, and leaves the rest behind", async () => {
    expect(await run([book("5", [alice, wallet, tagless, pending])])).toBe(2)
    expect(await contacts.getEntries()).toEqual([alice, wallet])
  })

  it("runs once per account", async () => {
    await run([book("5", [alice])])
    await contacts.removeEntry({ address: V5_ALICE })
    expect(await run([book("5", [alice])])).toBeNull()
    expect(await contacts.getEntries()).toEqual([])
  })

  it("keeps a held tag's row and adds the imported address to its retired ones", async () => {
    const upgraded = { ...alice, name: "Alice", address: V6_ALICE }
    await contacts.addEntry(upgraded)
    expect(await run([book("5", [{ ...alice, tag: "Alice" }])])).toBe(0)
    expect(await contacts.getEntries()).toEqual([{ ...upgraded, retiredAddresses: [V5_ALICE] }])
  })

  it("keeps every retired address of a tag held in several books", async () => {
    const V4_ALICE = "0x" + "a4".repeat(32)
    await run([book("4", [{ ...alice, address: V4_ALICE }]), book("5", [alice])])
    expect(await contacts.getEntries()).toEqual([
      { ...alice, address: V4_ALICE, retiredAddresses: [V5_ALICE] },
    ])
  })

  it("names a contact by its tag when another contact holds its name", async () => {
    await contacts.addEntry({ name: "Ali", address: V6_ALICE, tag: "ali" })
    await run([book("5", [{ ...alice, name: "Ali" }])])
    expect((await contacts.getEntries()).map((c) => c.name)).toEqual(["Ali", "alice"])
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
    expect(await contacts.getEntries()).toEqual([])
    expect(await storage.getItem(HISTORIC_CONTACTS_IMPORTED_KEY)).toBeNull()
  })
})

describe("ContactStorage.updateL2Address", () => {
  let contacts: ContactStorage

  beforeEach(() => {
    ContactStorage.resetForTests()
    contacts = ContactStorage.get(new InMemoryStorageAdapter())
  })

  it("points the tag's contact at its new address", async () => {
    await contacts.addEntry(alice)
    await contacts.updateL2Address("ALICE", V6_ALICE)
    expect(await contacts.getEntries()).toEqual([
      { ...alice, address: V6_ALICE, retiredAddresses: [V5_ALICE] },
    ])
  })

  it("leaves it when another contact holds the address", async () => {
    await contacts.addEntry(alice)
    await contacts.addEntry({ name: "other", address: V6_ALICE, tag: "other" })
    await contacts.updateL2Address("alice", V6_ALICE)
    expect((await contacts.getEntries())[0].address).toBe(V5_ALICE)
  })
})
