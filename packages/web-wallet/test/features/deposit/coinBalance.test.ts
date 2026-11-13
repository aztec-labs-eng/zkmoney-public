import { describe, expect, it } from "vitest"
import type { QueryState } from "@obsidion/front-core"
import {
  balanceAccount,
  coinBalanceFigure,
  coinPricing,
  coinUsdRate,
  readValue,
} from "../../../src/features/deposit/coinBalance"

const coins = [{ symbol: "USDC" }, { symbol: "USDT" }, { symbol: "DAI" }]
const NOMINAL = { numerator: 1n, denominator: 1n }

describe("coinBalanceFigure", () => {
  it("shows a held balance with its decimals, and its value at the rate", () => {
    expect(coinBalanceFigure(1_500_000n, 6, NOMINAL)).toEqual({
      atomic: 1_500_000n,
      decimals: 6,
      usd: 15n * 10n ** 17n,
    })
  })

  it("shows no value without a rate", () => {
    expect(coinBalanceFigure(10n ** 18n, 18, undefined)).toEqual({
      atomic: 10n ** 18n,
      decimals: 18,
    })
  })

  it("hides a zero balance", () => {
    expect(coinBalanceFigure(0n, 18, NOMINAL)).toBeUndefined()
  })

  it("hides a balance whose amount or decimals are unread", () => {
    expect(coinBalanceFigure(undefined, 18, NOMINAL)).toBeUndefined()
    expect(coinBalanceFigure(5n, undefined, NOMINAL)).toBeUndefined()
  })
})

describe("coinPricing", () => {
  it("values the L1 deposit coins at a nominal dollar on any chain", () => {
    expect(coins.every((c) => coinPricing(coins, c.symbol) === "nominal")).toBe(true)
  })

  it("prices ETH and WETH with the ETH feed, and another gas coin not at all", () => {
    expect(coinPricing(coins, "ETH")).toBe("eth")
    expect(coinPricing(coins, "WETH")).toBe("eth")
    expect(coinPricing(coins, "HYPE")).toBeUndefined()
  })
})

describe("coinUsdRate", () => {
  it("values half an ETH at half the feed's answer", () => {
    const rate = coinUsdRate("eth", { answer: 3_000n * 10n ** 8n, feedDecimals: 8n })
    expect(coinBalanceFigure(5n * 10n ** 17n, 18, rate)?.usd).toBe(1_500n * 10n ** 18n)
  })

  it("has no ETH rate until the feed is read", () => {
    expect(coinUsdRate("eth", undefined)).toBeUndefined()
  })
})

describe("readValue", () => {
  it("reads nothing while pending or failed", () => {
    const pending: QueryState<bigint> = { status: "pending" }
    const failed: QueryState<bigint> = { status: "failed", error: new Error("rpc") }
    expect(readValue(pending)).toBeUndefined()
    expect(readValue(failed)).toBeUndefined()
  })

  it("keeps the last value when a re-read fails", () => {
    const stale: QueryState<bigint> = {
      status: "ready",
      value: 7n,
      refreshing: false,
      error: new Error("rpc"),
    }
    expect(readValue(stale)).toBe(7n)
  })
})

describe("balanceAccount", () => {
  const SAVED = "0x1111111111111111111111111111111111111111" as const
  const CONNECTED = "0x2222222222222222222222222222222222222222" as const

  it("shows the saved wallet a flow started from, over another connected account", () => {
    expect(balanceAccount({ address: SAVED }, CONNECTED)).toBe(SAVED)
  })

  it("shows the saved wallet before any wallet connects", () => {
    expect(balanceAccount({ address: SAVED }, null)).toBe(SAVED)
  })

  it("shows the connected account without a saved wallet, and nothing without either", () => {
    expect(balanceAccount(undefined, CONNECTED)).toBe(CONNECTED)
    expect(balanceAccount(undefined, null)).toBeUndefined()
  })
})
