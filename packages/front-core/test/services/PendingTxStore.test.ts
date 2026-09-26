import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PendingTxRecord } from "@obsidion/sdk"

import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../__test-helpers__/resetSingleton"
import { EncryptedStorageAdapter } from "../../src/core/storages/EncryptedStorageAdapter"
import type { CryptoProvider } from "../../src/core/storages/CryptoProvider"
import {
  CLOCK_SKEW_MARGIN_MS,
  KEY_PENDING,
  MAX_TX_LIFETIME_MS,
  PendingTxStore,
  decodeRecord,
} from "../../src/core/services/pending-tx"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Identity-cipher CryptoProvider — preserves plaintext on the wire so tests
 * can assert ciphertext shape without re-implementing AEAD. To verify "no
 * plaintext leaks" properties we use a separate masking provider.
 */
function passThroughProvider(): CryptoProvider {
  return {
    async encrypt(p) {
      return p
    },
    async decrypt(c) {
      return c
    },
    keyAvailable() {
      return true
    },
    onKeyChanged() {
      return () => {}
    },
  }
}

/**
 * XOR-based provider — masks plaintext with a fixed key so the inner
 * IStorageAdapter sees ciphertext, not plaintext. Decrypt errors produce a
 * thrown error (not silent corruption).
 */
function xorProvider(keyHex: string): CryptoProvider {
  const key = new Uint8Array(keyHex.length / 2)
  for (let i = 0; i < key.length; i++) {
    key[i] = parseInt(keyHex.substring(i * 2, i * 2 + 2), 16)
  }
  function transform(bytes: Uint8Array): Uint8Array {
    const out = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key[i % key.length]
    return out
  }
  function fnv32(bytes: Uint8Array): number {
    let h = 0x811c9dc5
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i]
      h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
  }
  return {
    async encrypt(plaintext) {
      const pt = new TextEncoder().encode(plaintext)
      const ct = transform(pt)
      let hex = ""
      for (const b of ct) hex += b.toString(16).padStart(2, "0")
      return `${hex}:${fnv32(pt).toString(16)}`
    },
    async decrypt(ciphertext) {
      const [hex, tag] = ciphertext.split(":")
      if (!hex || !tag) throw new Error("malformed envelope")
      const ct = new Uint8Array(hex.length / 2)
      for (let i = 0; i < ct.length; i++) {
        ct[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
      }
      const pt = transform(ct)
      const expected = fnv32(pt).toString(16)
      if (expected !== tag) throw new Error("authentication failure")
      return new TextDecoder().decode(pt)
    },
    keyAvailable() {
      return true
    },
    onKeyChanged() {
      return () => {}
    },
  }
}

let nextHashSeed = 1
function nextTxHash(): string {
  return "0x" + (nextHashSeed++).toString(16).padStart(64, "0")
}

function makeRecord(overrides: Partial<PendingTxRecord> = {}): PendingTxRecord {
  const now = overrides.submittedAt ?? Date.now()
  return {
    txHash: overrides.txHash ?? nextTxHash(),
    expiresAtMs: overrides.expiresAtMs ?? now + 60_000,
    submittedAt: now,
  }
}

async function newStore(): Promise<{
  store: PendingTxStore
  inner: InMemoryStorageAdapter
  adapter: EncryptedStorageAdapter
}> {
  resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
  const inner = new InMemoryStorageAdapter()
  const adapter = new EncryptedStorageAdapter(inner, passThroughProvider())
  const store = PendingTxStore.get(adapter)
  await store.load()
  return { store, inner, adapter }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PendingTxStore — construction and brand check", () => {
  beforeEach(() => {
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
  })

  it("rejects a plain (unwrapped) IStorageAdapter", () => {
    const inner = new InMemoryStorageAdapter()
    expect(() => PendingTxStore.get(inner)).toThrow(/EncryptedStorageAdapter/)
  })

  it("accepts an EncryptedStorageAdapter and returns the same instance on subsequent calls", () => {
    const inner = new InMemoryStorageAdapter()
    const adapter = new EncryptedStorageAdapter(inner, passThroughProvider())
    const a = PendingTxStore.get(adapter)
    const b = PendingTxStore.get()
    expect(a).toBe(b)
  })
})

