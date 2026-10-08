/**
 * The deposit sheet's valuation is matched by token address on the configured chain. Only the dev
 * demo, which offers mainnet USDC and USDT on any chain, falls back to their mainnet identity.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { NOMINAL_USD_VALUATION } from "@obsidion/front-core"

const demo = vi.hoisted(() => ({ on: false }))
vi.mock("../src/dev/demoFlag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dev/demoFlag")>()),
  isDemoMode: () => demo.on,
}))

const { depositValuation } = await import("../src/features/deposit/depositValuation")

const SANDBOX = 31337
const MANIFEST = "0xb0de1000000000000000000000000000000b01d0" as Address
const USDC = {
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
  symbol: "USDC",
  decimals: 6,
  icon: "",
}
const SETTLEMENT = { symbol: "DAI", decimals: 18, icon: "" }

beforeEach(() => {
  demo.on = false
})

describe("depositValuation", () => {
  it("values the chain's own settlement token", () => {
    expect(depositValuation(SETTLEMENT, MANIFEST, SANDBOX)).toBe(NOMINAL_USD_VALUATION)
  })

  it("does not value mainnet USDC off mainnet outside the demo", () => {
    expect(depositValuation(USDC, MANIFEST, SANDBOX)).toBeUndefined()
  })

  it("values mainnet USDC by its mainnet identity in the dev demo", () => {
    demo.on = true
    expect(depositValuation(USDC, MANIFEST, SANDBOX)).toBe(NOMINAL_USD_VALUATION)
  })

  it("still refuses an unlisted token in the dev demo", () => {
    demo.on = true
    const other = { ...USDC, address: "0x1111111111111111111111111111111111111111" as Address }
    expect(depositValuation(other, MANIFEST, SANDBOX)).toBeUndefined()
  })
})
