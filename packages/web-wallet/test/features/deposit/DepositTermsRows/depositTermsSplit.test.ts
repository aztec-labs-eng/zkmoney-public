// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  depositTermsSplit,
  type DepositTerms,
} from "../../../../src/features/deposit/DepositTermsRows/DepositTermsRows"

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
const terms = (patch: Partial<DepositTerms>): DepositTerms => ({
  tokenSymbol: "DAI",
  tokenDecimals: 18,
  kind: "earned_tag",
  ...patch,
})

describe("depositTermsSplit", () => {
  // A free schedule's fee is the relayer's sweep fee alone.
  const earned = { fee: dai(0.5), sweepFee: dai(0.5), total: dai(5) }

  it("prices a free schedule's tag at nothing and gives its sweep fee to network funding", () => {
    expect(depositTermsSplit(terms(earned))).toEqual({
      price: 0n,
      funding: dai(0.5),
      opening: dai(4.5),
    })
  })

  it("leaves each part unknown until its own read lands", () => {
    expect(depositTermsSplit(terms({ ...earned, fee: undefined }))).toEqual({
      price: undefined,
      funding: dai(0.5),
      opening: undefined,
    })
    expect(depositTermsSplit(terms({ ...earned, sweepFee: undefined }))).toEqual({
      price: undefined,
      funding: undefined,
      opening: dai(4.5),
    })
  })

  it("prices the tag above the sweep fee on a standard schedule", () => {
    const standard = terms({ kind: "standard", fee: dai(5.5), sweepFee: dai(0.5), total: dai(10) })
    expect(depositTermsSplit(standard)).toEqual({
      price: dai(5),
      funding: dai(0.5),
      opening: dai(4.5),
    })
  })
})
