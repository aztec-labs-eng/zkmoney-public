/**
 * Bridge-ins are followed in the background: the tracker asks the provider about every pending
 * record and saves where it ends, whether or not a view is open.
 */
import { createPace } from "@obsidion/core/cadence"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"
import type {
  BridgeInProvider,
  BridgeInRecord,
  BridgeInStatus,
} from "../../src/core/services/crossChain/types"
import {
  bridgeInSentAs,
  createBridgeIns,
  type BridgeIns,
  type BridgeInStart,
} from "../../src/engine/bridgeIns"
import {
  BRIDGE_IN_READS_PER_PASS,
  bridgeInTracker,
  readBridgeIn,
  readSigning,
  SENT_EXPIRY_GRACE_MS as GRACE,
} from "../../src/engine/bridgeInTracker"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { startRuntime, type Runtime } from "../../src/engine/runtime"
import { memoryStore } from "../../src/engine/store"
import { CALL, CANCEL, DEPOSITOR, fakeChain } from "./fakeOriginChain"

const TX_1 = `0x${"ab".repeat(32)}` as Hex
const TX_2 = `0x${"cd".repeat(32)}` as Hex
const FILL = `0x${"ef".repeat(32)}` as Hex
const SPED_UP = `0x${"5e".repeat(32)}` as Hex

const record = (
  originTxHash: Hex,
  over: Partial<BridgeInRecord> = {},
): BridgeInRecord & { originTxHash: Hex } => ({
  id: `bridge-in:${originTxHash}`,
  originTxHash,
  originChainId: 8453,
  depositor: DEPOSITOR,
  recipient: `0x${"f0".repeat(20)}`,
  symbol: "USDC",
  inputAmount: "20500000",
  outputAmount: "20000000000000000000",
  fee: "500000",
  inputDecimals: 6,
  outputSymbol: "DAI",
  outputDecimals: 18,
  status: "pending",
  startTime: 1,
  ...over,
})

/** Saves `saved` as the store holds it. */
const save = (store: BridgeIns, saved: BridgeInRecord) => store.rebuild(saved)

/** The record sent as `hash`. */
const sentAs = async (store: BridgeIns, hash: Hex) =>
  (await store.all()).find((r) => bridgeInSentAs(r, hash))

/** A bridge-in about to be signed, its call `CALL`, its quote expiring at `expiresAt`. */
const signing = (over: Partial<BridgeInStart> = {}, expiresAt?: number): BridgeInStart => ({
  originChainId: 8453,
  depositor: DEPOSITOR,
  recipient: `0x${"f0".repeat(20)}`,
  symbol: "USDC",
  inputDecimals: 6,
  outputSymbol: "DAI",
  outputDecimals: 18,
  quote: {
    inputAmount: 20_500_000n,
    maxInputAmount: 20_500_000n,
    outputAmount: 20n * 10n ** 18n,
    fee: 500_000n,
    fillSeconds: 4,
    expiresAt,
    txs: [{ chainId: 8453, ...CALL }],
  },
  nonceHint: 0,
  startTime: 1,
  ...over,
})

const providerOf = (status: BridgeInProvider["status"]): BridgeInProvider => ({
  quote: vi.fn(),
  status,
})

