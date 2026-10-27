/**
 * The gross / fee / net split a withdrawal's detail sheet reads off the record. What is pinned is
 * the arithmetic and the encoding of each field, and the two records that carry no split at all:
 * one written without a tip, and one whose whole amount went to the tip.
 */
import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  swapWithdrawalAmounts,
  withdrawalAmounts,
} from "../../../src/core/services/bridge/withdrawalAmounts"

const TIP = WITHDRAW_RELAYER_TIP.toString()

describe("withdrawalAmounts", () => {
  it("reads a 6-decimal token's record in its own decimals", () => {
    const a = withdrawalAmounts({
      tokenDecimals: 6,
      amount: "120",
      rawAmount: parseUnits("120", 6).toString(),
      relayerTip: parseUnits("0.1", 6).toString(),
    })
    expect(a.grossAtomic).toBe(120_000_000n)
    expect([a.grossDisplay, a.feeDisplay, a.netDisplay]).toEqual(["120", "0.1", "119.9"])
    expect(withdrawalAmounts({ tokenDecimals: 6, amount: "2.5" }).grossAtomic).toBe(2_500_000n)
  })

  it("splits the mined burn amount into the tip and what the recipient receives", () => {
    const a = withdrawalAmounts({
      tokenDecimals: 18,
      amount: "120",
      rawAmount: parseUnits("120", 18).toString(),
      relayerTip: TIP,
    })

    expect(a.grossAtomic).toBe(120000000000000000000n)
    expect(a.tipAtomic).toBe(100000000000000000n)
    expect(a.proverTipAtomic).toBe(0n)
    expect(a.feeAtomic).toBe(a.tipAtomic)
    expect(a.netAtomic).toBe(a.grossAtomic - a.feeAtomic)
    expect(a.grossDisplay).toBe("120")
    expect(a.feeDisplay).toBe("0.1")
    expect(a.netDisplay).toBe("119.9")
    expect(a.feeKnown).toBe(true)
  })

  it("takes the gross from the typed amount when no raw amount was recorded", () => {
    const a = withdrawalAmounts({ tokenDecimals: 18, amount: "36.5", relayerTip: TIP })

    expect(a.grossAtomic).toBe(36500000000000000000n)
    expect(a.netAtomic).toBe(36400000000000000000n)
  })

  it("treats rawAmount and relayerTip as raw units, never parseUnits (encoding guard)", () => {
    const a = withdrawalAmounts({
      tokenDecimals: 18,
      amount: "0",
      rawAmount: "120000000000000000000",
      relayerTip: TIP,
    })

    expect(a.grossAtomic).toBe(120000000000000000000n)
    expect(a.tipAtomic).toBe(100000000000000000n)
    // A regression that re-parsed the raw strings would multiply by 10^18.
    expect(a.grossAtomic).not.toBe(parseUnits("120000000000000000000", 18))
    expect(a.tipAtomic).not.toBe(parseUnits(TIP, 18))
  })

  it("reports no fee and net = gross for a record written without a tip", () => {
    const a = withdrawalAmounts({
      tokenDecimals: 18,
      amount: "120",
      rawAmount: parseUnits("120", 18).toString(),
    })

    expect(a.feeKnown).toBe(false)
    expect(a.tipAtomic).toBe(0n)
    expect(a.feeAtomic).toBe(0n)
    expect(a.netAtomic).toBe(a.grossAtomic)
  })

  it("adds the prover tip to the relayer tip", () => {
    const a = withdrawalAmounts({
      tokenDecimals: 18,
      amount: "0.71",
      rawAmount: parseUnits("1.81", 18).toString(),
      relayerTip: TIP,
      proverTip: parseUnits("1", 18).toString(),
    })
    expect(a.proverTipAtomic).toBe(parseUnits("1", 18))
    expect(a.feeAtomic).toBe(parseUnits("1.1", 18))
    expect(a.netDisplay).toBe("0.71")

    // A record that offered no prover tip splits on the relayer tip alone.
    expect(
      withdrawalAmounts({
        tokenDecimals: 18,
        amount: "1",
        rawAmount: parseUnits("1", 18).toString(),
        relayerTip: TIP,
      }).proverTipAtomic,
    ).toBe(0n)
  })

  it("adds the executor's fee to the tips", () => {
    const a = withdrawalAmounts({
      tokenDecimals: 18,
      amount: "1.8",
      rawAmount: parseUnits("2", 18).toString(),
      relayerTip: TIP,
      withdrawalFee: parseUnits("0.1", 18).toString(),
    })
    expect(a.withdrawalFeeAtomic).toBe(parseUnits("0.1", 18))
    expect(a.feeAtomic).toBe(parseUnits("0.2", 18))
    expect(a.netDisplay).toBe("1.8")

    // A record without an executor fee splits on the tips alone.
    expect(
      withdrawalAmounts({ tokenDecimals: 18, amount: "1", relayerTip: TIP }).withdrawalFeeAtomic,
    ).toBe(0n)
  })

  it("clamps net to zero when the fee takes the whole amount", () => {
    expect(withdrawalAmounts({ tokenDecimals: 18, amount: "0.1", relayerTip: TIP }).netAtomic).toBe(
      0n,
    )
    expect(
      withdrawalAmounts({ tokenDecimals: 18, amount: "0.05", relayerTip: TIP }).netAtomic,
    ).toBe(0n)
  })

  it("is exact at 18dp (no float drift)", () => {
    expect(
      withdrawalAmounts({ tokenDecimals: 18, amount: "10.07", relayerTip: TIP }).netAtomic,
    ).toBe(9970000000000000000n)
  })

  it("never throws on a malformed amount", () => {
    const a = withdrawalAmounts({ tokenDecimals: 18, amount: "not-a-number", relayerTip: TIP })

    expect(a.grossAtomic).toBe(0n)
    expect(a.netAtomic).toBe(0n)
  })
})

