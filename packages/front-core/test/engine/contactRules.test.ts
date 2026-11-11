import { describe, expect, it } from "vitest"
import {
  addEntry,
  addOrMergeContact,
  approveAutoAdded,
  contactIds,
  importContacts,
  isValidContact,
  modifyEntry,
  removeEntry,
  updateL1WalletContact,
  upsertL1WalletContact,
  type Contact,
  type StoredContact,
} from "../../src/engine/contacts"
import { timeKey } from "../../src/engine/persistentStore"

const L1 = "0x" + "11".repeat(20)
const L1_NEW = "0x" + "22".repeat(20)
const A = "0x" + "a1".repeat(32)
const B = "0x" + "b0".repeat(32)
const ALICE = "alice"
const LABEL = "Savings"

const stored = (...contacts: Contact[]): StoredContact[] =>
  contacts.map((c, i) => ({ ...c, id: timeKey(i) }))
const ids = (book: readonly StoredContact[]) => contactIds(book, 100)
/** Each contact's fields that `after` names; a field it gives as undefined must be absent. */
const fields = (book: readonly StoredContact[], after: readonly Partial<StoredContact>[]) =>
  book.map((c, i) =>
    Object.fromEntries(Object.keys(after[i] ?? {}).map((k) => [k, c[k as keyof StoredContact]])),
  )
const l2 = (over: Partial<Contact> = {}): Contact => ({
  name: ALICE,
  address: A,
  tag: ALICE,
  ...over,
})
const l1 = (provider: string, over: Partial<NonNullable<Contact["l1Wallet"]>> = {}): Contact => ({
  name: provider,
  address: L1,
  addressKind: "ethereum-l1",
  l1Wallet: { provider, provenance: "saved-recipient", ...over },
})

describe("adding a person the wallet added", () => {
  it.each<[string, StoredContact[], Contact, Partial<StoredContact>[]]>([
    ["appends a new contact", stored(), l2(), [{ id: timeKey(100), tag: ALICE }]],
    [
      "approves the wallet's row with the same tag, in its place",
      stored(l2({ autoAdded: true })),
      l2({ name: LABEL }),
      [{ id: timeKey(0), name: ALICE, autoAdded: undefined }],
    ],
    [
      "replaces the wallet's row at that address when the tag changed",
      stored(l2({ autoAdded: true, tag: "old" })),
      l2(),
      [{ id: timeKey(0), tag: ALICE, autoAdded: undefined }],
    ],
  ])("%s", (_, book, entry, after) => {
    const [next] = addEntry(book, entry, ids(book))
    expect(fields(next, after)).toEqual(after)
  })

  it.each<[string, StoredContact[], Contact, string]>([
    [
      "refuses an address another contact holds",
      stored(l2()),
      l2({ name: "x", tag: "x" }),
      "contact.duplicate",
    ],
    [
      "refuses a tag another contact holds",
      stored(l2()),
      l2({ name: "x", address: B }),
      "contact.duplicate",
    ],
    [
      "refuses a name another contact holds",
      stored(l2()),
      l2({ address: B, tag: "x", name: " ALI CE" }),
      "contact.nameTaken",
    ],
    [
      "refuses a tag another row holds when replacing the wallet's row",
      stored(l2({ autoAdded: true, tag: "old" }), l2({ address: B, name: "b", tag: "b" })),
      l2({ tag: "b", name: "c" }),
      "contact.duplicate",
    ],
  ])("%s", (_, book, entry, code) => {
    expect(() => addEntry(book, entry, ids(book))).toThrow(expect.objectContaining({ code }))
  })
})

