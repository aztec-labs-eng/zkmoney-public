import { beforeEach, describe, expect, it } from "vitest"
import {
  ContactStorage,
  CONTACT_STORAGE_KEY,
  type Contact,
  type IStorageAdapter,
} from "../../src/index.js"

class InMemoryStorage implements IStorageAdapter {
  private store = new Map<string, string>()

  async getItem(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key)
  }

  async clear(): Promise<void> {
    this.store.clear()
  }

  raw(key: string): string | undefined {
    return this.store.get(key)
  }

  seed(key: string, value: string): void {
    this.store.set(key, value)
  }
}

/** Shared FIFO mutex standing in for the web `contacts-write` navigator.locks lock. */
const createSharedMutex = () => {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(() => fn())
    tail = run.catch(() => undefined)
    return run
  }
}

/** Shared adapter whose setItem stays pending until flushed, so two contexts' writes interleave. */
class DeferredSharedAdapter implements IStorageAdapter {
  data = new Map<string, string>()
  private pending: Array<() => void> = []

  async getItem(key: string): Promise<string | null> {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string): Promise<void> {
    return new Promise((resolve) => {
      this.pending.push(() => {
        this.data.set(key, value)
        resolve()
      })
    })
  }

  async removeItem(key: string): Promise<void> {
    this.data.delete(key)
  }

  async clear(): Promise<void> {
    this.data.clear()
  }

  flushAllPending(): void {
    const batch = this.pending
    this.pending = []
    for (const flush of batch) flush()
  }
}

/** In-memory adapter with the optional `subscribe` seam; `notify` simulates another tab's storage event. */
class SubscribableAdapter extends InMemoryStorage {
  private subs = new Map<string, Set<() => void>>()

  subscribe(key: string, cb: () => void): () => void {
    const set = this.subs.get(key) ?? new Set()
    set.add(cb)
    this.subs.set(key, set)
    return () => set.delete(cb)
  }

  notify(key: string): void {
    for (const cb of this.subs.get(key) ?? []) cb()
  }
}

const ADDR_A = "0x" + "a".repeat(64)
const ADDR_B = "0x" + "b".repeat(64)
const ADDR_C = "0x" + "c".repeat(64)

const resetSingletons = () => {
  // Singletons hold state across tests; reset between tests so each starts clean.
  // Note: the load gate is *instance-local*. Tests must drain pending promises
  // before reset, or use a fresh adapter per reset, to avoid post-reset writes
  // from a stale instance leaking into the new instance's adapter.
  ;(ContactStorage as unknown as { instance: ContactStorage | null }).instance = null
}

const setup = () => {
  resetSingletons()
  const adapter = new InMemoryStorage()
  const contactStorage = ContactStorage.get(adapter)
  return { adapter, contactStorage }
}

