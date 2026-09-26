/**
 * The gross / fee / net split a withdrawal's detail sheet reads off the record. What is pinned is
 * the arithmetic and the encoding of each field, the portal's cap on its funding cut, and the two
 * records that carry no split at all: one written without a tip, and one whose whole amount went
 * to the tip.
 */
import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  swapWithdrawalAmounts,
  withdrawalAmounts,
} from "../../../src/core/services/bridge/withdrawalAmounts"

const TIP = WITHDRAW_RELAYER_TIP.toString()
/** The portal's FPC_FUNDING_CUT on the funded tiers: 0.25 DAI. */
const CUT = parseUnits("0.25", 18).toString()
/** A deployment that skims nothing, so the tip is the whole fee. */
const NO_CUT = "0"

describe("withdrawalAmounts", () => {
  it("splits the mined burn amount into the tip and what the recipient receives", () => {
    const a = withdrawalAmounts({
      amount: "120",
      rawAmount: parseUnits("120", 18).toString(),
      relayerTip: TIP,
      fpcFundingCut: NO_CUT,
    })

    expect(a.grossAtomic).toBe(120000000000000000000n)
    expect(a.tipAtomic).toBe(100000000000000000n)
    expect(a.cutAtomic).toBe(0n)
    expect(a.feeAtomic).toBe(a.tipAtomic)
    expect(a.netAtomic).toBe(a.grossAtomic - a.feeAtomic)
    expect(a.grossDisplay).toBe("120")
    expect(a.feeDisplay).toBe("0.1")
    expect(a.netDisplay).toBe("119.9")
    expect(a.feeKnown).toBe(true)
  })

  it("takes the gross from the typed amount when no raw amount was recorded", () => {
    const a = withdrawalAmounts({ amount: "36.5", relayerTip: TIP, fpcFundingCut: NO_CUT })

    expect(a.grossAtomic).toBe(36500000000000000000n)
    expect(a.netAtomic).toBe(36400000000000000000n)
  })

  it("treats rawAmount and relayerTip as raw units, never parseUnits (encoding guard)", () => {
    const a = withdrawalAmounts({
      amount: "0",
      rawAmount: "120000000000000000000",
      relayerTip: TIP,
      fpcFundingCut: NO_CUT,
    })

    expect(a.grossAtomic).toBe(120000000000000000000n)
    expect(a.tipAtomic).toBe(100000000000000000n)
    // A regression that re-parsed the raw strings would multiply by 10^18.
    expect(a.grossAtomic).not.toBe(parseUnits("120000000000000000000", 18))
    expect(a.tipAtomic).not.toBe(parseUnits(TIP, 18))
  })

  it("reports no fee and net = gross for a record written without a tip", () => {
    const a = withdrawalAmounts({ amount: "120", rawAmount: parseUnits("120", 18).toString() })

    expect(a.feeKnown).toBe(false)
    expect(a.tipAtomic).toBe(0n)
    expect(a.feeAtomic).toBe(0n)
    expect(a.netAtomic).toBe(a.grossAtomic)
  })

  it("subtracts the portal's funding cut alongside the tip", () => {
    const a = withdrawalAmounts({
      amount: "120",
      rawAmount: parseUnits("120", 18).toString(),
      relayerTip: TIP,
      fpcFundingCut: CUT,
    })

    expect(a.cutAtomic).toBe(250000000000000000n)
    expect(a.feeAtomic).toBe(350000000000000000n)
    expect(a.feeDisplay).toBe("0.35")
    expect(a.netAtomic).toBe(119650000000000000000n)
    expect(a.netDisplay).toBe("119.65")
    expect(a.feeKnown).toBe(true)
  })

  it("deducts the prover tip first and caps the cut at what it leaves", () => {
    const a = withdrawalAmounts({
      amount: "0.61",
      rawAmount: parseUnits("1.81", 18).toString(),
      relayerTip: TIP,
      proverTip: parseUnits("1", 18).toString(),
      fpcFundingCut: parseUnits("0.1", 18).toString(),
    })
    expect(a.proverTipAtomic).toBe(parseUnits("1", 18))
    expect(a.feeAtomic).toBe(parseUnits("1.2", 18))
    expect(a.netDisplay).toBe("0.61")

    // The cut takes the 0.15 the prover tip leaves; the relayer tip comes on top.
    const capped = withdrawalAmounts({
      amount: "0",
      rawAmount: parseUnits("1.15", 18).toString(),
      relayerTip: TIP,
      proverTip: parseUnits("1", 18).toString(),
      fpcFundingCut: CUT,
    })
    expect(capped.feeAtomic).toBe(parseUnits("1.25", 18))
    expect(capped.netAtomic).toBe(0n)
    // A record that offered no prover tip splits as before.
    expect(
      withdrawalAmounts({
        amount: "1",
        rawAmount: parseUnits("1", 18).toString(),
        relayerTip: TIP,
        fpcFundingCut: NO_CUT,
      }).proverTipAtomic,
    ).toBe(0n)
  })

  it("takes the cut before the relayer tip, capped at the gross", () => {
    // The portal takes `min(cut, amount - proverTip)` before the executor pays the relayer tip, so
    // a small withdrawal pays the cut first and the recipient lands nothing rather than a negative.
    const a = withdrawalAmounts({ amount: "0.2", relayerTip: TIP, fpcFundingCut: CUT })
    expect(a.cutAtomic).toBe(250000000000000000n)
    expect(a.feeAtomic).toBe(300000000000000000n)
    expect(a.netAtomic).toBe(0n)

    const under = withdrawalAmounts({ amount: "0.05", relayerTip: TIP, fpcFundingCut: CUT })
    expect(under.feeAtomic).toBe(150000000000000000n)
    expect(under.netAtomic).toBe(0n)
  })

  it("hides the breakdown on a record that carries a tip but no cut", () => {
    // The portal always took the cut, so a tip alone is not the fee this burn paid.
    const a = withdrawalAmounts({ amount: "120", relayerTip: TIP })

    expect(a.feeKnown).toBe(false)
    expect(a.feeAtomic).toBe(0n)
    expect(a.netAtomic).toBe(a.grossAtomic)
  })

  it("clamps net to zero when the fee takes the whole amount", () => {
    expect(
      withdrawalAmounts({ amount: "0.1", relayerTip: TIP, fpcFundingCut: NO_CUT }).netAtomic,
    ).toBe(0n)
    expect(
      withdrawalAmounts({ amount: "0.05", relayerTip: TIP, fpcFundingCut: NO_CUT }).netAtomic,
    ).toBe(0n)
  })

  it("is exact at 18dp (no float drift)", () => {
    expect(
      withdrawalAmounts({ amount: "10.07", relayerTip: TIP, fpcFundingCut: NO_CUT }).netAtomic,
    ).toBe(9970000000000000000n)
  })

  it("never throws on a malformed amount", () => {
    const a = withdrawalAmounts({
      amount: "not-a-number",
      relayerTip: TIP,
      fpcFundingCut: NO_CUT,
    })

    expect(a.grossAtomic).toBe(0n)
    expect(a.netAtomic).toBe(0n)
  })
})

