import { describe, expect, it } from "vitest"
import {
  createContacts,
  selectContactDirectory,
  storedContacts,
  type Contact,
  type StoredContact,
} from "../../src/engine/contacts"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { encodeRecord, timeKey } from "../../src/engine/persistentStore"
import { CONTACT_STORAGE_KEY } from "../../src/storageMigrations/contacts"

const NS = "obsidion.acct."
const BLOB = NS + CONTACT_STORAGE_KEY
const L1 = "0x" + "11".repeat(20)
const ALICE = "alice"
const BOB = "bob"

const alice: Contact = { name: ALICE, address: "0x" + "a1".repeat(32), tag: ALICE }
const bob: Contact = { name: BOB, address: "0x" + "b0".repeat(32), tag: BOB }
const wallet = (provider: string, provenance: "saved-recipient" | "deposit-attested"): Contact => ({
  name: provider,
  address: L1,
  addressKind: "ethereum-l1",
  l1Wallet: { provider, provenance },
})

/** A contacts store over `entries`, on the account namespace. */
function open(entries = new Map<string, string>(), now = () => 5_000) {
  const db = openDatabase(memoryBackend(entries)).scoped(NS)
  return { entries, contacts: createContacts({ db, now }) }
}

const seeded = (blob: string) => new Map([[BLOB, blob]])
const ids = (book: readonly StoredContact[]) => book.map((c) => c.id)

describe("the contacts storage migration", () => {
  it("opens an empty book when no blob is saved", async () => {
    const { contacts } = open()
    expect(await contacts.all()).toEqual([])
    expect(contacts.view.get()).toEqual({ records: [], loaded: true, failed: false })
  })

  it("carries the blob in book order, keyed by place, with duplicate L1 rows merged", async () => {
    const saved = wallet("manual", "saved-recipient")
    const attested = wallet("metamask", "deposit-attested")
    const { contacts, entries } = open(seeded(JSON.stringify([saved, bob, alice, attested])))
    const book = await contacts.all()
    expect(ids(book)).toEqual([timeKey(0), timeKey(1), timeKey(2)])
    expect(book.map((c) => c.tag ?? c.l1Wallet?.provider)).toEqual(["metamask", BOB, ALICE])
    expect(book[0].l1Wallet?.provenance).toBe("deposit-attested")
    expect(entries.get(BLOB)).toBeDefined()
  })

  it.each([
    ["does not parse", "{not-json"],
    ["is not a list", JSON.stringify({ sandbox: [alice] })],
  ])("fails the open and keeps the bytes when the blob %s", async (_, blob) => {
    const { contacts, entries } = open(seeded(blob))
    await expect(contacts.ready).rejects.toBeDefined()
    expect(contacts.view.get().failed).toBe(true)
    await expect(contacts.all()).rejects.toBeDefined()
    expect(entries.get(BLOB)).toBe(blob)
    expect([...entries.keys()].some((key) => key.startsWith(`${NS}acct/contacts/`))).toBe(false)
  })

  it("skips an invalid entry, carries the rest, and leaves the blob as it was", async () => {
    const blob = JSON.stringify([alice, { name: "", address: "0x1" }, { ...bob, tag: 7 }, bob])
    const { contacts, entries } = open(seeded(blob))
    const book = await contacts.all()
    expect(book.map((c) => [c.id, c.tag])).toEqual([
      [timeKey(0), ALICE],
      [timeKey(3), BOB],
    ])
    expect(entries.get(BLOB)).toBe(blob)
  })

  it("changes nothing on a second open", async () => {
    const { contacts, entries } = open(seeded(JSON.stringify([alice])))
    await contacts.ready
    const first = new Map(entries)
    entries.set(BLOB, JSON.stringify([alice, bob]))
    const again = open(entries).contacts
    expect(ids(await again.all())).toEqual([timeKey(0)])
    entries.set(BLOB, first.get(BLOB)!)
    expect(entries).toEqual(first)
  })
})