describe("ContactStorage (flat single-network shape)", () => {
  it('CONTACT_STORAGE_KEY pins to the literal string "obsidion_contacts"', () => {
    expect(CONTACT_STORAGE_KEY).toBe("obsidion_contacts")
  })

  it('addEntry persists under the literal key "obsidion_contacts"', async () => {
    resetSingletons()
    const adapter = new InMemoryStorage()
    const contactStorage = ContactStorage.get(adapter)
    await contactStorage.addEntry({ name: "Alice", address: ADDR_A })
    const persisted = adapter.raw("obsidion_contacts")
    expect(persisted).toBeDefined()
    expect(JSON.parse(persisted!)).toEqual([{ name: "Alice", address: ADDR_A }])
  })

  beforeEach(() => {
    resetSingletons()
  })

  describe("happy path", () => {
    it("addEntry stores a name+address+tag entry; getEntries returns it", async () => {
      const { contactStorage } = setup()
      const entry: Contact = { name: "Alice", address: ADDR_A, tag: "alice" }
      await contactStorage.addEntry(entry)
      expect(await contactStorage.getEntries()).toEqual([entry])
    })

    it("addEntries stores multiple entries", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntries([
        { name: "Alice", address: ADDR_A },
        { name: "Bob", address: ADDR_B },
      ])
      const entries = await contactStorage.getEntries()
      expect(entries.map((e) => e.address).sort()).toEqual([ADDR_A, ADDR_B].sort())
    })

    it("modifyEntry with a changed address updates the stored entry", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Alice", address: ADDR_A })
      await contactStorage.modifyEntry({ name: "Alice", address: ADDR_B }, { address: ADDR_A })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.address).toBe(ADDR_B)
    })

    it("removeEntry deletes the L2 entry by address", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Alice", address: ADDR_A })
      await contactStorage.addEntry({ name: "Bob", address: ADDR_B })
      await contactStorage.removeEntry({ address: ADDR_A })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.address).toBe(ADDR_B)
    })

    it("findByTag returns the matching entry", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Alice", address: ADDR_A, tag: "alice" })
      await contactStorage.addEntry({ name: "Bob", address: ADDR_B, tag: "bob" })
      expect(await contactStorage.findByTag("bob")).toMatchObject({ address: ADDR_B })
      expect(await contactStorage.findByTag("nope")).toBeUndefined()
    })

    it("getEntries on a fresh adapter returns []", async () => {
      const { contactStorage } = setup()
      expect(await contactStorage.getEntries()).toEqual([])
    })
  })

  describe("duplicate validation", () => {
    it("rejects a duplicate address", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Alice", address: ADDR_A })
      await expect(contactStorage.addEntry({ name: "Bob", address: ADDR_A })).rejects.toThrow(
        "Duplicate entry - address",
      )
    })

    it("rejects a duplicate tag", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Alice", address: ADDR_A, tag: "shared" })
      await expect(
        contactStorage.addEntry({ name: "Bob", address: ADDR_B, tag: "shared" }),
      ).rejects.toThrow("Duplicate entry - tag")
    })

    it("rejects a duplicate name (case-insensitive, whitespace-insensitive)", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Alice", address: ADDR_A })
      await expect(contactStorage.addEntry({ name: "  alice  ", address: ADDR_B })).rejects.toThrow(
        "Duplicate entry - name",
      )
    })
  })

  describe("L2 provenance (qr-scan)", () => {
    it("addEntry with provenance=qr-scan persists and reloads with the field intact", async () => {
      const { adapter, contactStorage } = setup()
      await contactStorage.addEntry({
        name: "Alice",
        address: ADDR_A,
        tag: "alice",
        provenance: "qr-scan",
      })

      // Reload from disk through a fresh instance to prove it survives round-trip.
      resetSingletons()
      const reloaded = ContactStorage.get(adapter)
      const entries = await reloaded.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.provenance).toBe("qr-scan")
    })

    it("an entry without provenance is still valid", async () => {
      const { adapter, contactStorage } = setup()
      adapter.seed(CONTACT_STORAGE_KEY, JSON.stringify([{ name: "Alice", address: ADDR_A }]))
      await contactStorage.initialize()
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.provenance).toBeUndefined()
    })

    it("doLoad drops an entry with an unknown provenance value", async () => {
      const { adapter, contactStorage } = setup()
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify([
          { name: "Bad", address: ADDR_A, provenance: "made-up" },
          { name: "Alice", address: ADDR_B, provenance: "qr-scan" },
        ]),
      )
      await contactStorage.initialize()
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("Alice")
    })
  })

  describe("addOrMergeContact (no-op-on-duplicate L2 add)", () => {
    it("adds a new L2 contact and persists provenance", async () => {
      const { contactStorage } = setup()
      const result = await contactStorage.addOrMergeContact({
        name: "Alice",
        address: ADDR_A,
        tag: "alice",
        provenance: "qr-scan",
      })
      expect(result.provenance).toBe("qr-scan")
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.provenance).toBe("qr-scan")
    })

    it("re-adding the same address is a no-op (no throw) and keeps a single row", async () => {
      const { contactStorage } = setup()
      await contactStorage.addOrMergeContact({
        name: "Alice",
        address: ADDR_A,
        provenance: "qr-scan",
      })
      // Re-add the same address (different name/tag) — must not throw, must not duplicate.
      const result = await contactStorage.addOrMergeContact({
        name: "Alice2",
        address: ADDR_A,
        tag: "alice2",
      })
      // Returns the existing row unchanged.
      expect(result.name).toBe("Alice")
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("Alice")
    })

    it("re-adding via addOrMergeContact after a plain addEntry of the same address is a no-op", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Alice", address: ADDR_A })
      await expect(
        contactStorage.addOrMergeContact({ name: "Bob", address: ADDR_A, provenance: "qr-scan" }),
      ).resolves.toMatchObject({ name: "Alice" })
      expect(await contactStorage.getEntries()).toHaveLength(1)
    })

    it("NEW address but colliding tag → no throw, returns existing, no dup row", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Alice", address: ADDR_A, tag: "shared" })
      // Different (new) L2 address, but the tag collides — must NOT throw.
      const result = await contactStorage.addOrMergeContact({
        name: "Bob",
        address: ADDR_B,
        tag: "shared",
        provenance: "qr-scan",
      })
      expect(result.name).toBe("Alice")
      expect(result.address).toBe(ADDR_A)
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
    })

    it("NEW address but colliding normalized name → no throw, returns existing, no dup row", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Alice", address: ADDR_A })
      // Different (new) L2 address, name collides case/whitespace-insensitively.
      const result = await contactStorage.addOrMergeContact({
        name: "  alice  ",
        address: ADDR_B,
        provenance: "qr-scan",
      })
      expect(result.address).toBe(ADDR_A)
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("Alice")
    })

    it("persists a pending handshake row without treating XMTP as L2", async () => {
      const { contactStorage } = setup()
      const handle = "0xAbCdEf0123456789aBcDeF0123456789aBcDeF01"
      const result = await contactStorage.addOrMergeContact({
        name: "Alice",
        address: handle,
        addressKind: "pending-handshake",
        tag: "alice",
        provenance: "qr-scan",
      })
      expect(result.addressKind).toBe("pending-handshake")
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.addressKind).toBe("pending-handshake")
      expect(entries[0]?.address).toBe(handle)
    })

    it("upgrades a pending handshake row when the real L2 contact arrives", async () => {
      const { contactStorage } = setup()
      const handle = "0xAbCdEf0123456789aBcDeF0123456789aBcDeF01"
      await contactStorage.addOrMergeContact({
        name: "Alice",
        address: handle,
        addressKind: "pending-handshake",
        tag: "alice",
        provenance: "qr-scan",
      })

      const result = await contactStorage.addOrMergeContact({
        name: "Alice",
        address: ADDR_A,
        addressKind: "aztec-l2",
        tag: "alice",
        provenance: "qr-scan",
      })

      expect(result.addressKind).toBe("aztec-l2")
      expect(result.address).toBe(ADDR_A)
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ address: ADDR_A, addressKind: "aztec-l2" })
    })
  })

  describe("autoAdded (sender added from a transfer)", () => {
    const fromTransfer: Contact = {
      name: "jo",
      address: ADDR_A,
      addressKind: "aztec-l2",
      tag: "jo",
      verified: true,
      autoAdded: true,
    }

    it("survives a reload, and a non-boolean value drops the row", async () => {
      const { adapter, contactStorage } = setup()
      await contactStorage.addOrMergeContact(fromTransfer)
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify([
          ...JSON.parse(adapter.raw(CONTACT_STORAGE_KEY)!),
          {
            name: "Bad",
            address: ADDR_B,
            autoAdded: "yes",
          },
        ]),
      )
      resetSingletons()
      expect(await ContactStorage.get(adapter).getEntries()).toEqual([fromTransfer])
    })

    it("addEntry at the same address approves the row instead of throwing", async () => {
      const { contactStorage } = setup()
      await contactStorage.addOrMergeContact({ ...fromTransfer, name: "Jo from work" })
      await contactStorage.addEntry({ name: "jo", address: ADDR_A, verified: true, tag: "jo" })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual({ ...fromTransfer, name: "Jo from work", autoAdded: undefined })
      expect("autoAdded" in entries[0]!).toBe(false)
    })

    it("addEntry still rejects a duplicate tag at another address", async () => {
      const { contactStorage } = setup()
      await contactStorage.addOrMergeContact(fromTransfer)
      await expect(
        contactStorage.addEntry({ name: "jo2", address: ADDR_B, tag: "jo" }),
      ).rejects.toThrow("Duplicate entry - tag")
      expect((await contactStorage.getEntries())[0]?.autoAdded).toBe(true)
    })

    it("addOrMergeContact approves the row only for an entry the wallet did not add", async () => {
      const { contactStorage } = setup()
      await contactStorage.addOrMergeContact(fromTransfer)
      await contactStorage.addOrMergeContact({ ...fromTransfer, name: "jo again" })
      expect((await contactStorage.getEntries())[0]?.autoAdded).toBe(true)

      const result = await contactStorage.addOrMergeContact({
        name: "jo",
        address: ADDR_A,
        tag: "jo",
        provenance: "qr-scan",
      })
      expect(result.autoAdded).toBeUndefined()
      expect(await contactStorage.getEntries()).toEqual([result])
    })

    it("approves on a tag that differs only in case", async () => {
      const { contactStorage } = setup()
      await contactStorage.addOrMergeContact(fromTransfer)
      await contactStorage.addEntry({ name: "jo", address: ADDR_A, tag: "Jo" })
      expect((await contactStorage.getEntries())[0]?.autoAdded).toBeUndefined()
    })

    it("addEntry with another tag at that address replaces the row with the user's entry", async () => {
      const { contactStorage } = setup()
      await contactStorage.addOrMergeContact(fromTransfer)
      const selected = { name: "selected", address: ADDR_A, verified: true, tag: "selected" }
      await contactStorage.addEntry(selected)
      expect(await contactStorage.getEntries()).toEqual([selected])
    })

    it("addEntry with another tag at that address still rejects a tag another row holds", async () => {
      const { contactStorage } = setup()
      await contactStorage.addOrMergeContact(fromTransfer)
      await contactStorage.addEntry({ name: "Sam", address: ADDR_B, tag: "sam" })
      await expect(
        contactStorage.addEntry({ name: "sam2", address: ADDR_A, tag: "sam" }),
      ).rejects.toThrow("Duplicate entry - tag")
      expect((await contactStorage.getEntries())[0]).toEqual(fromTransfer)
    })

    it("addOrMergeContact with another tag at that address leaves the row unapproved", async () => {
      const { contactStorage } = setup()
      await contactStorage.addOrMergeContact(fromTransfer)
      const result = await contactStorage.addOrMergeContact({
        name: "selected",
        address: ADDR_A,
        tag: "selected",
        provenance: "qr-scan",
      })
      expect(result).toEqual(fromTransfer)
      expect(await contactStorage.getEntries()).toEqual([fromTransfer])
    })

    it("an entry the wallet adds never approves the row", async () => {
      const { contactStorage } = setup()
      await contactStorage.addOrMergeContact(fromTransfer)
      await expect(contactStorage.addEntry({ ...fromTransfer, name: "jo2" })).rejects.toThrow(
        "Duplicate entry - address",
      )
      expect(await contactStorage.getEntries()).toEqual([fromTransfer])
    })

    it("leaves a contact the user added at that address as it was", async () => {
      const { contactStorage } = setup()
      const saved = { name: "jo", address: ADDR_A, tag: "jo" }
      await contactStorage.addEntry(saved)
      await expect(
        contactStorage.addEntry({ name: "other", address: ADDR_A, tag: "other" }),
      ).rejects.toThrow("Duplicate entry - address")
      expect(
        await contactStorage.addOrMergeContact({ name: "other", address: ADDR_A, tag: "other" }),
      ).toEqual(saved)
      expect(await contactStorage.getEntries()).toEqual([saved])
    })
  })

  describe("clear", () => {
    it("removes CONTACT_STORAGE_KEY", async () => {
      const { adapter, contactStorage } = setup()
      await contactStorage.addEntry({ name: "Alice", address: ADDR_A })
      await contactStorage.addEntry({ name: "Bob", address: ADDR_B })

      await contactStorage.clear()

      expect(await contactStorage.getEntries()).toEqual([])
      expect(adapter.raw(CONTACT_STORAGE_KEY)).toBeUndefined()
    })
  })

  describe("validate-and-clear (single-flight load)", () => {
    it("clears the key when persisted JSON is null", async () => {
      const { adapter, contactStorage } = setup()
      adapter.seed(CONTACT_STORAGE_KEY, "null")
      await contactStorage.initialize()
      expect(await contactStorage.getEntries()).toEqual([])
      expect(adapter.raw(CONTACT_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when shape is the old per-network record", async () => {
      const { adapter, contactStorage } = setup()
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify({ testnet: [{ name: "Alice", address: ADDR_A }] }),
      )
      await contactStorage.initialize()
      expect(await contactStorage.getEntries()).toEqual([])
      expect(adapter.raw(CONTACT_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when shape is the legacy per-network + per-wallet record", async () => {
      const { adapter, contactStorage } = setup()
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify({
          testnet: { [ADDR_A]: [{ name: "Alice", address: ADDR_A }] },
        }),
      )
      await contactStorage.initialize()
      expect(await contactStorage.getEntries()).toEqual([])
      expect(adapter.raw(CONTACT_STORAGE_KEY)).toBeUndefined()
    })

    it("clears the key when JSON is corrupt", async () => {
      const { adapter, contactStorage } = setup()
      adapter.seed(CONTACT_STORAGE_KEY, "{not-json")
      await contactStorage.initialize()
      expect(await contactStorage.getEntries()).toEqual([])
      expect(adapter.raw(CONTACT_STORAGE_KEY)).toBeUndefined()
    })

    it("filters entries missing string name; persists cleaned array", async () => {
      const { adapter, contactStorage } = setup()
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify([
          { name: "Alice", address: ADDR_A },
          { address: ADDR_B },
          { name: "Carol", address: ADDR_C },
        ]),
      )
      await contactStorage.initialize()
      const entries = await contactStorage.getEntries()
      expect(entries.map((e) => e.address).sort()).toEqual([ADDR_A, ADDR_C].sort())
      // Cleaned array is persisted — the bad entry doesn't get re-filtered next launch.
      const persisted = JSON.parse(adapter.raw(CONTACT_STORAGE_KEY)!) as unknown[]
      expect(persisted).toHaveLength(2)
    })

    it("filters entries with empty-string name (matches addContactSchema z.string().min(1))", async () => {
      const { adapter, contactStorage } = setup()
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify([
          { name: "", address: ADDR_A },
          { name: "Alice", address: ADDR_B },
        ]),
      )
      await contactStorage.initialize()
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("Alice")
    })

    it("filters entries with non-string tag; persists cleaned array", async () => {
      const { adapter, contactStorage } = setup()
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify([
          { name: "Alice", address: ADDR_A, tag: "alice" },
          { name: "Bob", address: ADDR_B, tag: 123 },
        ]),
      )
      await contactStorage.initialize()
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.address).toBe(ADDR_A)
      const persisted = JSON.parse(adapter.raw(CONTACT_STORAGE_KEY)!) as unknown[]
      expect(persisted).toHaveLength(1)
    })

    it("does not rewrite when no entries needed filtering", async () => {
      const { adapter, contactStorage } = setup()
      const seedJson = JSON.stringify([{ name: "Alice", address: ADDR_A }])
      adapter.seed(CONTACT_STORAGE_KEY, seedJson)
      await contactStorage.initialize()
      expect(await contactStorage.getEntries()).toHaveLength(1)
      expect(adapter.raw(CONTACT_STORAGE_KEY)).toBe(seedJson)
    })
  })

  describe("concurrency (single-flight load gate)", () => {
    it("deduplicates concurrent loads — getItem called once across many simultaneous reads", async () => {
      let getItemCalls = 0
      class CountingAdapter extends InMemoryStorage {
        async getItem(key: string): Promise<string | null> {
          if (key === CONTACT_STORAGE_KEY) getItemCalls++
          return super.getItem(key)
        }
      }
      resetSingletons()
      const adapter = new CountingAdapter()
      const contactStorage = ContactStorage.get(adapter)

      await Promise.all([
        contactStorage.getEntries(),
        contactStorage.getEntries(),
        contactStorage.getEntries(),
        contactStorage.findByTag("x"),
      ])

      expect(getItemCalls).toBe(1)
    })

    it("preserves a concurrent addEntry across an in-flight initial load", async () => {
      // Seed dirty data so the load path filters; the cleanup write must NOT
      // clobber a concurrent addEntry. We exercise the load gate by issuing
      // initialize() and addEntry() in the same microtask tick.
      const { adapter, contactStorage } = setup()
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify([
          { name: "Alice", address: ADDR_A },
          { address: ADDR_B }, // missing name → filtered
        ]),
      )

      // Don't await initialize separately — let addEntry race against the load.
      const initP = contactStorage.initialize()
      const addP = contactStorage.addEntry({ name: "Carol", address: ADDR_C })

      await Promise.all([initP, addP])

      const entries = await contactStorage.getEntries()
      const addrs = entries.map((e) => e.address).sort()
      expect(addrs).toEqual([ADDR_A, ADDR_C].sort())
    })

    it("clear() concurrent with a pending load does not leave stale data on disk", async () => {
      const { adapter, contactStorage } = setup()
      adapter.seed(CONTACT_STORAGE_KEY, JSON.stringify([{ name: "Alice", address: ADDR_A }]))

      const initP = contactStorage.initialize()
      const clearP = contactStorage.clear()

      await Promise.all([initP, clearP])

      expect(await contactStorage.getEntries()).toEqual([])
      expect(adapter.raw(CONTACT_STORAGE_KEY)).toBeUndefined()
    })
  })

  describe("L1 wallet contacts (upsertL1WalletContact)", () => {
    const ETH_A = "0xAbCdEf0123456789aBcDeF0123456789aBcDeF01"
    const ETH_B = "0x0123456789abCdEf0123456789aBcDeF01234567"

    it("persists a new L1 row with addressKind=ethereum-l1", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.addressKind).toBe("ethereum-l1")
      expect(entries[0]?.l1Wallet?.provider).toBe("rainbow")
      expect(entries[0]?.l1Wallet?.provenance).toBe("deposit-attested")
    })

    it("L2 addEntry still produces a row with addressKind undefined (legacy default)", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Alice", address: ADDR_A, tag: "alice" })
      const entries = await contactStorage.getEntries()
      expect(entries[0]?.addressKind).toBeUndefined()
    })

    it("upsert with the same (provider, address) merges into one row", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "saved-recipient",
      })
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.l1Wallet?.provenance).toBe("deposit-attested")
    })

    it("same Ethereum address under two providers produces two distinct rows", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      await contactStorage.upsertL1WalletContact({
        name: "MetaMask",
        address: ETH_A,
        provider: "metamask",
        provenance: "deposit-attested",
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(2)
      const providers = entries.map((e) => e.l1Wallet?.provider).sort()
      expect(providers).toEqual(["metamask", "rainbow"])
    })

    it("a 'manual' saved-recipient + a real-slug deposit for one address collapse to a single labeled row", async () => {
      const { contactStorage } = setup()
      // User saves the wallet under a label (withdraw form → provider "manual").
      await contactStorage.upsertL1WalletContact({
        name: "My cold wallet",
        address: ETH_A,
        provider: "manual",
        provenance: "saved-recipient",
      })
      // Later a deposit from the same address is attested under the real slug.
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      // User label wins over the auto provider name; provider upgrades to the
      // real slug; provenance is the stronger deposit-attested.
      expect(entries[0]?.name).toBe("My cold wallet")
      expect(entries[0]?.l1Wallet?.provider).toBe("rainbow")
      expect(entries[0]?.l1Wallet?.provenance).toBe("deposit-attested")
    })

    it("collapse is order-independent — deposit first, then the saved label", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      await contactStorage.upsertL1WalletContact({
        name: "My cold wallet",
        address: ETH_A,
        provider: "manual",
        provenance: "saved-recipient",
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("My cold wallet")
      expect(entries[0]?.l1Wallet?.provider).toBe("rainbow")
      expect(entries[0]?.l1Wallet?.provenance).toBe("deposit-attested")
    })

    it("an 'unknown'-provider deposit + a 'manual' saved row for one address collapse to one row", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "External Wallet",
        address: ETH_A,
        provider: "unknown",
        provenance: "deposit-attested",
      })
      await contactStorage.upsertL1WalletContact({
        name: "Hardware wallet",
        address: ETH_A,
        provider: "manual",
        provenance: "saved-recipient",
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("Hardware wallet")
    })

    it("load-time migration collapses pre-existing duplicate L1 rows for one address", async () => {
      resetSingletons()
      const adapter = new InMemoryStorage()
      // Two rows persisted by the OLD (provider, address)-keyed code: a manual
      // saved-recipient and a deposit-attested row for the same address.
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify([
          {
            name: "External Wallet",
            address: ETH_A,
            addressKind: "ethereum-l1",
            l1Wallet: { provider: "rainbow", provenance: "deposit-attested", lastUsedAt: 2_000 },
          },
          {
            name: "My cold wallet",
            address: ETH_A,
            addressKind: "ethereum-l1",
            l1Wallet: { provider: "manual", provenance: "saved-recipient", lastUsedAt: 1_000 },
          },
        ] satisfies Contact[]),
      )
      const contactStorage = ContactStorage.get(adapter)
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      // The user's saved label survives the merge over the "External Wallet" placeholder.
      expect(entries[0]?.name).toBe("My cold wallet")
      expect(entries[0]?.l1Wallet?.provider).toBe("rainbow")
      // The reconciled array is persisted so the duplicate doesn't reappear.
      expect(JSON.parse(adapter.raw(CONTACT_STORAGE_KEY)!)).toHaveLength(1)
    })

    it("two genuinely-different real providers for one address still survive load-time migration", async () => {
      resetSingletons()
      const adapter = new InMemoryStorage()
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify([
          {
            name: "Rainbow",
            address: ETH_A,
            addressKind: "ethereum-l1",
            l1Wallet: { provider: "rainbow", provenance: "deposit-attested" },
          },
          {
            name: "MetaMask",
            address: ETH_A,
            addressKind: "ethereum-l1",
            l1Wallet: { provider: "metamask", provenance: "deposit-attested" },
          },
        ] satisfies Contact[]),
      )
      const contactStorage = ContactStorage.get(adapter)
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(2)
      // The two distinct real providers survive the merge.
      const providers = entries.map((e) => e.l1Wallet?.provider).sort()
      expect(providers).toEqual(["metamask", "rainbow"])
    })

    it("removeEntry deletes a collapsed L1 row even when the target provider is the generic deposit slug", async () => {
      const { contactStorage } = setup()
      // Unknown-provider deposit + manual save collapse to one row.
      await contactStorage.upsertL1WalletContact({
        name: "External Wallet",
        address: ETH_A,
        provider: "unknown",
        provenance: "deposit-attested",
      })
      await contactStorage.upsertL1WalletContact({
        name: "Hardware wallet",
        address: ETH_A,
        provider: "manual",
        provenance: "saved-recipient",
      })
      expect(await contactStorage.getEntries()).toHaveLength(1)
      // The deposit-thread delete handler targets by the record's provider
      // ("unknown"); a strict provider match would silently no-op the delete.
      await contactStorage.removeEntry({
        address: ETH_A,
        addressKind: "ethereum-l1",
        provider: "unknown",
      })
      expect(await contactStorage.getEntries()).toHaveLength(0)
    })

    it("removeEntry by a real provider deletes a row collapsed to that real slug", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "My cold wallet",
        address: ETH_A,
        provider: "manual",
        provenance: "saved-recipient",
      })
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      expect(await contactStorage.getEntries()).toHaveLength(1)
      await contactStorage.removeEntry({
        address: ETH_A,
        addressKind: "ethereum-l1",
        provider: "rainbow",
      })
      expect(await contactStorage.getEntries()).toHaveLength(0)
    })

    it("removeEntry of one real L1 provider leaves a different real provider at the same address", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      await contactStorage.upsertL1WalletContact({
        name: "MetaMask",
        address: ETH_A,
        provider: "metamask",
        provenance: "deposit-attested",
      })
      expect(await contactStorage.getEntries()).toHaveLength(2)
      await contactStorage.removeEntry({
        address: ETH_A,
        addressKind: "ethereum-l1",
        provider: "rainbow",
      })
      const remaining = await contactStorage.getEntries()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]?.l1Wallet?.provider).toBe("metamask")
    })

    it("L1 row and L2 row sharing the same address string coexist", async () => {
      const { contactStorage } = setup()
      // Use a string that's a valid shape for both kinds — same string, different kinds.
      await contactStorage.addEntry({ name: "Alice", address: ETH_A, tag: "alice" })
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(2)
      const kinds = entries.map((e) => e.addressKind ?? "aztec-l2").sort()
      expect(kinds).toEqual(["aztec-l2", "ethereum-l1"])
    })

    it("provenance does not downgrade — deposit-attested → saved-recipient stays deposit-attested", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "saved-recipient",
      })
      const entries = await contactStorage.getEntries()
      expect(entries[0]?.l1Wallet?.provenance).toBe("deposit-attested")
    })

    it("lastUsedAt always takes the max of existing vs incoming", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
        lastUsedAt: 5_000,
      })
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
        lastUsedAt: 3_000,
      })
      const entries = await contactStorage.getEntries()
      expect(entries[0]?.l1Wallet?.lastUsedAt).toBe(5_000)
    })

    it("upsertL1WalletContact does NOT run cross-kind name validation", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Rainbow", address: ADDR_A })
      // L2 contact named "Rainbow" exists. upsert with same auto-derived name must succeed —
      // the auto-attestation path bypasses name validation.
      await expect(
        contactStorage.upsertL1WalletContact({
          name: "Rainbow",
          address: ETH_A,
          provider: "rainbow",
          provenance: "deposit-attested",
        }),
      ).resolves.toBeDefined()
      expect(await contactStorage.getEntries()).toHaveLength(2)
    })

    it("addEntry DOES run cross-kind name validation", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Rainbow", address: ADDR_A })
      await expect(
        contactStorage.addEntry({
          name: "Rainbow",
          address: ETH_A,
          addressKind: "ethereum-l1",
          l1Wallet: { provider: "rainbow", provenance: "saved-recipient" },
        }),
      ).rejects.toThrow("Duplicate entry - name")
    })

    it("modifyEntry runs cross-kind name validation against the rest of the list", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Alice", address: ADDR_A })
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      // Try to rename the L1 row to "Alice" (collides with L2 row).
      await expect(
        contactStorage.modifyEntry(
          {
            name: "Alice",
            address: ETH_A,
            addressKind: "ethereum-l1",
            l1Wallet: { provider: "rainbow", provenance: "deposit-attested" },
          },
          { address: ETH_A, addressKind: "ethereum-l1", provider: "rainbow" },
        ),
      ).rejects.toThrow("Duplicate entry - name")
    })

    it("identity-aware removeEntry: scoping to L1 leaves L2 row intact", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Alice", address: ETH_A })
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      await contactStorage.removeEntry({
        address: ETH_A,
        addressKind: "ethereum-l1",
        provider: "rainbow",
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.addressKind).toBeUndefined() // L2 survives
    })

    it("identity-aware removeEntry: scoping to L2 leaves L1 rows intact", async () => {
      const { contactStorage } = setup()
      await contactStorage.addEntry({ name: "Alice", address: ETH_A })
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      await contactStorage.removeEntry({ address: ETH_A })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.addressKind).toBe("ethereum-l1")
    })

    it("doLoad drops a malformed L1 entry (missing l1Wallet) and persists cleaned array", async () => {
      const { adapter, contactStorage } = setup()
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify([
          { name: "Alice", address: ADDR_A },
          // L1 marker without l1Wallet — must be dropped.
          { name: "Broken", address: ETH_A, addressKind: "ethereum-l1" },
          {
            name: "Rainbow",
            address: ETH_B,
            addressKind: "ethereum-l1",
            l1Wallet: { provider: "rainbow", provenance: "deposit-attested" },
          },
        ]),
      )
      await contactStorage.initialize()
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(2)
      expect(entries.find((e) => e.name === "Broken")).toBeUndefined()
      const persisted = JSON.parse(adapter.raw(CONTACT_STORAGE_KEY)!) as unknown[]
      expect(persisted).toHaveLength(2)
    })

    it("doLoad drops an L1 entry with empty provider", async () => {
      const { contactStorage, adapter } = setup()
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify([
          {
            name: "Bad",
            address: ETH_A,
            addressKind: "ethereum-l1",
            l1Wallet: { provider: "", provenance: "deposit-attested" },
          },
        ]),
      )
      await contactStorage.initialize()
      expect(await contactStorage.getEntries()).toEqual([])
    })

    it("doLoad drops an L1 entry with unknown provenance", async () => {
      const { contactStorage, adapter } = setup()
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify([
          {
            name: "Bad",
            address: ETH_A,
            addressKind: "ethereum-l1",
            l1Wallet: { provider: "rainbow", provenance: "made-up" },
          },
        ]),
      )
      await contactStorage.initialize()
      expect(await contactStorage.getEntries()).toEqual([])
    })

    it("doLoad still validates l1Wallet shape on L2 rows when present (matches addContactSchema)", async () => {
      const { contactStorage, adapter } = setup()
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify([
          // L2 row with stray malformed l1Wallet must be dropped.
          {
            name: "Bad",
            address: ADDR_A,
            l1Wallet: { provider: "", provenance: "deposit-attested" },
          },
          { name: "Alice", address: ADDR_B },
        ]),
      )
      await contactStorage.initialize()
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("Alice")
    })
  })

  describe("updateL1WalletContact (edit label/address)", () => {
    const ETH_A = "0xAbCdEf0123456789aBcDeF0123456789aBcDeF01"
    const ETH_B = "0x0123456789abCdEf0123456789aBcDeF01234567"

    it("renames the label in place, marking it userLabeled and keeping provenance", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      await contactStorage.updateL1WalletContact({
        originalAddress: ETH_A,
        provider: "rainbow",
        name: "My Wallet",
        address: ETH_A,
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("My Wallet")
      expect(entries[0]?.address).toBe(ETH_A)
      expect(entries[0]?.l1Wallet?.userLabeled).toBe(true)
      expect(entries[0]?.l1Wallet?.provenance).toBe("deposit-attested")
    })

    it("rewrites the address and records the old one in replacedAddresses", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      await contactStorage.updateL1WalletContact({
        originalAddress: ETH_A,
        provider: "rainbow",
        name: "Rainbow",
        address: ETH_B,
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.address).toBe(ETH_B)
      expect(entries[0]?.l1Wallet?.replacedAddresses).toEqual([ETH_A.toLowerCase()])
    })

    it("A→B→A round-trip stops suppressing the live address", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "saved-recipient",
      })
      await contactStorage.updateL1WalletContact({
        originalAddress: ETH_A,
        provider: "rainbow",
        name: "Rainbow",
        address: ETH_B,
      })
      await contactStorage.updateL1WalletContact({
        originalAddress: ETH_B,
        provider: "rainbow",
        name: "Rainbow",
        address: ETH_A,
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.address).toBe(ETH_A)
      expect(entries[0]?.l1Wallet?.replacedAddresses).toEqual([ETH_B.toLowerCase()])
    })

    it("creates a saved-recipient row when no contact backs the edited row", async () => {
      const { contactStorage } = setup()
      await contactStorage.updateL1WalletContact({
        originalAddress: ETH_A,
        provider: "rainbow",
        name: "Ledger",
        address: ETH_B,
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("Ledger")
      expect(entries[0]?.address).toBe(ETH_B)
      expect(entries[0]?.addressKind).toBe("ethereum-l1")
      expect(entries[0]?.l1Wallet?.provider).toBe("rainbow")
      expect(entries[0]?.l1Wallet?.provenance).toBe("saved-recipient")
      expect(entries[0]?.l1Wallet?.userLabeled).toBe(true)
      expect(entries[0]?.l1Wallet?.replacedAddresses).toEqual([ETH_A.toLowerCase()])
    })

    it("throws when the new address collides with another saved row", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "saved-recipient",
      })
      await contactStorage.upsertL1WalletContact({
        name: "Other",
        address: ETH_B,
        provider: "rainbow",
        provenance: "saved-recipient",
      })
      await expect(
        contactStorage.updateL1WalletContact({
          originalAddress: ETH_A,
          provider: "rainbow",
          name: "Rainbow",
          address: ETH_B,
        }),
      ).rejects.toThrow("already exists")
      const entries = await contactStorage.getEntries()
      expect(entries.map((e) => e.address).sort()).toEqual([ETH_B, ETH_A].sort())
    })

    it("an empty name falls back to the External Wallet placeholder and clears userLabeled", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "My Wallet",
        address: ETH_A,
        provider: "manual",
        provenance: "saved-recipient",
        userLabeled: true,
      })
      await contactStorage.updateL1WalletContact({
        originalAddress: ETH_A,
        provider: "manual",
        name: "   ",
        address: ETH_A,
      })
      const entries = await contactStorage.getEntries()
      expect(entries[0]?.name).toBe("External Wallet")
      expect(entries[0]?.l1Wallet?.userLabeled).toBeUndefined()
    })

    it("a user label survives repeated deposit-attested merges (userLabeled durability)", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
      })
      await contactStorage.updateL1WalletContact({
        originalAddress: ETH_A,
        provider: "rainbow",
        name: "My Wallet",
        address: ETH_A,
      })
      // Two more deposits from the same wallet — the second one is what the
      // provenance-only rule used to lose (the first merge upgrades the row to
      // deposit-attested, so a saved-recipient check alone stops matching).
      for (let i = 0; i < 2; i++) {
        await contactStorage.upsertL1WalletContact({
          name: "Rainbow",
          address: ETH_A,
          provider: "rainbow",
          provenance: "deposit-attested",
        })
      }
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("My Wallet")
      expect(entries[0]?.l1Wallet?.userLabeled).toBe(true)
      expect(entries[0]?.l1Wallet?.provenance).toBe("deposit-attested")
    })

    it("doLoad keeps valid userLabeled/replacedAddresses and drops malformed ones", async () => {
      const { contactStorage, adapter } = setup()
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify([
          {
            name: "Good",
            address: ETH_A,
            addressKind: "ethereum-l1",
            l1Wallet: {
              provider: "rainbow",
              provenance: "saved-recipient",
              userLabeled: true,
              replacedAddresses: ["0xaa"],
            },
          },
          {
            name: "Bad",
            address: ETH_B,
            addressKind: "ethereum-l1",
            l1Wallet: {
              provider: "rainbow",
              provenance: "saved-recipient",
              replacedAddresses: "0xaa",
            },
          },
        ]),
      )
      await contactStorage.initialize()
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("Good")
      expect(entries[0]?.l1Wallet?.replacedAddresses).toEqual(["0xaa"])
    })
  })

  describe("deleteL1WalletContact (soft delete / tombstone)", () => {
    const ETH_A = "0xAbCdEf0123456789aBcDeF0123456789aBcDeF01"
    const ETH_B = "0x0123456789abCdEf0123456789aBcDeF01234567"

    it("tombstones an existing row in place, preserving its fields", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "My Wallet",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
        userLabeled: true,
      })
      await contactStorage.deleteL1WalletContact({ address: ETH_A, provider: "rainbow" })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("My Wallet")
      expect(entries[0]?.l1Wallet?.userLabeled).toBe(true)
      expect(entries[0]?.l1Wallet?.deletedAt).toBeTypeOf("number")
    })

    it("creates a tombstone when the removed row was deposit-history-only", async () => {
      const { contactStorage } = setup()
      await contactStorage.deleteL1WalletContact({ address: ETH_A, provider: "metamask" })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.address).toBe(ETH_A)
      expect(entries[0]?.addressKind).toBe("ethereum-l1")
      expect(entries[0]?.l1Wallet?.provider).toBe("metamask")
      expect(entries[0]?.l1Wallet?.deletedAt).toBeTypeOf("number")
    })

    it("a deposit newer than the removal revives the row, keeping the label", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "My Wallet",
        address: ETH_A,
        provider: "rainbow",
        provenance: "saved-recipient",
        userLabeled: true,
      })
      await contactStorage.deleteL1WalletContact({ address: ETH_A, provider: "rainbow" })
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
        lastUsedAt: Date.now() + 1000,
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("My Wallet")
      expect(entries[0]?.l1Wallet?.deletedAt).toBeUndefined()
    })

    it("a merge carrying only activity older than the removal stays tombstoned", async () => {
      const { contactStorage } = setup()
      await contactStorage.deleteL1WalletContact({ address: ETH_A, provider: "rainbow" })
      await contactStorage.upsertL1WalletContact({
        name: "Rainbow",
        address: ETH_A,
        provider: "rainbow",
        provenance: "deposit-attested",
        lastUsedAt: Date.now() - 100_000,
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.l1Wallet?.deletedAt).toBeTypeOf("number")
    })

    it("editing another row onto a tombstoned address absorbs the tombstone", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "Removed",
        address: ETH_B,
        provider: "manual",
        provenance: "saved-recipient",
      })
      await contactStorage.deleteL1WalletContact({ address: ETH_B, provider: "manual" })
      await contactStorage.upsertL1WalletContact({
        name: "Live",
        address: ETH_A,
        provider: "metamask",
        provenance: "saved-recipient",
      })
      await contactStorage.updateL1WalletContact({
        originalAddress: ETH_A,
        provider: "metamask",
        name: "Live",
        address: ETH_B,
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("Live")
      expect(entries[0]?.address).toBe(ETH_B)
      expect(entries[0]?.l1Wallet?.deletedAt).toBeUndefined()
    })

    it("editing a tombstoned row revives it", async () => {
      const { contactStorage } = setup()
      await contactStorage.upsertL1WalletContact({
        name: "Removed",
        address: ETH_A,
        provider: "rainbow",
        provenance: "saved-recipient",
      })
      await contactStorage.deleteL1WalletContact({ address: ETH_A, provider: "rainbow" })
      await contactStorage.updateL1WalletContact({
        originalAddress: ETH_A,
        provider: "rainbow",
        name: "Back",
        address: ETH_A,
      })
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("Back")
      expect(entries[0]?.l1Wallet?.deletedAt).toBeUndefined()
    })

    it("doLoad keeps a numeric deletedAt and drops a malformed one", async () => {
      const { contactStorage, adapter } = setup()
      adapter.seed(
        CONTACT_STORAGE_KEY,
        JSON.stringify([
          {
            name: "Good",
            address: ETH_A,
            addressKind: "ethereum-l1",
            l1Wallet: { provider: "rainbow", provenance: "saved-recipient", deletedAt: 123 },
          },
          {
            name: "Bad",
            address: ETH_B,
            addressKind: "ethereum-l1",
            l1Wallet: { provider: "rainbow", provenance: "saved-recipient", deletedAt: "123" },
          },
        ]),
      )
      await contactStorage.initialize()
      const entries = await contactStorage.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.name).toBe("Good")
      expect(entries[0]?.l1Wallet?.deletedAt).toBe(123)
    })
  })

  describe("rejection recovery (load gate clears on failure)", () => {
    it("retries doLoad after a transient adapter failure on the first call", async () => {
      let getItemCalls = 0
      class FlakyAdapter extends InMemoryStorage {
        async getItem(key: string): Promise<string | null> {
          if (key === CONTACT_STORAGE_KEY) {
            getItemCalls++
            if (getItemCalls === 1) {
              throw new Error("simulated transient failure")
            }
          }
          return super.getItem(key)
        }
      }
      resetSingletons()
      const adapter = new FlakyAdapter()
      const contactStorage = ContactStorage.get(adapter)

      await expect(contactStorage.initialize()).rejects.toThrow("simulated transient failure")

      // Second call must not be locked on the rejected promise — it should
      // run a fresh doLoad and succeed.
      await expect(contactStorage.initialize()).resolves.toBeUndefined()
      expect(getItemCalls).toBe(2)
    })
  })
})

