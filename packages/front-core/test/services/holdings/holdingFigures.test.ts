// @vitest-environment node
import { describe, expect, it } from "vitest"
import { zeroAddress, type Address } from "viem"
import { createPace } from "@obsidion/core/cadence"
import type { Holding } from "@obsidion/core/oxide"
import {
  HOLDING_PRICE_EVERY_MS,
  RATE_SCALE,
  RATE_WINDOW_BLOCKS,
  holdingPrices,
  selectHoldingFigures,
} from "../../../src/core/services/holdings/holdingFigures"
import type { HoldingPrice } from "../../../src/core/services/holdings/holdingFigures"
import type { LedgerMove } from "../../../src/engine/holdingLedger"
import { queries } from "../../../src/engine/query"
import type { QueryState } from "../../../src/engine/query"
import { memoryStore } from "../../../src/engine/store"
import { FakeL1 } from "../../oxide/pipeline/fakeL1"

const ONE = 10n ** 18n
const vault = (n: number) => `0x${String(n).padStart(2, "0").repeat(20)}` as Address
const holdingOn = (address: string) => ({ held: { underlying: address } } as Pick<Holding, "held">)

/**
 * An L1 whose vaults' share price is `now` at the head and `then` before it, which counts the most
 * vaults whose price it is answering at once.
 */
function vaultL1(vaults: Address[], now: bigint, then = ONE, head = 1_000_000n) {
  const l1 = new FakeL1({ factory: zeroAddress, table: zeroAddress, portals: [] })
  l1.head = head
  for (const v of vaults) l1.vault(v, 18, (block) => (block === head ? now : then))
  const reading = new Set<string>()
  let mostAtOnce = 0
  l1.before = async (call) => {
    if (call.fn !== "convertToAssets") return
    reading.add(call.to!)
    mostAtOnce = Math.max(mostAtOnce, reading.size)
    await new Promise((resolve) => setTimeout(resolve, 1))
    reading.delete(call.to!)
  }
  return { l1, mostAtOnce: () => mostAtOnce }
}

function world(l1: FakeL1) {
  let t = 1_000
  const query = queries({ pace: createPace(), visible: memoryStore(true).readonly, now: () => t })
  return {
    prices: holdingPrices(query, l1.client, () => t),
    pass: (ms: number) => (t += ms),
  }
}

/** The head, decimals and price reads `l1` has answered. */
const readsOf = (l1: FakeL1) => [
  l1.count({ method: "eth_blockNumber" }),
  l1.count({ fn: "decimals" }),
  l1.count({ fn: "convertToAssets" }),
]

const GROWN = (1001n * ONE) / 1000n
const HEAD = 1_000_000n

