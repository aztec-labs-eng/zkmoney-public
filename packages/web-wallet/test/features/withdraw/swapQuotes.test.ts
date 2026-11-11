// @vitest-environment node
/**
 * A swap route's quote: simulated on its source's deployment again every 30 s while a view shows it
 * and the page is visible, closed when a simulation fails, and never shown for inputs the user has
 * moved past.
 */
import { createPace } from "@obsidion/core/cadence"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { memoryStore, queries, type QueryState } from "@obsidion/front-core"
import {
  shownQuote,
  SWAP_QUOTE_MAX_AGE_MS,
  SWAP_QUOTE_REFRESH_MS,
  swapQuotes,
  type SwapKey,
  type SwapQuoteDeps,
} from "../../../src/features/withdraw/swapQuotes"
import type { SwapQuote } from "../../../src/features/withdraw/withdrawQuote"

const fee = (swapRelayerTip: bigint) => ({
  withdrawalFee: 1n,
  withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
  swapRelayerTip,
  proverTip: 0n,
  floorAtomic: 1n + WITHDRAW_RELAYER_TIP + swapRelayerTip,
})
const quote = (swapRelayerTip: bigint): SwapQuote => ({ fee: fee(swapRelayerTip) })
const key = (amountAtomic: bigint, over: Partial<SwapKey> = {}): SwapKey => ({
  source: "active",
  output: "USDC",
  amountAtomic,
  proverTip: 0n,
  daiForGas: 0n,
  ...over,
})
const flush = () => vi.advanceTimersByTimeAsync(0)

const ACTIVE = { portal: "0xactive" } as OxideEnvTuple
const OLD = { portal: "0xold" } as OxideEnvTuple

/** A page whose simulations answer `simulate`, the active deployment's and the old token's. */
function page(simulate: SwapQuoteDeps["simulate"]) {
  const visible = memoryStore(true)
  const query = queries({ pace: createPace(), visible: visible.readonly, now: () => Date.now() })
  const deps = { active: async () => ACTIVE, token: async () => OLD, simulate }
  return { visible, quotes: swapQuotes(query, deps) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("swapQuotes", () => {
  it("simulates again every 30 s while a view shows the route, and stops once it leaves", async () => {
    const simulate = vi.fn<SwapQuoteDeps["simulate"]>(async () => quote(3n))
    const entry = page(simulate).quotes(key(5n))
    const off = entry.subscribe(() => {})
    await flush()
    await vi.advanceTimersByTimeAsync(SWAP_QUOTE_REFRESH_MS)
    expect(simulate).toHaveBeenCalledTimes(2)
    off()
    await vi.advanceTimersByTimeAsync(3 * SWAP_QUOTE_REFRESH_MS)
    expect(simulate).toHaveBeenCalledTimes(2)
  })

  it("simulates nothing while the page is hidden, and again at once when it shows", async () => {
    const simulate = vi.fn<SwapQuoteDeps["simulate"]>(async () => quote(3n))
    const { visible, quotes } = page(simulate)
    quotes(key(5n)).subscribe(() => {})
    await flush()
    visible.set(false)
    await vi.advanceTimersByTimeAsync(3 * SWAP_QUOTE_REFRESH_MS)
    expect(simulate).toHaveBeenCalledTimes(1)
    visible.set(true)
    await flush()
    expect(simulate).toHaveBeenCalledTimes(2)
  })

  it("shares one simulation between two views of the same inputs", async () => {
    const simulate = vi.fn<SwapQuoteDeps["simulate"]>(async () => quote(3n))
    const { quotes } = page(simulate)
    quotes(key(5n)).subscribe(() => {})
    quotes(key(5n)).subscribe(() => {})
    await flush()
    expect(simulate).toHaveBeenCalledTimes(1)
  })

  it("prices each source on its own deployment", async () => {
    const { quotes } = page(async (_, tuple) => quote(tuple === OLD ? 4n : 3n))
    await expect(quotes(key(5n)).read()).resolves.toEqual(quote(3n))
    await expect(quotes(key(5n, { source: "0xoldtoken" })).read()).resolves.toEqual(quote(4n))
  })

  it("simulates again as a view opens on a quote two refreshes old", async () => {
    const entry = page(async () => quote(3n)).quotes(key(5n))
    entry.subscribe(() => {})()
    await flush()
    await vi.advanceTimersByTimeAsync(SWAP_QUOTE_MAX_AGE_MS)
    entry.subscribe(() => {})
    expect(entry.get()).toMatchObject({ status: "ready", refreshing: true })
  })

  it("closes the route when a simulation fails, a re-run too: there is no fallback tip", async () => {
    let fail = false
    const { quotes } = page(async () => {
      if (fail) throw new Error("rpc down")
      return quote(3n)
    })
    const entry = quotes(key(5n))
    entry.subscribe(() => {})
    await flush()
    const typed = key(5n)
    expect(shownQuote(typed, { key: typed, state: entry.get() }).status).toBe("ready")
    fail = true
    await vi.advanceTimersByTimeAsync(SWAP_QUOTE_REFRESH_MS)
    expect(shownQuote(typed, { key: typed, state: entry.get() }).status).toBe("unavailable")
  })
})

describe("shownQuote", () => {
  const ready = (value: SwapQuote, refreshing = false, error?: Error): QueryState<SwapQuote> =>
    error ? { status: "ready", value, refreshing, error } : { status: "ready", value, refreshing }
  const pending: QueryState<SwapQuote> = { status: "pending" }
  const failed: QueryState<SwapQuote> = { status: "failed", error: new Error("rpc down") }
  const typed = key(6n)

  it.each([
    ["the typed inputs' quote", { key: typed, state: ready(quote(4n)) }, undefined, "ready", 4n],
    [
      "the typed inputs' quote while it is simulated again",
      { key: typed, state: ready(quote(4n), true) },
      undefined,
      "ready",
      4n,
    ],
    ["a failed simulation", { key: typed, state: failed }, undefined, "unavailable", undefined],
    [
      "a failed re-run",
      { key: typed, state: ready(quote(4n), false, new Error("rpc down")) },
      undefined,
      "unavailable",
      undefined,
    ],
    [
      "inputs held before, priced",
      { key: key(5n), state: ready(quote(3n)) },
      undefined,
      "loading",
      3n,
    ],
    [
      "the typed inputs loading, after inputs priced",
      { key: typed, state: pending },
      { key: key(5n), state: ready(quote(3n)) },
      "loading",
      3n,
    ],
    [
      "another deployment's quote",
      { key: key(5n, { source: "old-token" }), state: ready(quote(3n)) },
      undefined,
      "loading",
      undefined,
    ],
    [
      "the typed inputs loading, after another route",
      { key: typed, state: pending },
      { key: key(5n, { output: "ETH" }), state: ready(quote(3n)) },
      "loading",
      undefined,
    ],
    [
      "a route held in between",
      { key: key(6n, { output: "DAI" }), state: pending },
      { key: key(5n), state: ready(quote(3n)) },
      "loading",
      undefined,
    ],
  ] as const)("shows %s", (_, held, before, status, tip) => {
    const shown = shownQuote(typed, held, before)
    expect(shown.status).toBe(status)
    expect(shown.fee?.swapRelayerTip).toBe(tip)
  })
})