describe("bridgeInTracker task", () => {
  const runtimes: Runtime[] = []
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.stop()
    vi.useRealTimers()
  })

  function harness(status: BridgeInProvider["status"], store?: BridgeIns, chain = fakeChain()) {
    const db = openDatabase(memoryBackend())
    const bridgeIns = store ?? createBridgeIns({ db })
    const visible = memoryStore(true)
    const provider = providerOf(vi.fn(status))
    const tracker = bridgeInTracker({
      store: bridgeIns,
      provider: () => provider,
      origin: chain.origin,
      now: () => 50,
    })
    const runtime = startRuntime([tracker], {
      db,
      milestones: { after: async () => true, reached: () => false },
      visible: visible.readonly,
      pace: createPace(),
      now: () => Date.now(),
      sinceLoad: () => performance.now(),
    })
    runtimes.push(runtime)
    return { store: bridgeIns, provider, chain, tracker, runtime, visible }
  }

  it("asks only about pending records and saves each one's ending", async () => {
    const store = createBridgeIns({ db: openDatabase(memoryBackend()) })
    await save(store, record(TX_1))
    await save(store, record(TX_2, { status: "refunded", endTime: 5 }))
    const h = harness(async () => ({ status: "expired" }), store)
    await h.runtime.wake(h.tracker)

    expect(h.provider.status).toHaveBeenCalledTimes(1)
    expect(h.provider.status).toHaveBeenCalledWith(8453, TX_1)
    expect(await sentAs(store, TX_1)).toMatchObject({ status: "expired", endTime: 50 })
    expect((await sentAs(store, TX_2))?.endTime).toBe(5)
  })

  it("reads an expired record until the provider reports its refund", async () => {
    const store = createBridgeIns({ db: openDatabase(memoryBackend()) })
    await save(store, record(TX_1, { status: "expired", endTime: 5 }))
    const h = harness(async () => ({ status: "refunded" }), store)
    await h.runtime.wake(h.tracker)

    expect(await sentAs(store, TX_1)).toMatchObject({ status: "refunded", endTime: 50 })
  })

  it("reads a few records a pass, one at a time, taking up where the last pass stopped", async () => {
    const store = createBridgeIns({ db: openDatabase(memoryBackend()) })
    const hashes = Array.from(
      { length: BRIDGE_IN_READS_PER_PASS + 2 },
      (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex,
    )
    for (const hash of hashes) await save(store, record(hash))
    let reading = 0
    let most = 0
    const h = harness(async () => {
      most = Math.max(most, ++reading)
      await Promise.resolve()
      reading--
      return undefined
    }, store)
    const asked = () => (h.provider.status as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    await h.runtime.wake(h.tracker)
    expect(asked()).toHaveLength(BRIDGE_IN_READS_PER_PASS)
    expect(most).toBe(1)
    await h.runtime.wake(h.tracker)
    expect(new Set(asked().slice(0, hashes.length))).toEqual(new Set(hashes))
  })

  it("asks nothing while no bridge-in is pending", async () => {
    const h = harness(async () => ({ status: "pending" }))
    await h.runtime.wake(h.tracker)
    expect(h.provider.status).not.toHaveBeenCalled()
  })

  it("keeps asking every 10 s, every minute hidden, until the bridge fills", async () => {
    vi.useFakeTimers()
    const store = createBridgeIns({ db: openDatabase(memoryBackend()) })
    await save(store, record(TX_1))
    const reply: { status?: BridgeInStatus } = {}
    const h = harness(async () => reply.status, store)
    const reads = () => (h.provider.status as ReturnType<typeof vi.fn>).mock.calls.length
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reads()).toBe(2)
    h.visible.set(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reads()).toBe(3)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(reads()).toBe(3)
    reply.status = { status: "filled", fillTxHash: FILL }
    await vi.advanceTimersByTimeAsync(1)
    expect(reads()).toBe(4)
    expect((await sentAs(store, TX_1))?.status).toBe("filled")
    await vi.advanceTimersByTimeAsync(120_000)
    expect(reads()).toBe(4)
  })

  it("fails a bridge-in whose origin call reverted, and keeps it pending when the receipt read fails", async () => {
    vi.useFakeTimers()
    const store = createBridgeIns({ db: openDatabase(memoryBackend()) })
    await save(store, record(TX_1))
    const chain = fakeChain()
    chain.state.fail = new Error("rpc down")
    const h = harness(async () => undefined, store, chain)
    await vi.advanceTimersByTimeAsync(0)
    expect(chain.origin.receipt).toHaveBeenCalledWith(8453, TX_1)
    expect((await sentAs(store, TX_1))?.status).toBe("pending")
    chain.state.fail = undefined
    chain.mine([{ hash: TX_1, status: "reverted" }])
    // A failed pass backs off before the next.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await sentAs(store, TX_1)).toMatchObject({ status: "failed", endTime: 50 })
    expect(h.provider.status).toHaveBeenCalledTimes(2)
  })

  it("follows a sped-up resend to its hash, and fills it from the provider's word on that hash", async () => {
    vi.useFakeTimers()
    const store = createBridgeIns({ db: openDatabase(memoryBackend()) })
    await save(store, record(TX_1, { call: CALL }))
    const chain = fakeChain()
    chain.history(3)
    chain.send(TX_1, 3)
    const filled = { status: "filled" as const, fillTxHash: FILL }
    const h = harness(async (_, hash) => (hash === SPED_UP ? filled : undefined), store, chain)
    const { id } = (await sentAs(store, TX_1))!
    await vi.advanceTimersByTimeAsync(0)
    // The tracker learns the call's nonce while it waits.
    expect(await sentAs(store, TX_1)).toMatchObject({ status: "pending", nonce: 3 })

    chain.mine([{ hash: SPED_UP, nonce: 3, ...CALL }], 40)
    await vi.advanceTimersByTimeAsync(10_000)
    const moved = await store.get(id)
    expect(moved).toMatchObject({
      originTxHash: SPED_UP,
      replacedHashes: [TX_1],
      nonce: 3,
      status: "filled",
      fillTxHash: FILL,
      endTime: 50,
    })
    expect(h.provider.status).toHaveBeenLastCalledWith(8453, SPED_UP)
    expect(bridgeInSentAs(moved!, TX_1.toUpperCase())).toBe(true)
    expect(await store.all()).toHaveLength(1)
  })

  it("says a bridge-in another call replaced didn't go through", async () => {
    vi.useFakeTimers()
    const store = createBridgeIns({ db: openDatabase(memoryBackend()) })
    await save(store, record(TX_1, { call: CALL, nonce: 0 }))
    const chain = fakeChain()
    chain.mine([{ hash: CANCEL, nonce: 0, to: DEPOSITOR, input: "0x" }])
    harness(async () => undefined, store, chain)
    await vi.advanceTimersByTimeAsync(0)
    expect(await sentAs(store, TX_1)).toMatchObject({ status: "failed", endTime: 50 })
  })

  it("leaves a record pending when its read fails, and backs off when every read does", async () => {
    vi.useFakeTimers()
    const store = createBridgeIns({ db: openDatabase(memoryBackend()) })
    await save(store, record(TX_1))
    const h = harness(async () => Promise.reject(new Error("down")), store)
    const reads = () => (h.provider.status as ReturnType<typeof vi.fn>).mock.calls.length
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(1)
    expect((await sentAs(store, TX_1))?.status).toBe("pending")
    // The first retry waits the base backoff, the next twice that.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(reads()).toBe(3)
  })
})