describe("PendingTxStore — happy path round-trip", () => {
  beforeEach(() => {
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
  })

  it("create → get round-trips a record", async () => {
    const { store } = await newStore()
    const record = makeRecord()
    await store.create(record)

    const got = await store.get(record.txHash)
    expect(got).toEqual(record)
  })

  it("create → list returns the record", async () => {
    const { store } = await newStore()
    const record = makeRecord()
    await store.create(record)

    const list = await store.list()
    expect(list.length).toBe(1)
    expect(list[0]!.txHash).toBe(record.txHash)
  })

  it("patch updates fields in place; get returns the updated record", async () => {
    const { store } = await newStore()
    const record = makeRecord()
    await store.create(record)

    const later = record.expiresAtMs + 5_000
    const patched = await store.patch(record.txHash, { expiresAtMs: later })
    expect(patched).toBe(true)

    const got = await store.get(record.txHash)
    expect(got!.expiresAtMs).toBe(later)
  })

  it("patch on a non-existent record returns false", async () => {
    const { store } = await newStore()
    const ok = await store.patch("0x" + "00".repeat(32), { expiresAtMs: Date.now() })
    expect(ok).toBe(false)
  })

  it("remove deletes the record; subsequent get returns undefined", async () => {
    const { store } = await newStore()
    const record = makeRecord()
    await store.create(record)
    await store.remove(record.txHash)
    expect(await store.get(record.txHash)).toBeUndefined()
    expect((await store.list()).length).toBe(0)
  })

  it("clearAll empties every record", async () => {
    const { store } = await newStore()
    await store.create(makeRecord({ txHash: "0x" + "aa".repeat(32) }))
    await store.create(makeRecord({ txHash: "0x" + "bb".repeat(32) }))
    await store.clearAll()
    expect((await store.list()).length).toBe(0)
  })
})

describe("PendingTxStore — persisted blobs with extra fields", () => {
  beforeEach(() => {
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
  })

  const legacyWire = {
    txHash: "0x" + "cc".repeat(32),
    txNonce: "0x1234",
    from: "0x" + "aabbccdd".padStart(64, "0"),
    executionPayload: { calls: [], authWitnesses: [], capsules: [], extraHashedArgs: [] },
    feeOptions: { gasSettings: { gasLimits: { daGas: 1, l2Gas: 2 } } },
    expiresAtMs: 1_800_000_000_000,
    submittedAt: 1_700_000_000_000,
    kind: "send",
  }

  it("decodeRecord projects a wire object carrying extra keys to the slim record", () => {
    const decoded = decodeRecord(legacyWire as never)
    expect(decoded).toEqual({
      txHash: legacyWire.txHash,
      expiresAtMs: legacyWire.expiresAtMs,
      submittedAt: legacyWire.submittedAt,
    })
  })

  it("load() keeps a stored record that carries extra keys and lists it slim", async () => {
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    const inner = new InMemoryStorageAdapter()
    const adapter = new EncryptedStorageAdapter(inner, passThroughProvider())
    await adapter.setItem(KEY_PENDING, JSON.stringify({ [legacyWire.txHash]: legacyWire }))

    const store = PendingTxStore.get(adapter)
    await store.load()

    const all = [...(await store.list()), ...(await store.listExpired())]
    expect(all.length).toBe(1)
    expect(all[0]).toEqual({
      txHash: legacyWire.txHash,
      expiresAtMs: legacyWire.expiresAtMs,
      submittedAt: legacyWire.submittedAt,
    })
  })

  it("load() drops a stored record whose surviving keys are malformed", async () => {
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    const inner = new InMemoryStorageAdapter()
    const adapter = new EncryptedStorageAdapter(inner, passThroughProvider())
    const bad = { ...legacyWire, submittedAt: "not-a-number" }
    await adapter.setItem(KEY_PENDING, JSON.stringify({ [bad.txHash]: bad }))

    const store = PendingTxStore.get(adapter)
    await store.load()

    expect((await store.list()).length).toBe(0)
    expect((await store.listExpired()).length).toBe(0)
  })

  const valid = makeRecord({ txHash: "0x" + "dd".repeat(32) })
  const malformedEntries: Array<[string, unknown]> = [
    ["a null entry", null],
    ["an entry without txHash", { expiresAtMs: valid.expiresAtMs, submittedAt: valid.submittedAt }],
    ["an entry with a numeric txHash", { txHash: 42, expiresAtMs: valid.expiresAtMs, submittedAt: valid.submittedAt }],
  ]

  for (const [label, bad] of malformedEntries) {
    it(`load() drops ${label} by its stored key and keeps the valid neighbour`, async () => {
      resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
      const inner = new InMemoryStorageAdapter()
      const adapter = new EncryptedStorageAdapter(inner, passThroughProvider())
      await adapter.setItem(KEY_PENDING, JSON.stringify({ "bad-key": bad, [valid.txHash]: valid }))

      const store = PendingTxStore.get(adapter)
      await store.load()

      expect(await store.list()).toEqual([valid])
      expect(await store.listExpired()).toEqual([])
      expect(await store.get("bad-key")).toBeUndefined()
      expect(Object.keys(JSON.parse((await adapter.getItem(KEY_PENDING)) as string))).toEqual([valid.txHash])
    })
  }
})