describe("multi-context write safety (web lock + subscribe seam)", () => {
  beforeEach(() => {
    resetSingletons()
  })

  const twoContexts = (
    adapter: IStorageAdapter,
    lock?: <T>(fn: () => Promise<T>) => Promise<T>,
  ) => {
    resetSingletons()
    const a = ContactStorage.get(adapter, lock)
    resetSingletons()
    const b = ContactStorage.get(adapter, lock)
    return { a, b }
  }

  it("overlapping adds from two contexts both survive under the injected lock", async () => {
    const adapter = new DeferredSharedAdapter()
    const mutex = createSharedMutex()
    const { a, b } = twoContexts(adapter, mutex)

    // Both adds in flight at once; each context read an empty book before either write landed.
    const pA = a.addEntry({ name: "Alice", address: ADDR_A, tag: "alice" })
    const pB = b.addEntry({ name: "Bob", address: ADDR_B, tag: "bob" })

    let settled = false
    void Promise.all([pA, pB]).then(() => {
      settled = true
    })
    for (let i = 0; i < 50 && !settled; i++) {
      adapter.flushAllPending()
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(settled).toBe(true)

    const persisted = JSON.parse(adapter.data.get(CONTACT_STORAGE_KEY)!) as Contact[]
    expect(persisted.map((e) => e.name).sort()).toEqual(["Alice", "Bob"])
  })

  it("sequential adds from two stale contexts both survive under the injected lock", async () => {
    const adapter = new SubscribableAdapter()
    const mutex = createSharedMutex()
    const { a, b } = twoContexts(adapter, mutex)
    // Both contexts load the empty book first.
    await a.initialize()
    await b.initialize()

    await a.addEntry({ name: "Alice", address: ADDR_A, tag: "alice" })
    // B's cached view predates A's write; the locked re-read must pick it up.
    await b.addEntry({ name: "Bob", address: ADDR_B, tag: "bob" })

    const entries = await b.getEntries()
    expect(entries.map((e) => e.name).sort()).toEqual(["Alice", "Bob"])
  })

  it("subscribe-driven invalidation reflects another context's write", async () => {
    const adapter = new SubscribableAdapter()
    resetSingletons()
    const storage = ContactStorage.get(adapter)
    expect(await storage.getEntries()).toEqual([])

    // Another context persists a contact, then the storage event fires.
    await adapter.setItem(CONTACT_STORAGE_KEY, JSON.stringify([{ name: "Bob", address: ADDR_B }]))
    adapter.notify(CONTACT_STORAGE_KEY)

    expect((await storage.getEntries()).map((e) => e.name)).toEqual(["Bob"])
  })

  it("without a lock, writes never re-read persisted state", async () => {
    let getItemCalls = 0
    class CountingAdapter extends InMemoryStorage {
      override async getItem(key: string): Promise<string | null> {
        getItemCalls++
        return super.getItem(key)
      }
    }
    resetSingletons()
    const storage = ContactStorage.get(new CountingAdapter())
    await storage.addEntry({ name: "Alice", address: ADDR_A })
    await storage.addEntry({ name: "Bob", address: ADDR_B })
    expect(getItemCalls).toBe(1)
  })
})