describe("holdingPrices", () => {
  it("reads the head once a pass and three holdings at a time; the decimals once", async () => {
    const vaults = [1, 2, 3, 4, 5].map(vault)
    const { l1, mostAtOnce } = vaultL1(vaults, GROWN)
    const { prices, pass } = world(l1)
    const read = () => Promise.all(vaults.map((v) => prices(holdingOn(v)).read()))

    const first = await read()
    expect(first.map((p) => p.sharePrice)).toEqual(vaults.map(() => GROWN))
    expect(readsOf(l1)).toEqual([1, 5, 10])
    expect(mostAtOnce()).toBe(3)

    await read()
    expect(readsOf(l1)).toEqual([1, 5, 10])

    pass(HOLDING_PRICE_EVERY_MS)
    await read()
    expect(readsOf(l1)).toEqual([2, 5, 20])
  })

  it.each([
    {
      case: "a falling price is negative",
      then: ONE,
      now: (999n * ONE) / 1000n,
      rate: 0.999 ** 52 - 1,
    },
    { case: "a zero earlier price has none", then: 0n, now: GROWN },
    { case: "a failed earlier read has none", then: ONE, now: GROWN, pruned: true },
    {
      case: "a chain younger than a window has none",
      then: ONE,
      now: GROWN,
      head: RATE_WINDOW_BLOCKS,
    },
  ])("rate: $case", async ({ then, now, rate, pruned, head = HEAD }) => {
    const { l1 } = vaultL1([vault(1)], now, then, head)
    if (pruned) l1.failing = (call) => call.block === HEAD - RATE_WINDOW_BLOCKS
    const price = await world(l1)
      .prices(holdingOn(vault(1)))
      .read()

    expect(price).toMatchObject({ sharePrice: now, shareDecimals: 18, readAt: 1_000 })
    if (rate === undefined) expect(price.rate).toBeUndefined()
    else expect(Number(price.rate) / Number(RATE_SCALE)).toBeCloseTo(rate, 12)
    // The latest price, and the price a window before the head when the chain is that old.
    expect(l1.calls.filter((c) => c.fn === "convertToAssets").map((c) => c.block)).toEqual(
      head > RATE_WINDOW_BLOCKS ? [undefined, head - RATE_WINDOW_BLOCKS] : [undefined],
    )
  })

  it("fails a holding whose head or price read fails, and the next pass retries it in budget", async () => {
    const vaults = [1, 2, 3, 4].map(vault)
    const { l1, mostAtOnce } = vaultL1(vaults, GROWN)
    const { prices, pass } = world(l1)
    const read = async () =>
      (await Promise.allSettled(vaults.map((v) => prices(holdingOn(v)).read()))).map(
        (r) => r.status,
      )
    const spent = async (expected: string[]) => {
      const before = readsOf(l1)
      expect(await read()).toEqual(expected)
      return readsOf(l1).map((n, i) => n - before[i]!)
    }
    const ALL = vaults.map(() => "fulfilled")

    l1.failing = (call) => call.method === "eth_blockNumber"
    await spent(vaults.map(() => "rejected"))
    l1.failing = () => false
    // The head is read again; the decimals read beside the failed head are not.
    expect(await spent(ALL)).toEqual([1, 0, 8])
    expect(l1.count({ fn: "decimals" })).toBe(4)

    pass(HOLDING_PRICE_EVERY_MS)
    l1.failing = (call) => call.to === vaults[0] && call.fn === "convertToAssets" && !call.block
    expect(await spent(["rejected", ...ALL.slice(1)])).toEqual([1, 0, 8])
    expect(prices(holdingOn(vaults[0]!)).get()).toMatchObject({
      status: "ready",
      value: { sharePrice: GROWN },
      error: expect.anything(),
    })
    expect(mostAtOnce()).toBe(3)
  })
})

describe("selectHoldingFigures", () => {
  const SCOPE = "s"
  const line = { l2Token: "0xAB", holdingIds: ["fea-sky-v5", "fea-sky-v6"] }
  const price: HoldingPrice = {
    sharePrice: (107n * ONE) / 100n,
    shareDecimals: 18,
    rate: RATE_SCALE / 20n,
    readAt: 1,
  }
  const ready: QueryState<HoldingPrice> = { status: "ready", value: price, refreshing: false }
  const balances = (atomic: bigint) => ({
    records: [{ scope: SCOPE, token: "0xab", atomic }],
    loaded: true,
    failed: false,
  })
  const moveIn = (holdingId: string, cost: bigint, shares: bigint): LedgerMove => ({
    id: holdingId,
    holdingId,
    direction: "in",
    amount: cost,
    phase: "claimed",
    quote: { conversionOut: cost },
    deposit: { amount: shares },
    startTime: 0,
    endTime: 1,
  })
  const moves = [
    moveIn("fea-sky-v5", 100n * ONE, 100n * ONE),
    moveIn("fea-sky-v6", 7n * ONE, 5n * ONE),
    moveIn("fea-vault-v6", 50n * ONE, 50n * ONE),
  ]

  it("values the shares at the price, and earns on the moves of every holding on the token", () => {
    expect(
      selectHoldingFigures(line, ready, balances(105n * ONE), SCOPE, moves, new Map()),
    ).toEqual({
      shares: 105n * ONE,
      rate: RATE_SCALE / 20n,
      value: (11235n * ONE) / 100n,
      earned: (11235n * ONE) / 100n - 107n * ONE,
      earnedPending: false,
    })
  })

  it("keeps a price through a failed re-read, and has no value before the price or the shares", () => {
    const kept = { ...ready, error: new Error("down") }
    const held = balances(105n * ONE)
    expect(selectHoldingFigures(line, kept, held, SCOPE, moves, new Map()).value).toBe(
      (11235n * ONE) / 100n,
    )
    const failed: QueryState<HoldingPrice> = { status: "failed", error: new Error("down") }
    expect(selectHoldingFigures(line, failed, held, SCOPE, moves, new Map())).toEqual({
      shares: 105n * ONE,
      earnedPending: false,
    })
    const unread = { records: [], loaded: false, failed: false }
    expect(selectHoldingFigures(line, ready, unread, SCOPE, moves, new Map())).toEqual({
      rate: RATE_SCALE / 20n,
      earnedPending: false,
    })
  })
})
