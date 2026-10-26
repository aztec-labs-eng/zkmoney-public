/** The deposit sheet's valuation: nominal for every token Main offers, matched by address. */
import { describe, expect, it } from "vitest"
import type { Address } from "viem"
import { NOMINAL_USD_VALUATION } from "@obsidion/front-core"
import { depositValuation } from "../src/features/deposit/depositValuation"

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address
const SUSDS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD" as Address
const accepted = { offered: [{ address: DAI }, { address: USDC }] } as Parameters<
  typeof depositValuation
>[1]

describe("depositValuation", () => {
  it("values each accepted token at the nominal rate", () => {
    expect(depositValuation({ address: DAI }, accepted)).toBe(NOMINAL_USD_VALUATION)
    expect(depositValuation({ address: USDC.toLowerCase() as Address }, accepted)).toBe(
      NOMINAL_USD_VALUATION,
    )
  })

  it("refuses a token Main does not offer, such as Savings' sUSDS", () => {
    const other = "0x1111111111111111111111111111111111111111" as Address
    expect(depositValuation({ address: other }, accepted)).toBeUndefined()
    expect(depositValuation({ address: SUSDS }, accepted)).toBeUndefined()
  })
})