describe("bridgeInTracker signing and payments", () => {
  const runtimes: Runtime[] = []
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.stop()
    vi.useRealTimers()
  })

  function run(store: BridgeIns, chain: ReturnType<typeof fakeChain>, provider?: BridgeInProvider) {
    const tracker = bridgeInTracker({
      store,
      provider: () => provider,
      origin: chain.origin,
      now: () => 50,
    })
    const runtime = startRuntime([tracker], {
      db: openDatabase(memoryBackend()),
      milestones: { after: async () => true, reached: () => false },
      visible: memoryStore(true).readonly,
      pace: createPace(),
      now: () => Date.now(),
      sinceLoad: () => performance.now(),
    })
    runtimes.push(runtime)
    return () => runtime.wake(tracker)
  }

  it("settles a call signed before a reload by its nonce, then reads it like any other", async () => {
    const store = createBridgeIns({ db: openDatabase(memoryBackend()) })
    const { id } = await store.start(signing({ nonceHint: 2 }))
    const chain = fakeChain()
    chain.history(2)
    const provider = providerOf(
      vi.fn(async () => ({ status: "filled" as const, fillTxHash: FILL })),
    )
    const wake = run(store, chain, provider)
    await wake()
    expect((await store.get(id))?.status).toBe("signing")
    chain.mine([{ hash: TX_1, nonce: 2, ...CALL }])
    await wake()
    expect(await store.get(id)).toMatchObject({ status: "pending", originTxHash: TX_1, nonce: 2 })
    await wake()
    expect(provider.status).toHaveBeenCalledWith(8453, TX_1)
    expect(await store.get(id)).toMatchObject({ status: "filled", endTime: 50 })
  })

  it("settles a signing call with no provider to ask", async () => {
    const store = createBridgeIns({ db: openDatabase(memoryBackend()) })
    const { id } = await store.start(signing())
    const chain = fakeChain()
    chain.mine([{ hash: TX_1, nonce: 0, ...CALL }])
    await run(store, chain)()
    expect(await store.get(id)).toMatchObject({ status: "pending", originTxHash: TX_1 })
  })

  it("fails a signing call whose quote expired with nothing of it mined", async () => {
    const store = createBridgeIns({ db: openDatabase(memoryBackend()) })
    const { id } = await store.start(signing({}, 1_000))
    const chain = fakeChain()
    chain.state.time = 1_000 + GRACE
    const wake = run(store, chain)
    await wake()
    expect((await store.get(id))?.status).toBe("signing")
    chain.state.time = 1_001 + GRACE
    await wake()
    expect(await store.get(id)).toMatchObject({ status: "failed", endTime: 50 })
  })

  it("reads a payment to someone else like any other, and still reads the rest when one read fails", async () => {
    const store = createBridgeIns({ db: openDatabase(memoryBackend()) })
    const pays = { payee: "bob", requestId: "r1" }
    await save(store, record(TX_1, { pays }))
    await save(store, record(TX_2, { pays }))
    const provider = providerOf(
      vi.fn(async (_: number, hash: Hex) => {
        if (hash === TX_1) throw new Error("status read failed")
        return { status: "refunded" as const }
      }),
    )
    await run(store, fakeChain(), provider)()
    expect((await sentAs(store, TX_1))?.status).toBe("pending")
    expect(await sentAs(store, TX_2)).toMatchObject({ status: "refunded", pays, endTime: 50 })
  })
})