describe("swapWithdrawalAmounts", () => {
  const swapRecord = {
    amount: "100.35",
    rawAmount: parseUnits("100.35", 18).toString(),
    relayerTip: TIP, // 0.1
    swapOutput: "ETH" as const,
    swapRelayerTip: parseUnits("0.15", 18).toString(),
    fpcFundingCut: parseUnits("0.1", 18).toString(),
    swapEstimatedOut: parseUnits("0.5", 18).toString(),
    swapOutputDecimals: 18,
  }

  it("is undefined for a direct withdrawal", () => {
    expect(swapWithdrawalAmounts({ amount: "120", relayerTip: TIP })).toBeUndefined()
  })

  it("sums every pre-swap deduction into the fee and swaps the rest", () => {
    const s = swapWithdrawalAmounts(swapRecord)!

    expect(s.feeKnown).toBe(true)
    expect(s.feeAtomic).toBe(parseUnits("0.35", 18))
    expect(s.feeDisplay).toBe("0.35")
    expect(s.swapInputAtomic).toBe(parseUnits("100", 18))
    expect(s.estimate?.outAtomic).toBe(parseUnits("0.5", 18))
    expect(s.estimate?.outDisplay).toBe("0.5")
    expect(s.estimate?.rate).toBeCloseTo(0.005, 10)
  })

  it("carries no estimate when the record has no quote", () => {
    const s = swapWithdrawalAmounts({ ...swapRecord, swapEstimatedOut: undefined })!

    expect(s.feeKnown).toBe(true)
    expect(s.estimate).toBeUndefined()
  })

  it("reports the fee unknown on a record without the FPC cut", () => {
    const s = swapWithdrawalAmounts({ ...swapRecord, fpcFundingCut: undefined })!

    expect(s.feeKnown).toBe(false)
    expect(s.estimate).toBeUndefined()
  })
})
