// @vitest-environment node
/** The row a funding token settles on, the funding tokens' labels, and fee and price figures. */
import { parseUnits } from "viem"
import { describe, expect, it } from "vitest"
import {
  MAINNET_DAI,
  MAINNET_USDC,
  mainnetTokens,
  ROW_SUSDS,
  ROW_USDC,
  savingsRowTokens,
  singleToken,
  twoRowTokens,
} from "../../support/depositTokens"
import { settlementToken } from "../../../src/features/sipa/loadDepositFacts"
import { tokenFigure } from "../../../src/ui/format"
import { fmt } from "../../../src/lib/fmt"
import {
  formatDepositAmount,
  fundingAssetsLabel,
  swapAssetsLabel,
} from "../../../src/features/deposit/DepositTermsRows/DepositTermsRows"
import copy from "../../../src/features/deposit/DepositTermsRows/DepositTermsRows.copy"

describe("what a row's token credits", () => {
  it("finds the row a funding token settles on", () => {
    expect(settlementToken(twoRowTokens(), ROW_USDC)).toBe(ROW_USDC)
    expect(settlementToken(mainnetTokens(), MAINNET_USDC)).toBe(MAINNET_DAI)
    expect(settlementToken(twoRowTokens(), `0x${"ee".repeat(20)}`)).toBeUndefined()
    expect(settlementToken(undefined, ROW_USDC)).toBeUndefined()
    // A record that predates token tracking was made on the pinned bridge.
    expect(settlementToken(twoRowTokens("USDC"), undefined)).toBe(ROW_USDC)
  })

  it("resolves a Savings row's record, though the funding copy names only Main's token", () => {
    expect(settlementToken(savingsRowTokens(), ROW_SUSDS)).toBe(ROW_SUSDS)
    expect(fundingAssetsLabel(savingsRowTokens())).toBe("DAI")
    expect(swapAssetsLabel(savingsRowTokens())).toBeUndefined()
  })

  it("names the tokens a mainnet table swaps, and none for a single token", () => {
    expect(swapAssetsLabel(mainnetTokens())).toBe(fmt(copy.or, { list: "USDC", last: "USDT" }))
    expect(swapAssetsLabel(singleToken(MAINNET_DAI))).toBeUndefined()
  })
})

describe("a fee in the row token's units", () => {
  it("states it to the cent with the token's symbol", () => {
    expect(tokenFigure("0.1", "USDC")).toBe("0.10 USDC")
    expect(tokenFigure("1200", "DAI")).toBe("1,200 DAI")
    expect(tokenFigure("0.000001", "USDC")).toBe("<0.01 USDC")
  })
})

describe("a registration price", () => {
  it("rounds to the nearest cent", () => {
    expect(formatDepositAmount(parseUnits("15.005", 18), 18)).toBe("$15.01")
    expect(formatDepositAmount(parseUnits("15.004", 18), 18)).toBe("$15.00")
  })
})