describe("PendingTxStore — encryption", () => {
  beforeEach(() => {
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
  })

  it("the underlying IStorageAdapter sees ciphertext only — no plaintext tx hash", async () => {
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    const inner = new InMemoryStorageAdapter()
    const adapter = new EncryptedStorageAdapter(inner, xorProvider("00112233445566778899aabbccddeeff"))
    const store = PendingTxStore.get(adapter)
    await store.load()

    const record = makeRecord({ txHash: "0x" + "11223344556677889900aabbccddeeff".repeat(2) })
    await store.create(record)

    const stored = await inner.getItem(KEY_PENDING)
    expect(stored).not.toBeNull()
    expect(stored).not.toContain(record.txHash)
    expect(stored).not.toContain(record.txHash.slice(2))
  })

  it("tampered ciphertext makes getItem throw rather than return corrupted data", async () => {
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    const inner = new InMemoryStorageAdapter()
    const adapter = new EncryptedStorageAdapter(inner, xorProvider("0011223344556677"))
    // Round-trip: write a record then mutate the underlying ciphertext.
    const store = PendingTxStore.get(adapter)
    await store.load()
    await store.create(makeRecord())
    const stored = (await inner.getItem(KEY_PENDING))!
    const tampered = stored[0] === "0" ? "1" + stored.slice(1) : "0" + stored.slice(1)
    await inner.setItem(KEY_PENDING, tampered)

    // Re-create a fresh store instance to force a fresh load.
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    const nextStore = PendingTxStore.get(
      new EncryptedStorageAdapter(inner, xorProvider("0011223344556677")),
    )
    // The tampered envelope throws inside RecordStorage.load — caught and
    // logged as a warning. The list should be empty rather than corrupted.
    await nextStore.load()
    expect((await nextStore.list()).length).toBe(0)
  })

  it("rotated key (fresh install) drops old records on load rather than crashing", async () => {
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    const inner = new InMemoryStorageAdapter()
    const adapter = new EncryptedStorageAdapter(inner, xorProvider("0011223344556677"))
    const store = PendingTxStore.get(adapter)
    await store.load()
    await store.create(makeRecord())

    // Simulate a fresh install: same inner storage, different key.
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    const rotated = PendingTxStore.get(
      new EncryptedStorageAdapter(inner, xorProvider("ffffffffffffffff")),
    )
    await rotated.load()
    expect((await rotated.list()).length).toBe(0)
  })
})

/** A provider whose key can be locked: while locked, encrypt and decrypt both throw, as a locked MSK does. */
function lockableProvider(inner: CryptoProvider): CryptoProvider & { locked: boolean } {
  const provider = {
    locked: false,
    async encrypt(p: string) {
      if (provider.locked) throw new Error("MSK is not available")
      return inner.encrypt(p)
    },
    async decrypt(c: string) {
      if (provider.locked) throw new Error("MSK is not available")
      return inner.decrypt(c)
    },
    keyAvailable: () => !provider.locked,
    onKeyChanged: () => () => {},
  }
  return provider
}