describe("addOrMergeContact", () => {
  it.each<[string, StoredContact[], Contact, Partial<StoredContact>[], "entry" | "held"]>([
    ["adds a new contact and returns it", stored(), l2(), [{ tag: ALICE }], "entry"],
    [
      "keeps a contact held by name",
      stored(l2()),
      l2({ address: B, tag: "x" }),
      [{ address: A }],
      "held",
    ],
    [
      "upgrades a pending handshake to the L2 contact",
      stored(l2({ address: L1, addressKind: "pending-handshake", provenance: "qr-scan" })),
      l2(),
      [{ id: timeKey(0), address: A, addressKind: undefined }],
      "entry",
    ],
    [
      "approves the wallet's row for an entry the user adds",
      stored(l2({ autoAdded: true })),
      l2(),
      [{ autoAdded: undefined }],
      "held",
    ],
    [
      "never approves for an entry the wallet adds",
      stored(l2({ autoAdded: true })),
      l2({ autoAdded: true }),
      [{ autoAdded: true }],
      "held",
    ],
    [
      "leaves the wallet's row with another tag unapproved",
      stored(l2({ autoAdded: true, tag: "old", name: "old" })),
      l2({ name: "old" }),
      [{ autoAdded: true }],
      "held",
    ],
  ])("%s", (_, book, entry, after, returned) => {
    const [next, result] = addOrMergeContact(book, entry, ids(book))
    expect(fields(next, after)).toEqual(after)
    if (returned === "entry") expect(result).toBe(entry)
    else expect(result).toEqual(next[0])
  })
})

describe("approveAutoAdded", () => {
  it.each<[string, StoredContact[], string, boolean]>([
    [
      "approves the wallet's L2 row at the address, in any case",
      stored(l2({ autoAdded: true })),
      A.toUpperCase(),
      true,
    ],
    ["finds none at another address", stored(l2({ autoAdded: true })), B, false],
    ["finds none for a contact the user added", stored(l2()), A, false],
  ])("%s", (_, book, address, approved) => {
    const [next, result] = approveAutoAdded(book, address)
    expect(result !== undefined).toBe(approved)
    expect(next[0].autoAdded).toBe(approved ? undefined : book[0].autoAdded)
  })
})

describe("merging L1 wallets", () => {
  const upsert = (book: StoredContact[], c: Contact, lastUsedAt: number) =>
    upsertL1WalletContact(
      book,
      {
        name: c.name,
        address: c.address,
        provider: c.l1Wallet!.provider,
        provenance: c.l1Wallet!.provenance,
        userLabeled: c.l1Wallet!.userLabeled,
        lastUsedAt,
      },
      0,
      ids(book),
    )

  it.each<[string, StoredContact[], Contact, Partial<NonNullable<Contact["l1Wallet"]>>[]]>([
    [
      "collapses a saved recipient into a real wallet, keeping the label",
      stored({ ...l1("manual", { userLabeled: true }), name: LABEL }),
      l1("metamask", { provenance: "deposit-attested" }),
      [{ provider: "metamask", provenance: "deposit-attested", userLabeled: true, lastUsedAt: 7 }],
    ],
    [
      "keeps two real wallets at one address apart",
      stored(l1("metamask")),
      l1("rainbow"),
      [{ provider: "metamask" }, { provider: "rainbow" }],
    ],
    [
      "never downgrades a deposit-attested row",
      stored(l1("metamask", { provenance: "deposit-attested", lastUsedAt: 9 })),
      l1("metamask"),
      [{ provenance: "deposit-attested", lastUsedAt: 9 }],
    ],
    [
      "revives a removed wallet on newer activity",
      stored(l1("metamask", { deletedAt: 5 })),
      l1("metamask"),
      [{ deletedAt: undefined, lastUsedAt: 7 }],
    ],
  ])("%s", (_, book, incoming, after) => {
    const [next] = upsert(book, incoming, 7)
    expect(next.map((c) => c.l1Wallet)).toEqual(after.map((w) => expect.objectContaining(w)))
    expect(next[0].id).toBe(timeKey(0))
  })

  it("keeps a user label over a deposit's wallet name", () => {
    const [next] = upsert(
      stored({ ...l1("manual", { userLabeled: true }), name: LABEL }),
      l1("metamask", { provenance: "deposit-attested" }),
      1,
    )
    expect(next[0].name).toBe(LABEL)
  })
})