describe("swapWithdrawalAmounts", () => {
  const swapRecord = {
    tokenDecimals: 18,
    amount: "100.25",
    rawAmount: parseUnits("100.25", 18).toString(),
    relayerTip: TIP, // 0.1
    swapOutput: "ETH" as const,
    swapRelayerTip: parseUnits("0.15", 18).toString(),
    swapEstimatedOut: parseUnits("0.5", 18).toString(),
    swapOutputDecimals: 18,
  }

  it("is undefined for a direct withdrawal", () => {
    expect(
      swapWithdrawalAmounts({ tokenDecimals: 18, amount: "120", relayerTip: TIP }),
    ).toBeUndefined()
  })

  it("sums every pre-swap deduction into the fee and swaps the rest", () => {
    const s = swapWithdrawalAmounts(swapRecord)!

    expect(s.feeKnown).toBe(true)
    expect(s.feeAtomic).toBe(parseUnits("0.25", 18))
    expect(s.feeDisplay).toBe("0.25")
    expect(s.swapInputAtomic).toBe(parseUnits("100", 18))
    expect(s.estimate?.outAtomic).toBe(parseUnits("0.5", 18))
    expect(s.estimate?.outDisplay).toBe("0.5")
    expect(s.estimate?.rate).toBeCloseTo(0.005, 10)
  })

  it("takes the gas share out of the route's input, and reports it with its ETH quote", () => {
    const s = swapWithdrawalAmounts({
      tokenDecimals: 18,
      ...swapRecord,
      swapOutput: "USDC",
      swapDaiForGas: parseUnits("5", 18).toString(),
      swapEstimatedGasOut: parseUnits("0.0016", 18).toString(),
      swapEstimatedOut: "94000000",
      swapOutputDecimals: 6,
    })!

    expect(s.swapInputAtomic).toBe(parseUnits("95", 18))
    expect(s.gas).toEqual({
      daiAtomic: parseUnits("5", 18),
      daiDisplay: "5",
      ethOutDisplay: "0.0016",
    })
    expect(s.estimate?.rate).toBeCloseTo(94 / 95, 10)
    expect(swapWithdrawalAmounts(swapRecord)!.gas).toBeUndefined()
  })

  it("carries no estimate when the record has no quote", () => {
    const s = swapWithdrawalAmounts({
      tokenDecimals: 18,
      ...swapRecord,
      swapEstimatedOut: undefined,
    })!

    expect(s.feeKnown).toBe(true)
    expect(s.estimate).toBeUndefined()
  })

  it("reports the fee unknown on a record without the relayer tip", () => {
    const s = swapWithdrawalAmounts({ tokenDecimals: 18, ...swapRecord, relayerTip: undefined })!

    expect(s.feeKnown).toBe(false)
    expect(s.estimate).toBeUndefined()
  })
})
