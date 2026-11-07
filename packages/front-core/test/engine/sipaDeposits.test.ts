import { describe, expect, it } from "vitest"
import type { Address } from "viem"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"
import { decodeRecord, loadRecords } from "../../src/engine/persistentStore"
import {
  createSipaDeposits,
  BROADCASTS_STORAGE_KEY,
  KEY_SIPA_DEPOSITS,
  sipaCursorKey,
  type SipaDeposit,
  type SipaDepositFields,
} from "../../src/engine/sipaDeposits"

const NETWORK = "0x00000000000000000000000000000000000000e1"
const RECIPIENT = `0x${"2a".repeat(32)}`
const OTHER = `0x${"3b".repeat(32)}`
const A = "0x00000000000000000000000000000000000000A1" as Address
const B = "0x00000000000000000000000000000000000000b2" as Address
const OTHER_SIPA = "0x00000000000000000000000000000000000000c3" as Address
/** A failure text older builds saved, and a blob that does not parse. */
const LEGACY_ERROR = "sweep reverted"
const CORRUPT = "{not json"

const fields = (over: Partial<SipaDeposit> = {}): SipaDepositFields => ({
  sipaAddress: A,
  recipientL2Address: RECIPIENT,
  messageSecret: "0xsecret",
  recipientHash: "0xhash",
  recoveryAddress: "",
  l1ChainId: 1,
  networkId: NETWORK,
  amount: "0",
  tokenSymbol: "DAI",
  phase: "broadcast",
  startTime: 1,
  ...over,
})

function open(backend: MemoryBackend = memoryBackend(), account = true) {
  const db = openDatabase(backend)
  return { db, backend, store: createSipaDeposits({ db, account }) }
}

describe("createSipaDeposits migration", () => {
  it("carries every saved record forward, strips the dead fields and names a failure", async () => {
    const backend = memoryBackend()
    backend.entries.set(
      KEY_SIPA_DEPOSITS,
      JSON.stringify({
        [A.toLowerCase()]: {
          ...fields(),
          lastScannedBlock: "9",
          unresolvedSweepBlocks: ["1"],
          historyScanned: true,
          lastScanAt: 5,
          phase: "failed",
          error: LEGACY_ERROR,
        },
        [B]: { ...fields({ sipaAddress: B, recipientL2Address: OTHER }) },
      }),
    )
    const { store } = open(backend)

    const [a, b] = await loadRecords(store.view)
    expect(a).toMatchObject({
      phase: "failed",
      failure: { code: "unknown", detail: LEGACY_ERROR },
    })
    for (const dead of [
      "error",
      "lastScannedBlock",
      "unresolvedSweepBlocks",
      "historyScanned",
      "lastScanAt",
    ])
      expect(a).not.toHaveProperty(dead)
    expect(b?.sipaAddress).toBe(B)
    expect((await store.byRecipient(OTHER)).map((r) => r.sipaAddress)).toEqual([B])
    // The blob stays for a rollback, and nothing writes it again.
    expect(backend.entries.has(KEY_SIPA_DEPOSITS)).toBe(true)
  })

  it("skips a record that is not one and keeps the rest", async () => {
    const backend = memoryBackend()
    backend.entries.set(
      KEY_SIPA_DEPOSITS,
      JSON.stringify({ broken: { phase: 3 }, list: [1], [A]: fields() }),
    )
    const { store } = open(backend)

    expect((await loadRecords(store.view)).map((r) => r.sipaAddress)).toEqual([A])
  })

  it("opens empty over a blob that does not parse, and keeps the blob", async () => {
    const backend = memoryBackend()
    backend.entries.set(KEY_SIPA_DEPOSITS, CORRUPT)
    const { store } = open(backend)

    expect(await loadRecords(store.view)).toEqual([])
    expect(backend.entries.get(KEY_SIPA_DEPOSITS)).toBe(CORRUPT)
  })

  it("drops the legacy cursors: the first pass reads every history once", async () => {
    const backend = memoryBackend()
    backend.entries.set(`@obsidion/sipa-deposits/observed-through/${A}/${RECIPIENT}`, "100")
    const { db, store } = open(backend)
    await store.ready

    expect(await db.get(sipaCursorKey(A, RECIPIENT))).toBeUndefined()
  })
})