describe("PendingTxStore — load while the key is locked", () => {
  beforeEach(() => {
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
  })

  const seeded = async () => {
    const inner = new InMemoryStorageAdapter()
    const first = PendingTxStore.get(new EncryptedStorageAdapter(inner, passThroughProvider()))
    await first.load()
    const saved = makeRecord()
    await first.create(saved)
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    const crypto = lockableProvider(passThroughProvider())
    crypto.locked = true
    const store = PendingTxStore.get(new EncryptedStorageAdapter(inner, crypto))
    return { inner, crypto, store, saved }
  }

  it("a locked load is retried once the key unlocks and the saved record comes back", async () => {
    const { crypto, store, saved } = await seeded()

    await store.load()
    expect(await store.list()).toHaveLength(0)

    crypto.locked = false
    await store.load()
    expect((await store.list()).map((r) => r.txHash)).toEqual([saved.txHash])
  })

  it("a record created after unlock keeps the record saved before the restart", async () => {
    const { inner, crypto, store, saved } = await seeded()

    await store.load()
    crypto.locked = false
    const fresh = makeRecord()
    await store.create(fresh)

    const blob = JSON.parse((await inner.getItem(KEY_PENDING))!) as Record<string, unknown>
    expect(Object.keys(blob).sort()).toEqual([saved.txHash, fresh.txHash].map((h) => h.toLowerCase()).sort())
  })

  it("a record created while locked is merged in when the key unlocks", async () => {
    const { inner, crypto, store, saved } = await seeded()

    await store.load()
    const whileLocked = makeRecord()
    await store.create(whileLocked)

    crypto.locked = false
    await store.load()
    const listed = (await store.list()).map((r) => r.txHash).sort()
    expect(listed).toEqual([saved.txHash, whileLocked.txHash].sort())
    const blob = JSON.parse((await inner.getItem(KEY_PENDING))!) as Record<string, unknown>
    expect(Object.keys(blob)).toHaveLength(2)
  })

  it("an unreadable blob under a working key is replaced by the next write", async () => {
    const inner = new InMemoryStorageAdapter()
    await inner.setItem(KEY_PENDING, "not-a-valid-envelope")
    const store = PendingTxStore.get(new EncryptedStorageAdapter(inner, xorProvider("0011223344556677")))

    await store.load()
    const fresh = makeRecord()
    await store.create(fresh)

    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    const reopened = PendingTxStore.get(new EncryptedStorageAdapter(inner, xorProvider("0011223344556677")))
    await reopened.load()
    expect((await reopened.list()).map((r) => r.txHash)).toEqual([fresh.txHash])
  })
})

describe("PendingTxStore — TTL passive eviction", () => {
  beforeEach(() => {
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-30T12:00:00.000Z"))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("a record past TTL appears in listExpired() but NOT in list(); get() returns undefined", async () => {
    const { store } = await newStore()
    const now = Date.now()
    const record = makeRecord({
      submittedAt: now,
      expiresAtMs: now + 1000,
      txHash: "0x" + "11".repeat(32),
    })
    await store.create(record)

    expect((await store.list()).length).toBe(1)
    expect((await store.listExpired()).length).toBe(0)

    // Jump past expiry + clock-skew margin.
    vi.setSystemTime(new Date(now + 1000 + CLOCK_SKEW_MARGIN_MS + 100))

    expect((await store.list()).length).toBe(0)
    expect((await store.listExpired()).length).toBe(1)
    expect(await store.get(record.txHash)).toBeUndefined()
  })

  it("the underlying blob is preserved across passive eviction (only removeExpired deletes it)", async () => {
    const { store, inner } = await newStore()
    const now = Date.now()
    const record = makeRecord({
      submittedAt: now,
      expiresAtMs: now + 1000,
      txHash: "0x" + "22".repeat(32),
    })
    await store.create(record)

    vi.setSystemTime(new Date(now + 1000 + CLOCK_SKEW_MARGIN_MS + 100))
    expect((await store.list()).length).toBe(0)

    const blob = await inner.getItem(KEY_PENDING)
    expect(blob).not.toBeNull()
    expect(blob!.length).toBeGreaterThan(0)

    await store.removeExpired(record.txHash)
    expect((await store.listExpired()).length).toBe(0)
  })

  it("TTL ceiling enforces MAX_TX_LIFETIME (24h) even if expiresAtMs is later", async () => {
    const { store } = await newStore()
    const now = Date.now()
    const record = makeRecord({
      submittedAt: now - 25 * 3600 * 1000,
      // expiresAtMs claims another 24h, but the ceiling ties at submittedAt + 24h.
      expiresAtMs: now + 1_000_000,
      txHash: "0x" + "33".repeat(32),
    })
    await store.create(record)

    expect((await store.list()).length).toBe(0)
    expect((await store.listExpired()).length).toBe(1)
  })

  it("a record submittedAt -23h with expiresAtMs at +24h is still live", async () => {
    const { store } = await newStore()
    const now = Date.now()
    const record = makeRecord({
      submittedAt: now - 23 * 3600 * 1000,
      expiresAtMs: now + 3600 * 1000,
      txHash: "0x" + "44".repeat(32),
    })
    await store.create(record)

    expect((await store.list()).length).toBe(1)
    expect((await store.listExpired()).length).toBe(0)
  })

  it("TTL: per-tx expiry (5h ago, expires after 4h) is in listExpired even though under MAX_TX_LIFETIME", async () => {
    const { store } = await newStore()
    const now = Date.now()
    const record = makeRecord({
      submittedAt: now - 5 * 3600 * 1000,
      expiresAtMs: now - 1 * 3600 * 1000, // i.e. submittedAt + 4h, already past
      txHash: "0x" + "55".repeat(32),
    })
    await store.create(record)

    expect((await store.list()).length).toBe(0)
    expect((await store.listExpired()).length).toBe(1)
  })

  it("TTL clock-skew margin: expiresAtMs = now - 10s is still live; -60s is expired", async () => {
    const { store } = await newStore()
    const now = Date.now()
    const live = makeRecord({
      submittedAt: now - 60_000,
      expiresAtMs: now - 10_000,
      txHash: "0x" + "66".repeat(32),
    })
    const dead = makeRecord({
      submittedAt: now - 120_000,
      expiresAtMs: now - 60_000,
      txHash: "0x" + "77".repeat(32),
    })
    await store.create(live)
    await store.create(dead)

    const liveList = await store.list()
    const expiredList = await store.listExpired()
    expect(liveList.map((r) => r.txHash)).toContain(live.txHash)
    expect(liveList.map((r) => r.txHash)).not.toContain(dead.txHash)
    expect(expiredList.map((r) => r.txHash)).toContain(dead.txHash)
    expect(expiredList.map((r) => r.txHash)).not.toContain(live.txHash)
  })

  it("removeExpired throws on a non-expired record (defense-in-depth)", async () => {
    const { store } = await newStore()
    const record = makeRecord({ txHash: "0x" + "88".repeat(32) })
    await store.create(record)
    await expect(store.removeExpired(record.txHash)).rejects.toThrow(/not expired/)
  })
})