describe("readSigning", () => {
  const read = (chain: ReturnType<typeof fakeChain>, over: Partial<BridgeInRecord> = {}) =>
    readSigning(
      record(TX_1, { status: "signing", originTxHash: undefined, call: CALL, ...over }),
      chain.origin,
      9,
    )

  it("finds the call at its hinted nonce or just past it", async () => {
    const at = fakeChain()
    at.mine([{ hash: SPED_UP, nonce: 0, ...CALL }])
    expect(await read(at, { nonceHint: 0 })).toEqual({
      type: "sent",
      originTxHash: SPED_UP,
      nonce: 0,
    })
    const past = fakeChain()
    past.mine([{ hash: CANCEL, nonce: 0, to: DEPOSITOR, input: "0x" }])
    past.mine([{ hash: SPED_UP, nonce: 1, ...CALL }])
    expect(await read(past, { nonceHint: 0 })).toMatchObject({ originTxHash: SPED_UP, nonce: 1 })
  })

  it("waits while the nonces near the hint are unmined or not all taken", async () => {
    const chain = fakeChain()
    expect(await read(chain, { nonceHint: 0 })).toBeUndefined()
    chain.mine([{ hash: CANCEL, nonce: 0, to: DEPOSITOR, input: "0x" }])
    expect(await read(chain, { nonceHint: 0 })).toBeUndefined()
  })

  it("drops a call whose nonces went to other calls", async () => {
    const chain = fakeChain()
    chain.mine(
      Array.from({ length: 5 }, (_, nonce) => ({
        hash: `0x${(nonce + 1).toString(16).padStart(64, "0")}` as Hex,
        nonce,
        input: "0xdead" as Hex,
      })),
    )
    expect(await read(chain, { nonceHint: 0 })).toEqual({ type: "dropped", at: 9 })
  })

  it("drops a call once its quote expired on the origin chain's clock, unless it mined", async () => {
    const chain = fakeChain()
    chain.state.time = 2_000 + GRACE
    expect(await read(chain, { nonceHint: 0, quoteExpiresAt: 1_999 })).toEqual({
      type: "dropped",
      at: 9,
    })
    expect(await read(chain, { nonceHint: 0, quoteExpiresAt: 2_000 })).toBeUndefined()
    // A minute past expiry, the call may still be propagating.
    expect(await read(chain, { nonceHint: 0, quoteExpiresAt: GRACE - 58_000 })).toBeUndefined()
    chain.mine([{ hash: SPED_UP, nonce: 0, ...CALL }])
    expect(await read(chain, { nonceHint: 0, quoteExpiresAt: 1_999 })).toMatchObject({
      type: "sent",
    })
  })
})