describe("createSipaDeposits broadcast migration", () => {
  const PAGE = "obsidion."
  const ACCOUNT = `${PAGE}acct.`
  const job = (address: string, over: Record<string, unknown> = {}) => ({
    address: address.toLowerCase(),
    kind: "deposit",
    scope: "acct",
    source: { type: "slot", cacheKey: "k", day: 1, nonce: 1 },
    createdAt: 7,
    state: "queued",
    failures: 0,
    ...over,
  })
  const openAccount = (backend: MemoryBackend) => {
    const page = openDatabase(backend)
    return createSipaDeposits({
      db: page.scoped(ACCOUNT),
      account: true,
      legacy: { db: page.scoped(PAGE), scope: "acct" },
    })
  }

  it("folds this namespace's broadcasts into their records, and keeps an owed one with no record", async () => {
    const backend = memoryBackend()
    backend.entries.set(`${ACCOUNT}${KEY_SIPA_DEPOSITS}`, JSON.stringify({ [A]: fields() }))
    const blob = JSON.stringify({
      a: job(A, { lastError: "Waiting for unlock", retryAt: 9 }),
      b: job(B, { failures: 2, lastError: "The network dropped the broadcast" }),
      c: job("0x00000000000000000000000000000000000000c3", { scope: "other" }),
      d: { address: 5 },
    })
    backend.entries.set(`${PAGE}${BROADCASTS_STORAGE_KEY}`, blob)
    const store = openAccount(backend)
    const records = await loadRecords(store.view)

    expect(records.map((r) => [r.sipaAddress.toLowerCase(), r.broadcast?.state])).toEqual([
      [A.toLowerCase(), "queued"],
      [B.toLowerCase(), "queued"],
    ])
    expect(records[0]).toMatchObject({
      recipientL2Address: RECIPIENT,
      broadcast: { wait: "unlock" },
    })
    expect(records[0].broadcast).not.toHaveProperty("address")
    expect(records[1]).toMatchObject({
      recipientL2Address: "",
      broadcast: { failures: 2, failure: { code: "deposit.broadcastDropped" } },
    })
    expect(backend.entries.get(`${PAGE}${BROADCASTS_STORAGE_KEY}`)).toBe(blob)
  })

  it("fills in a record that held only its broadcast when the address is created", async () => {
    const backend = memoryBackend()
    backend.entries.set(`${PAGE}${BROADCASTS_STORAGE_KEY}`, JSON.stringify({ a: job(A) }))
    const store = openAccount(backend)
    await store.apply(A, { type: "discovered", fields: fields() })

    expect(await store.get(A)).toMatchObject({
      recipientL2Address: RECIPIENT,
      networkId: NETWORK,
      slot: { day: 1, nonce: 1 },
      broadcast: { state: "queued", createdAt: 7 },
    })
    expect(await store.byRecipient(RECIPIENT)).toHaveLength(1)
  })

  it("opens a store saved at version 1 at version 3, folding its broadcasts once", async () => {
    const backend = memoryBackend()
    await openAccount(backend).ready
    backend.entries.set(`${ACCOUNT}acct/meta/sipaDeposits`, "1")
    backend.entries.set(`${PAGE}${BROADCASTS_STORAGE_KEY}`, JSON.stringify({ a: job(A) }))
    const store = openAccount(backend)

    expect((await loadRecords(store.view)).map((r) => r.broadcast?.kind)).toEqual(["deposit"])
    expect(backend.entries.get(`${ACCOUNT}acct/meta/sipaDeposits`)).toBe("3")
  })

  it("opens with no broadcasts over a blob that does not parse", async () => {
    const backend = memoryBackend()
    backend.entries.set(`${PAGE}${BROADCASTS_STORAGE_KEY}`, CORRUPT)

    expect(await loadRecords(openAccount(backend).view)).toEqual([])
  })

  it("moves a slot broadcast's day and nonce onto its record", async () => {
    const backend = memoryBackend()
    backend.entries.set(`${PAGE}${BROADCASTS_STORAGE_KEY}`, JSON.stringify({ a: job(A) }))
    const store = openAccount(backend)

    expect(await store.get(A)).toMatchObject({
      slot: { day: 1, nonce: 1 },
      broadcast: { source: { type: "slot" } },
    })
    expect((await store.get(A))?.broadcast?.source).not.toHaveProperty("day")
  })
})