describe("PendingTxStore — concurrency and listeners", () => {
  beforeEach(() => {
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
  })

  it("two create calls for the same txHash → last-write-wins, single record", async () => {
    const { store } = await newStore()
    const txHash = "0x" + "99".repeat(32)
    const now = Date.now()
    await store.create(makeRecord({ txHash, submittedAt: now, expiresAtMs: now + 10_000 }))
    await store.create(makeRecord({ txHash, submittedAt: now, expiresAtMs: now + 20_000 }))

    const list = await store.list()
    expect(list.length).toBe(1)
    expect(list[0]!.expiresAtMs).toBe(now + 20_000)
  })

  it("onUpdated fires for create / patch / remove with the changed txHash", async () => {
    const { store } = await newStore()
    const events: string[] = []
    const unsub = store.onUpdated((h) => events.push(h))

    const record = makeRecord({ txHash: "0x" + "aa".repeat(32) })
    await store.create(record)
    await store.patch(record.txHash, { expiresAtMs: record.expiresAtMs + 1 })
    await store.remove(record.txHash)

    expect(events.length).toBe(3)
    expect(events.every((e) => e === record.txHash)).toBe(true)
    unsub()
  })

  it("storage state survives clear-in-memory + recreate + load round-trip", async () => {
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    const inner = new InMemoryStorageAdapter()
    const adapter = new EncryptedStorageAdapter(inner, xorProvider("0011223344556677"))
    const a = PendingTxStore.get(adapter)
    await a.load()
    const record = makeRecord({ txHash: "0x" + "bb".repeat(32) })
    await a.create(record)

    // Drop the in-memory singleton — keep the same inner storage so the
    // ciphertext blob persists. Re-create with the same key and load.
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    const b = PendingTxStore.get(
      new EncryptedStorageAdapter(inner, xorProvider("0011223344556677")),
    )
    await b.load()
    const got = await b.get(record.txHash)
    expect(got).toEqual(record)
  })
})

describe("PendingTxStore — interface conformance", () => {
  it("is type-assignable to IPendingTxStore", async () => {
    const inner = new InMemoryStorageAdapter()
    const adapter = new EncryptedStorageAdapter(inner, passThroughProvider())
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    // Compile-time assignability check. Runtime is a no-op.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _check: import("@obsidion/sdk").IPendingTxStore = PendingTxStore.get(adapter)
    expect(_check).toBeDefined()
  })
})

void MAX_TX_LIFETIME_MS // referenced for export coverage