describe("updateL1WalletContact", () => {
  const edit = (book: StoredContact[], address: string, name = LABEL) =>
    updateL1WalletContact(
      book,
      { originalAddress: L1, provider: "metamask", address, name },
      3,
      ids(book),
    )

  it("renames in place and marks the label as the user's", () => {
    const [next] = edit(stored(l1("metamask")), L1)
    expect(next).toEqual([expect.objectContaining({ id: timeKey(0), name: LABEL })])
    expect(next[0].l1Wallet?.userLabeled).toBe(true)
  })

  it("records the old address when the address changes, and forgets it on the way back", () => {
    const [moved] = edit(stored(l1("metamask")), L1_NEW)
    expect(moved[0].l1Wallet?.replacedAddresses).toEqual([L1])
    const [back] = updateL1WalletContact(
      moved,
      { originalAddress: L1_NEW, provider: "metamask", address: L1, name: LABEL },
      3,
      ids(moved),
    )
    expect(back[0].l1Wallet?.replacedAddresses).toEqual([L1_NEW])
  })

  it("refuses an address another live wallet holds", () => {
    const book = stored(l1("metamask"), { ...l1("metamask"), address: L1_NEW })
    expect(() => edit(book, L1_NEW)).toThrow(expect.objectContaining({ code: "contact.duplicate" }))
  })

  it("absorbs a removed wallet at the new address", () => {
    const book = stored(l1("metamask"), {
      ...l1("metamask", { deletedAt: 1, replacedAddresses: ["0xold"] }),
      address: L1_NEW,
    })
    const [next] = edit(book, L1_NEW)
    expect(next.map((c) => c.id)).toEqual([timeKey(0)])
    expect(next[0].l1Wallet?.replacedAddresses).toEqual([L1, "0xold"])
  })

  it("saves a wallet only deposit history knew as a new recipient", () => {
    const [next] = edit(stored(), L1)
    expect(next).toEqual([expect.objectContaining({ id: timeKey(100), name: LABEL })])
    expect(next[0].l1Wallet).toMatchObject({ provenance: "saved-recipient", lastUsedAt: 3 })
  })
})

describe("modifyEntry and removeEntry", () => {
  it("refuses a name another contact holds, whatever its kind", () => {
    const book = stored(l2(), { ...l1("metamask"), name: LABEL })
    expect(() => modifyEntry(book, l2({ name: LABEL }), { address: A })).toThrow(
      expect.objectContaining({ code: "contact.nameTaken" }),
    )
  })

  it("removes only the row of the kind named", () => {
    const book = stored(l2({ address: L1 }), l1("metamask"))
    expect(removeEntry(book, { address: L1 })[0]).toEqual([book[1]])
    expect(
      removeEntry(book, { address: L1, addressKind: "ethereum-l1", provider: "unknown" })[0],
    ).toEqual([book[0]])
  })
})

describe("importContacts", () => {
  it("adds what the book lacks, merges a held tag's address, and skips the rest", () => {
    const book = stored(l2({ address: B }))
    const carol = l2({ name: ALICE, tag: "carol", address: "0x" + "c0".repeat(32) })
    const [next, added] = importContacts(
      book,
      [l2(), carol, { name: "" }, l1("metamask")],
      ids(book),
    )
    expect(added).toBe(2)
    expect(next.map((c) => [c.id, c.name, c.retiredAddresses])).toEqual([
      [timeKey(0), ALICE, [A]],
      [timeKey(100), "carol", undefined],
      [timeKey(101), "metamask", undefined],
    ])
  })
})

describe("isValidContact", () => {
  it.each<[string, unknown, boolean]>([
    ["an L2 contact", l2(), true],
    ["an L1 wallet", l1("metamask"), true],
    ["no name", l2({ name: "" }), false],
    ["an unknown provenance", { ...l2(), provenance: "nfc" }, false],
    ["a pending handshake not from a scan", l2({ addressKind: "pending-handshake" }), false],
    ["an L1 row without its wallet", { ...l1("metamask"), l1Wallet: undefined }, false],
    ["an L1 wallet without a provider", l1(""), false],
    ["a malformed removal time", l1("metamask", { deletedAt: "x" as never }), false],
    ["a non-boolean auto-add", { ...l2(), autoAdded: "yes" }, false],
  ])("%s: %s", (_, value, valid) => {
    expect(isValidContact(value)).toBe(valid)
  })
})