describe("createSipaDeposits slot migration", () => {
  const SLOTS = "webwallet.sipa.address."
  const C = "0x00000000000000000000000000000000000000c3"
  const slot = (address: string, over: Record<string, unknown> = {}) => ({
    address,
    day: 20_000,
    nonce: 99,
    published: false,
    ...over,
  })
  const openAt = (backend: MemoryBackend) => {
    const page = openDatabase(backend)
    return createSipaDeposits({
      db: page.scoped("acct."),
      account: true,
      legacy: { db: page, scope: "acct", slots: page.scoped(SLOTS) },
    })
  }

  it("files each held address's view slot and pool entry on its record, and nothing else", async () => {
    const backend = memoryBackend()
    const held = { [A]: fields(), [B]: fields({ sipaAddress: B }) }
    backend.entries.set(`acct.${KEY_SIPA_DEPOSITS}`, JSON.stringify(held))
    backend.entries.set(
      `${SLOTS}n.t.acct.alice`,
      JSON.stringify(slot(A, { broadcastTxHash: "0x1" })),
    )
    backend.entries.set(
      `${SLOTS}n.t.acct.alice.pool`,
      JSON.stringify([slot(B, { nonce: 98, published: true, deployment: "1:0xp" }), slot(C)]),
    )
    backend.entries.set(`${SLOTS}n.t.acct.bob`, CORRUPT)
    const store = openAt(backend)
    const records = await loadRecords(store.view)

    expect(records.map((r) => r.sipaAddress.toLowerCase())).toEqual([
      A.toLowerCase(),
      B.toLowerCase(),
    ])
    expect(records[0]).toMatchObject({
      slot: { day: 20_000, nonce: 99 },
      broadcast: { kind: "deposit", state: "sent", txHash: "0x1" },
    })
    expect(records[0].broadcast?.shownAt).toBeTypeOf("number")
    expect(records[1]).toMatchObject({
      slot: { day: 20_000, nonce: 98, deployment: "1:0xp" },
      broadcast: { kind: "pool", state: "landed" },
    })
  })

  it("never hands out again an address an older build showed: only its saved pool stays the pool", async () => {
    const backend = memoryBackend()
    const D = "0x00000000000000000000000000000000000000d4" as Address
    const held = Object.fromEntries(
      [A, B, C, D].map((a) => [a.toLowerCase(), fields({ sipaAddress: a as Address })]),
    )
    backend.entries.set(`acct.${KEY_SIPA_DEPOSITS}`, JSON.stringify(held))
    const deployment = "1:0xp"
    const landed = (address: string, over: Record<string, unknown> = {}) => ({
      address: address.toLowerCase(),
      kind: "pool",
      scope: "acct",
      source: { type: "slot", cacheKey: "k", day: 20_000, nonce: 90, deployment },
      createdAt: 7,
      state: "landed",
      failures: 0,
      ...over,
    })
    // A was taken from the pool and is the view's address; B the pool still holds; C was taken
    // and since replaced; D was shown while its broadcast still proved.
    backend.entries.set(
      BROADCASTS_STORAGE_KEY,
      JSON.stringify({
        a: landed(A),
        b: landed(B),
        c: landed(C),
        d: landed(D, { kind: "deposit", shownAt: 3 }),
      }),
    )
    backend.entries.set(`${SLOTS}n.t.acct.alice`, JSON.stringify(slot(A, { published: true })))
    backend.entries.set(
      `${SLOTS}n.t.acct.alice.pool`,
      JSON.stringify([slot(B, { published: true, deployment })]),
    )
    const store = openAt(backend)

    for (const address of [A, C]) {
      expect((await store.get(address))?.broadcast).toMatchObject({
        kind: "deposit",
        state: "landed",
      })
      expect((await store.get(address))?.broadcast?.shownAt).toBeTypeOf("number")
    }
    expect((await store.get(D))?.broadcast).toMatchObject({ kind: "deposit", shownAt: 3 })
    expect((await store.handOut([A, C, D, B], 9))?.sipaAddress.toLowerCase()).toBe(B.toLowerCase())
    expect(await store.handOut([A, C, D, B], 10)).toBeUndefined()
  })

  it("keeps a published view slot's record without a broadcast to owe", async () => {
    const backend = memoryBackend()
    backend.entries.set(`acct.${KEY_SIPA_DEPOSITS}`, JSON.stringify({ [A]: fields() }))
    backend.entries.set(`${SLOTS}n.t.acct.alice`, JSON.stringify(slot(A, { published: true })))

    const record = await openAt(backend).get(A)
    expect(record?.slot).toEqual({ day: 20_000, nonce: 99 })
    expect(record?.broadcast).toBeUndefined()
  })
})

