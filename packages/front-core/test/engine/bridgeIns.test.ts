import { describe, expect, it } from "vitest"
import type { Address, Hex } from "viem"
import type {
  BridgeInQuote,
  BridgeInRecord,
  BridgeInStatus,
} from "../../src/core/services/crossChain/types"
import {
  bridgeInPaying,
  bridgeInTransition,
  createBridgeIns,
  type BridgeInEvent,
  type BridgeInStart,
} from "../../src/engine/bridgeIns"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"

const PAID = `0x${"d1".repeat(20)}` as Hex
const TX_1 = `0x${"b1".repeat(32)}` as Hex
const TX_2 = `0x${"b2".repeat(32)}` as Hex
const SPOKE = `0x${"b5".repeat(20)}` as Address
const bridged = (over: Partial<BridgeInRecord> = {}): BridgeInRecord => ({
  id: "bridge-in:1",
  originTxHash: TX_1,
  originChainId: 8453,
  depositor: `0x${"a1".repeat(20)}`,
  recipient: PAID,
  symbol: "USDC",
  inputAmount: "20500000",
  outputAmount: "20000000000000000000",
  fee: "500000",
  inputDecimals: 6,
  outputSymbol: "DAI",
  outputDecimals: 18,
  status: "filled",
  startTime: 1,
  ...over,
})

const quote: BridgeInQuote = {
  inputAmount: 20_500_000n,
  maxInputAmount: 20_600_000n,
  outputAmount: 20n * 10n ** 18n,
  fee: 500_000n,
  fillSeconds: 4,
  expiresAt: 60_000,
  txs: [
    { chainId: 8453, to: `0x${"c0".repeat(20)}`, data: "0x095e" },
    { chainId: 8453, to: SPOKE, data: "0xb0b0" },
  ],
}
const start = (over: Partial<BridgeInStart> = {}): BridgeInStart => ({
  originChainId: 8453,
  depositor: `0x${"a1".repeat(20)}`,
  recipient: PAID,
  symbol: "USDC",
  inputDecimals: 6,
  outputSymbol: "DAI",
  outputDecimals: 18,
  quote,
  nonceHint: 7,
  startTime: 5,
  ...over,
})

describe("bridgeInPaying", () => {
  it("finds the bridge-in signing, bridging to or that paid an address, whatever its case", () => {
    const filled = bridged()
    expect(bridgeInPaying([filled], PAID.toUpperCase())).toBe(filled)
    expect(bridgeInPaying([bridged({ recipient: PAID.toUpperCase() as Hex })], PAID)).toBeDefined()
    for (const status of ["pending", "signing"] as const) {
      const delivering = bridged({ status })
      expect(bridgeInPaying([delivering], PAID)).toBe(delivering)
    }
  })

  it("finds none for a returned bridge-in, another address, or a payment to someone else", () => {
    for (const status of ["refunded", "expired"] as const)
      expect(bridgeInPaying([bridged({ status })], PAID)).toBeUndefined()
    expect(bridgeInPaying([bridged()], `0x${"e9".repeat(20)}`)).toBeUndefined()
    expect(bridgeInPaying([bridged({ pays: { payee: "bob" } })], PAID)).toBeUndefined()
    expect(bridgeInPaying([], PAID)).toBeUndefined()
  })

  it("passes over a returned one to the filled one for the same address", () => {
    const filled = bridged({ id: "bridge-in:2", originTxHash: TX_2 })
    expect(bridgeInPaying([bridged({ status: "refunded" }), filled], PAID)).toBe(filled)
  })
})