describe("readBridgeIn", () => {
  const read = (
    chain: ReturnType<typeof fakeChain>,
    over: Partial<BridgeInRecord> = { call: CALL },
    status: BridgeInStatus | undefined = undefined,
  ) =>
    readBridgeIn(record(TX_1, over), {
      provider: providerOf(async () => status),
      origin: chain.origin,
    })

  it("takes the provider's word over the origin chain's", async () => {
    const chain = fakeChain()
    chain.mine([{ hash: TX_1, status: "reverted" }])
    expect((await read(chain, {}, { status: "filled", fillTxHash: FILL })).status).toEqual({
      status: "filled",
      fillTxHash: FILL,
    })
    expect(chain.origin.receipt).not.toHaveBeenCalled()
  })

  it("fails a bridge-in whose origin call reverted, and keeps one that landed pending", async () => {
    const chain = fakeChain()
    chain.mine([{ hash: TX_1, status: "reverted" }])
    expect((await read(chain)).status).toEqual({ status: "failed" })
    const landed = fakeChain()
    landed.mine([{ hash: TX_1 }])
    expect((await read(landed)).status).toEqual({ status: "pending" })
    expect(landed.origin.minedCount).not.toHaveBeenCalled()
  })

  it("keeps an unmined call pending however long its nonce stays unused", async () => {
    const chain = fakeChain()
    chain.history(2)
    chain.send(TX_1, 2)
    // Other senders' blocks go by.
    chain.mine([{ from: `0x${"99".repeat(20)}`, nonce: 0 }], 10_000)
    const { record: known, status } = await read(chain)
    expect(status).toEqual({ status: "pending" })
    expect(known.nonce).toBe(2)
    // A known nonce is not read again: one count a pass.
    chain.origin.nonce.mockClear()
    await read(chain, { call: CALL, nonce: 2 })
    expect(chain.origin.nonce).not.toHaveBeenCalled()
    expect(chain.origin.minedCount).toHaveBeenCalledTimes(2)
  })

  it("keeps a call the RPC never saw pending, with no hint to find it by", async () => {
    const chain = fakeChain()
    chain.mine([{ hash: CANCEL, nonce: 0, to: DEPOSITOR, input: "0x" }])
    expect(await read(chain)).toMatchObject({ status: { status: "pending" } })
    expect(chain.origin.minedCount).not.toHaveBeenCalled()
  })

  it("moves a bridge-in to the hash of the same call resent with its nonce", async () => {
    const chain = fakeChain()
    chain.history(5)
    chain.send(TX_1, 5)
    chain.mine([{ hash: SPED_UP, nonce: 5, ...CALL }], 3_000)
    chain.mine([{ nonce: 6, hash: CANCEL }], 500)
    const { record: moved, status } = await read(chain, { call: CALL, replacedHashes: [TX_2] })
    expect(moved).toMatchObject({ originTxHash: SPED_UP, nonce: 5, replacedHashes: [TX_2, TX_1] })
    expect(status).toEqual({ status: "pending" })
    // Found by bisecting from the head, not by walking every block.
    expect(chain.origin.minedCount.mock.calls.length).toBeLessThan(40)
    expect(chain.origin.minedIn).toHaveBeenCalledTimes(1)
  })

  it("fails a bridge-in whose nonce another call took", async () => {
    const chain = fakeChain()
    chain.send(TX_1, 0)
    chain.mine([{ hash: CANCEL, nonce: 0, to: DEPOSITOR, input: "0x" }])
    expect((await read(chain)).status).toEqual({ status: "failed" })
    // Another call's data to the same contract is not a resend.
    const other = fakeChain()
    other.mine([{ hash: CANCEL, nonce: 0, input: "0xdead" }])
    expect((await read(other, { call: CALL, nonce: 0 })).status).toEqual({ status: "failed" })
  })

  it("trusts a send-time nonce hint only to find a resend", async () => {
    const resent = fakeChain()
    resent.mine([{ hash: SPED_UP, nonce: 0, ...CALL }])
    const found = await read(resent, { call: CALL, nonceHint: 0 })
    expect(found.record).toMatchObject({ originTxHash: SPED_UP, nonce: 0 })
    expect(found.record).not.toHaveProperty("nonceHint")

    // The hint was off: another call at it says nothing about ours.
    const off = fakeChain()
    off.mine([{ hash: CANCEL, nonce: 0, to: DEPOSITOR, input: "0x" }])
    const missed = await read(off, { call: CALL, nonceHint: 0 })
    expect(missed.status).toEqual({ status: "pending" })
    // With no expiry to end the search, the hint is dropped.
    expect(missed.record).not.toHaveProperty("nonceHint")
  })

  it("follows a resend just past a missed hint", async () => {
    const chain = fakeChain()
    chain.mine([{ hash: CANCEL, nonce: 0, to: DEPOSITOR, input: "0x" }])
    chain.mine([{ hash: SPED_UP, nonce: 1, ...CALL }], 20)
    const found = await read(chain, { call: CALL, nonceHint: 0, quoteExpiresAt: 1_000 })
    expect(found.record).toMatchObject({ originTxHash: SPED_UP, nonce: 1, replacedHashes: [TX_1] })
    expect(found.record).not.toHaveProperty("nonceHint")
    expect(found.status).toEqual({ status: "pending" })
  })

  it("fails a missed hint with no resend near it once the quote expired", async () => {
    const chain = fakeChain()
    chain.mine([{ hash: CANCEL, nonce: 0, to: DEPOSITOR, input: "0x" }])
    chain.mine([{ hash: TX_2, nonce: 1, input: "0xdead" }])
    chain.state.time = 1_000 + GRACE
    const over = { call: CALL, nonceHint: 0, quoteExpiresAt: 1_000 }
    // Not yet past expiry and its grace: the hint is kept for the next read.
    const early = await read(chain, over)
    expect(early.status).toEqual({ status: "pending" })
    expect(early.record.nonceHint).toBe(0)
    chain.state.time = 1_001 + GRACE
    expect((await read(chain, over)).status).toEqual({ status: "failed" })
  })

  it("fails a call nothing mined in place of once its quote expired", async () => {
    const chain = fakeChain()
    chain.history(2)
    chain.state.time = 5_000
    // Unknown to the RPC, its nonce learned on an earlier read and still unused.
    expect(
      (await read(chain, { call: CALL, nonce: 2, quoteExpiresAt: 4_999 - GRACE })).status,
    ).toEqual({
      status: "failed",
    })
    expect(
      (await read(chain, { call: CALL, nonce: 2, quoteExpiresAt: 5_000 - GRACE })).status,
    ).toEqual({
      status: "pending",
    })
    expect((await read(chain, { call: CALL, nonce: 2 })).status).toEqual({ status: "pending" })
    // The RPC still holds it: it either mines and reverts, or is dropped.
    chain.send(TX_1, 2)
    expect(
      (await read(chain, { call: CALL, nonce: 2, quoteExpiresAt: 4_999 - GRACE })).status,
    ).toEqual({
      status: "pending",
    })
    // A send-time hint the chain has not reached counts the same.
    const hinted = fakeChain()
    hinted.history(2)
    hinted.state.time = 5_000
    expect(
      (await read(hinted, { call: CALL, nonceHint: 2, quoteExpiresAt: 4_999 - GRACE })).status,
    ).toEqual({ status: "failed" })
  })

  it("keeps a call the RPC has not seen pending until its quote is past expiry and grace", async () => {
    const chain = fakeChain()
    chain.history(2)
    chain.state.time = GRACE + 60_000
    const sent = { call: CALL, nonce: 2 }
    expect((await read(chain, { ...sent, quoteExpiresAt: GRACE })).status).toEqual({
      status: "pending",
    })
    expect((await read(chain, { ...sent, quoteExpiresAt: 59_999 })).status).toEqual({
      status: "failed",
    })
  })

  it("keeps the provider's word over an expired quote", async () => {
    const chain = fakeChain()
    chain.state.time = 5_000
    const filled: BridgeInStatus = { status: "filled", fillTxHash: FILL }
    expect((await read(chain, { call: CALL, nonce: 0, quoteExpiresAt: 1 }, filled)).status).toBe(
      filled,
    )
  })

  it("keeps an earlier record with no call pending once its nonce passes", async () => {
    const chain = fakeChain()
    chain.mine([{ hash: CANCEL, nonce: 0, to: DEPOSITOR, input: "0x" }])
    expect((await read(chain, { nonce: 0 })).status).toEqual({ status: "pending" })
  })

  it("never fails a bridge-in on a read error", async () => {
    const down = new Error("rpc down")
    const chain = fakeChain()
    chain.send(TX_1, 0)
    chain.mine([{ hash: CANCEL, nonce: 0, to: DEPOSITOR, input: "0x" }])
    chain.origin.minedIn.mockRejectedValueOnce(down)
    await expect(read(chain)).rejects.toBe(down)
  })
})
