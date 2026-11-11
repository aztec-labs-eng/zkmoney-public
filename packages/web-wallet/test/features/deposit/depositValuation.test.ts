// @vitest-environment node
/** The USD valuation the published limit reads for a picked deposit token. */
import { describe, expect, it } from "vitest"
import { NOMINAL_USD_VALUATION } from "@obsidion/front-core"
import { depositValuation } from "../../../src/features/deposit/depositValuation"
import { ROW_SUSDS, savingsRowTokens, tokenOption } from "../../support/depositTokens"

describe("depositValuation", () => {
  it("values a token Main offers at the nominal rate, whatever the address's case", () => {
    const tokens = savingsRowTokens()
    const dai = tokens.offered[0]!
    expect(depositValuation(dai, tokens)).toBe(NOMINAL_USD_VALUATION)
    const lower = { address: dai.address.toLowerCase() as typeof dai.address }
    expect(depositValuation(lower, tokens)).toBe(NOMINAL_USD_VALUATION)
  })

  it("has no valuation for a row token Main does not offer", () => {
    expect(depositValuation(tokenOption("sUSDS", ROW_SUSDS), savingsRowTokens())).toBeUndefined()
  })
})