describe("createSipaDeposits", () => {
  it("hears a registration address's first funds once, whichever write saved them", async () => {
    const db = openDatabase(memoryBackend())
    let funded = 0
    const store = createSipaDeposits({ db, account: true, funded: () => void funded++ })
    const held = (sipaAddress: Address, heldBalance: string) =>
      [sipaAddress, { type: "observed", fields: { heldBalance } }] as const
    const seed = { type: "seeded" as const, fields: fields({ intent: "registration" }) }
    await store.apply(A, seed)
    await store.apply(B, { ...seed, fields: { ...seed.fields, sipaAddress: B } })
    await store.apply(OTHER_SIPA, {
      type: "discovered",
      fields: fields({ sipaAddress: OTHER_SIPA }),
    })
    // A pass saves inside its own write; a check commits its own.
    await expect(
      db.write(async (w) => {
        await store.applyAll([held(B, "5")], w)
        throw new Error("the pass did not save")
      }),
    ).rejects.toThrow()
    // The write that failed showed nothing: B's next change, still with no funds, says none.
    await store.apply(B, { type: "observed", fields: { observedFrom: "1" } })
    expect(funded).toBe(0)
    await db.write((w) => store.applyAll([held(A, "5")], w))
    expect(funded).toBe(1)
    await store.apply(...held(B, "5"))
    expect(funded).toBe(2)
    await store.apply(...held(A, "6"))
    await store.apply(...held(OTHER_SIPA, "5"))
    expect(funded).toBe(2)
  })

  it("takes a registration seed only in an account's namespace", async () => {
    const { store } = open(memoryBackend(), false)

    await expect(store.apply(A, { type: "seeded", fields: fields() })).rejects.toMatchObject({
      code: "wallet.notReady",
    })
    expect(await loadRecords(store.view)).toEqual([])
    // A visitor's own deposits still file.
    expect(await store.apply(A, { type: "discovered", fields: fields() })).toMatchObject({
      sipaAddress: A,
    })
  })

  it("saves a record whole, keyed by its lowercase address, and adopts a record once", async () => {
    const { backend, store } = open()
    expect(await store.adopt(fields())).toBe(true)
    expect(await store.adopt(fields({ amount: "9" }))).toBe(false)

    const raw = backend.entries.get(`acct/sipaDeposits/${A.toLowerCase()}`)!
    expect(decodeRecord(raw)).toMatchObject({ sipaAddress: A, amount: "0" })
    expect(await store.get(A.toLowerCase())).toMatchObject({ amount: "0" })
  })

  it("removes a misfiled record with its index entry", async () => {
    const { backend, store } = open()
    await store.adopt(fields({ intent: "registration", replayed: true }))

    await store.apply(A, { type: "misfiled" })

    expect(await store.get(A)).toBeUndefined()
    expect(await store.byRecipient(RECIPIENT)).toEqual([])
    expect([...backend.entries.keys()].filter((k) => k.includes(A.toLowerCase()))).toEqual([])
  })

  it("stamps the sweep rows of version 1 records alone", async () => {
    const { store } = open()
    await store.adopt(
      fields({ version: 1, sweeps: [{ inboxIndex: "1", sweepTxHash: "0x1", netAmount: "1" }] }),
    )
    await store.adopt(fields({ sipaAddress: B, version: 2 }))
    const pinned = {
      portal: A,
      l2Token: "0xl2",
      token: { address: A, symbol: "DAI", decimals: 18 },
    }

    const stamped = await store.stampSweepRows(NETWORK, pinned)

    expect(stamped.map((r) => r.sipaAddress)).toEqual([A])
    expect(await store.stampSweepRows(NETWORK, pinned)).toEqual([])
  })

  it("hands a pooled address out once, as one write that takes it out of the pool", async () => {
    const { store, db } = open()
    const pool = { kind: "pool", source: { type: "slot" } } as const
    for (const sipaAddress of [A, B])
      await store.applyAll([
        [
          sipaAddress,
          { type: "derived", fields: fields({ sipaAddress, slot: { day: 1, nonce: 1 } }) },
        ],
        [sipaAddress, { type: "broadcastOwed", address: sipaAddress, owed: pool, at: 1 }],
      ])
    await store.apply(A, { type: "broadcastLanded" })
    let commits = 0
    db.onCommit(() => void commits++)

    const [first, second] = await Promise.all([store.handOut([A, B], 5), store.handOut([A, B], 5)])

    expect(first?.sipaAddress).toBe(A)
    expect(first?.broadcast).toMatchObject({ kind: "deposit", state: "landed", shownAt: 5 })
    expect(second?.sipaAddress).toBe(B)
    expect(await store.handOut([A, B], 6)).toBeUndefined()
    expect(commits).toBe(2)
  })
})