describe("bridgeInTransition", () => {
  const reported = (status: BridgeInStatus) => ({ type: "reported", status, at: 9 } as const)
  const signing = bridgeInTransition(undefined, {
    type: "started",
    id: "bridge-in:s",
    start: start({ pays: { payee: "bob", requestId: "r" }, feeUsd: "0.50" }),
  })!

  it("starts a signing record from the quote, once", () => {
    expect(signing).toEqual({
      id: "bridge-in:s",
      originChainId: 8453,
      depositor: `0x${"a1".repeat(20)}`,
      recipient: PAID,
      symbol: "USDC",
      inputDecimals: 6,
      outputSymbol: "DAI",
      outputDecimals: 18,
      inputAmount: "20500000",
      outputAmount: "20000000000000000000",
      fee: "500000",
      feeUsd: "0.50",
      status: "signing",
      call: { to: SPOKE, data: "0xb0b0" },
      nonceHint: 7,
      quoteExpiresAt: 60_000,
      startTime: 5,
      pays: { payee: "bob", requestId: "r" },
    })
    const again = { type: "started", id: "bridge-in:s", start: start() } as const
    expect(bridgeInTransition(signing, again)).toBeUndefined()
  })

  it("moves a signing record to pending with its hash, and takes a hash only once", () => {
    const sent = bridgeInTransition(signing, { type: "sent", originTxHash: TX_1 })
    expect(sent).toMatchObject({ status: "pending", originTxHash: TX_1 })
    expect(sent?.replacedHashes).toBeUndefined()
    expect(bridgeInTransition(sent, { type: "sent", originTxHash: TX_1 })).toBeUndefined()
    expect(bridgeInTransition(undefined, { type: "sent", originTxHash: TX_1 })).toBeUndefined()
  })

  it("takes a resend's hash, keeping the ones it replaced, and never an old one back", () => {
    const pending = bridged({ status: "pending", nonce: 3 })
    const resent = bridgeInTransition(pending, { type: "sent", originTxHash: TX_2, nonce: 3 })
    expect(resent).toMatchObject({ originTxHash: TX_2, replacedHashes: [TX_1], nonce: 3 })
    expect(bridgeInTransition(resent, { type: "sent", originTxHash: TX_1 })).toBeUndefined()
    expect(bridgeInTransition(bridged(), { type: "sent", originTxHash: TX_2 })).toBeUndefined()
  })

  it("drops only a signing record, stamping its end", () => {
    const dropped = { type: "dropped", at: 9 } as const
    expect(bridgeInTransition(signing, dropped)).toMatchObject({ status: "failed", endTime: 9 })
    expect(bridgeInTransition(bridged({ status: "pending" }), dropped)).toBeUndefined()
    expect(bridgeInTransition(undefined, dropped)).toBeUndefined()
  })

  it("stamps the end once a pending bridge-in fills or comes back", () => {
    const pending = bridged({ status: "pending" })
    expect(bridgeInTransition(pending, reported({ status: "pending" }))).toBeUndefined()
    expect(bridgeInTransition(pending, reported({ status: "refunded" }))).toMatchObject({
      status: "refunded",
      endTime: 9,
    })
  })

  it("moves an expired bridge-in only to refunded", () => {
    const expired = bridged({ status: "expired", endTime: 5 })
    expect(bridgeInTransition(expired, reported({ status: "refunded" }))).toMatchObject({
      status: "refunded",
      endTime: 9,
    })
    for (const status of ["pending", "expired", "failed"] as const)
      expect(bridgeInTransition(expired, reported({ status }))).toBeUndefined()
  })

  it("leaves an ended, signing or missing bridge-in as a report or read finds it", () => {
    const read = { type: "read", nonce: 3 } as const
    for (const current of [bridged(), signing, undefined]) {
      expect(bridgeInTransition(current, reported({ status: "refunded" }))).toBeUndefined()
      expect(bridgeInTransition(current, read)).toBeUndefined()
    }
  })

  it("rebuilds over any record but a filled one", () => {
    const rebuilt = bridged({ replayed: true })
    const event = { type: "rebuilt", record: rebuilt } as const
    expect(bridgeInTransition(undefined, event)).toBe(rebuilt)
    for (const status of ["pending", "failed", "expired", "refunded"] as const)
      expect(bridgeInTransition(bridged({ status }), event)).toBe(rebuilt)
    expect(bridgeInTransition(bridged(), event)).toBeUndefined()
  })

  it("takes only the nonce and the hint from a read", () => {
    const pending = bridged({ status: "pending", nonceHint: 2 })
    const next = bridgeInTransition(pending, { type: "read", nonce: 3 })
    expect(next).toMatchObject({ status: "pending", symbol: "USDC", nonce: 3 })
    expect(next?.nonceHint).toBeUndefined()
  })
})

describe("createBridgeIns", () => {
  it("saves a started record durably, then its hash, across a reload", async () => {
    const backend = memoryBackend()
    const ids = ["a", "b"]
    const first = createBridgeIns({ db: openDatabase(backend), newId: () => ids.shift()! })
    const record = await first.start(start())
    expect(record).toMatchObject({ id: "bridge-in:a", status: "signing" })
    const reloaded = createBridgeIns({ db: openDatabase(backend) })
    expect(await reloaded.get("bridge-in:a")).toEqual(record)
    expect(await reloaded.markSent("bridge-in:a", TX_1)).toMatchObject({ originTxHash: TX_1 })
    expect(await reloaded.markSent("bridge-in:a", TX_1)).toBeUndefined()
    expect(await first.start(start())).toMatchObject({ id: "bridge-in:b" })
  })

  it("applies several events in one write, skipping those that do not apply", async () => {
    const store = createBridgeIns({ db: openDatabase(memoryBackend()), newId: () => "a" })
    const { id } = await store.start(start())
    const events: BridgeInEvent[] = [
      { type: "read", nonce: 1 },
      { type: "sent", originTxHash: TX_1, nonce: 7 },
      { type: "reported", status: { status: "refunded" }, at: 9 },
    ]
    expect(await store.apply(id, events)).toMatchObject({
      status: "refunded",
      originTxHash: TX_1,
      nonce: 7,
      endTime: 9,
    })
    expect(await store.apply(id, [{ type: "dropped", at: 10 }])).toBeUndefined()
  })

  it("rebuilds over the record sent as the same hash, and keeps a filled one", async () => {
    const store = createBridgeIns({ db: openDatabase(memoryBackend()), newId: () => "a" })
    const { id } = await store.start(start())
    await store.markSent(id, TX_1)
    await store.apply(id, [{ type: "sent", originTxHash: TX_2 }])
    const { id: _, ...rebuilt } = bridged({ originTxHash: TX_2, replayed: true })
    expect(await store.rebuild(rebuilt)).toMatchObject({ id, status: "filled", replayed: true })
    expect(await store.rebuild({ ...rebuilt, status: "refunded" })).toBeUndefined()
    expect(await store.all()).toHaveLength(1)
  })
})