describe("the contact book", () => {
  it("keeps book order: the first of two L1 rows for one address is the one a generic edit finds", async () => {
    const { contacts } = open(
      seeded(
        JSON.stringify([
          wallet("metamask", "saved-recipient"),
          wallet("rainbow", "saved-recipient"),
        ]),
      ),
    )
    const label = "Savings"
    await contacts.updateL1WalletContact({
      originalAddress: L1,
      provider: "manual",
      address: L1,
      name: label,
    })
    const book = await contacts.all()
    expect(book.map((c) => [c.l1Wallet?.provider, c.name])).toEqual([
      ["metamask", label],
      ["rainbow", "rainbow"],
    ])
  })

  it("adds new contacts after every saved one, even when the clock runs behind", async () => {
    let clock = 9_000
    const { contacts } = open(seeded(JSON.stringify([alice])), () => clock)
    await contacts.addEntry(bob)
    clock = 1
    await contacts.addOrMergeContact({
      name: "carol",
      address: "0x" + "c0".repeat(32),
      tag: "carol",
    })
    const book = await contacts.all()
    expect(ids(book)).toEqual([timeKey(0), timeKey(9_000), timeKey(9_001)])
  })

  it("saves only the records a change touched, in one commit", async () => {
    const { contacts, entries } = open()
    await contacts.addEntries([alice, bob])
    const before = new Map(entries)
    await contacts.approveAutoAdded(alice.address)
    expect(entries).toEqual(before)
    await contacts.modifyEntry({ ...bob, name: "Bobby" }, { address: bob.address })
    const changed = [...entries].filter(([key, value]) => before.get(key) !== value)
    expect(changed.map(([key]) => key)).toEqual([`${NS}acct/contacts/${timeKey(5_001)}`])
  })

  it("removes a contact's record", async () => {
    const { contacts } = open()
    await contacts.addEntries([alice, bob])
    await contacts.removeEntry({ address: alice.address.toUpperCase() })
    expect((await contacts.all()).map((c) => c.tag)).toEqual([BOB])
  })

  it("rejects a refused change and saves nothing", async () => {
    const { contacts, entries } = open()
    await contacts.addEntry(alice)
    const before = new Map(entries)
    await expect(contacts.addEntry({ ...bob, tag: ALICE })).rejects.toMatchObject({
      code: "contact.duplicate",
    })
    expect(entries).toEqual(before)
  })
})

describe("storedContacts", () => {
  /** A reader that, like a storage adapter, answers null for a missing key. */
  const db = (entries: Record<string, string>) => ({
    get: (key: string) => entries[key] ?? null,
    keys: (prefix: string) => Object.keys(entries).filter((key) => key.startsWith(prefix)),
  })

  it("reads the blob where no contacts store opened", () => {
    expect(storedContacts(db({ [CONTACT_STORAGE_KEY]: JSON.stringify([alice, 3]) }))).toEqual([
      alice,
      3,
    ])
  })

  it("reads an empty book once the store opened and every contact was removed", () => {
    const blob = JSON.stringify([alice])
    expect(storedContacts(db({ "acct/meta/contacts": "1", [CONTACT_STORAGE_KEY]: blob }))).toEqual(
      [],
    )
  })

  it("reads nothing from a blob that does not parse", () => {
    expect(storedContacts(db({ [CONTACT_STORAGE_KEY]: "{" }))).toEqual([])
    expect(storedContacts(db({}))).toEqual([])
  })

  it("reads the store's records in book order once it opened, not the blob it left", () => {
    const record = (c: Contact, i: number) => ({ ...c, id: timeKey(i) })
    expect(
      storedContacts(
        db({
          [`acct/contacts/${timeKey(1)}`]: encodeRecord(record(bob, 1)),
          [`acct/contacts/${timeKey(0)}`]: encodeRecord(record(alice, 0)),
          "acct/meta/contacts": "1",
          [CONTACT_STORAGE_KEY]: JSON.stringify([wallet("manual", "saved-recipient")]),
        }),
      ),
    ).toEqual([record(alice, 0), record(bob, 1)])
  })
})

describe("selectContactDirectory", () => {
  it("lists the payable contacts and carries the book's read state", () => {
    const removed: Contact = {
      ...wallet("rabby", "saved-recipient"),
      l1Wallet: { provider: "rabby", provenance: "saved-recipient", deletedAt: 1 },
    }
    const untagged: Contact = { name: "nobody", address: bob.address }
    const records = [alice, untagged, removed, wallet("metamask", "deposit-attested")]
    const directory = selectContactDirectory({ records, loaded: true, failed: false })
    expect(directory.contacts.map((c) => [c.id, c.addressKind])).toEqual([
      [ALICE, "aztec-l2"],
      [`l1:metamask:${L1}`, "ethereum-l1"],
    ])
    expect([directory.hydrated, directory.failed]).toEqual([true, false])
    const failed = selectContactDirectory({ records: [], loaded: false, failed: true })
    expect(failed).toEqual({ contacts: [], hydrated: false, failed: true })
  })
})
