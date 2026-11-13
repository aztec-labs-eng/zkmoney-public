import { describe, expect, it } from "vitest"
import { zeroAddress, type Address } from "viem"
import { withdrawCoinRead } from "../../../src/features/withdraw/withdrawCoinBalance"

const L1 = 1
const BASE = 8453
const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
const L1_USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7"
const L1_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
const L1_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
const routes = [
  { chain: { chainId: BASE }, tokens: [{ symbol: "USDC", address: BASE_USDC }] },
] as unknown as Parameters<typeof withdrawCoinRead>[2]["routes"]
const l1Tokens = [
  { symbol: "DAI", address: L1_DAI },
  { symbol: "USDC", address: L1_USDC },
  { symbol: "USDT", address: L1_USDT },
]
const ctx = { l1ChainId: L1, routes, l1Tokens }

describe("withdrawCoinRead", () => {
  it("reads DAI on the L1 as the deployment's token, at $1", () => {
    expect(withdrawCoinRead("DAI", L1, ctx)).toEqual({
      l1: true,
      token: undefined,
      pricing: "nominal",
    })
  })

  it("reads ETH on the L1 as the gas coin, at the ETH price", () => {
    expect(withdrawCoinRead("ETH", L1, ctx)).toEqual({
      l1: true,
      token: zeroAddress,
      pricing: "eth",
    })
  })

  it("reads another L1 coin as the deposit table's token of that symbol", () => {
    expect(withdrawCoinRead("USDT", L1, ctx)).toEqual({
      l1: true,
      token: L1_USDT,
      pricing: "nominal",
    })
  })

  it("reads nothing for an L1 coin the table has not listed or is unread", () => {
    expect(withdrawCoinRead("USDC", L1, { ...ctx, l1Tokens: [l1Tokens[0]!] })).toBeUndefined()
    expect(withdrawCoinRead("USDT", L1, { ...ctx, l1Tokens: undefined })).toBeUndefined()
  })

  it("prices only the deposit table's coins at $1, as the deposit picker does", () => {
    expect(withdrawCoinRead("USDC", BASE, { ...ctx, l1Tokens: [l1Tokens[0]!] })?.pricing).toBe(
      undefined,
    )
    expect(withdrawCoinRead("DAI", L1, { ...ctx, l1Tokens: undefined })?.pricing).toBeUndefined()
  })

  it("reads a bridge chain's coin as the route's token there", () => {
    expect(withdrawCoinRead("USDC", BASE, ctx)).toEqual({
      l1: false,
      token: BASE_USDC,
      pricing: "nominal",
    })
  })

  it("reads nothing for a coin or chain without a route", () => {
    expect(withdrawCoinRead("USDT", BASE, ctx)).toBeUndefined()
    expect(withdrawCoinRead("USDC", 10, ctx)).toBeUndefined()
  })
})
