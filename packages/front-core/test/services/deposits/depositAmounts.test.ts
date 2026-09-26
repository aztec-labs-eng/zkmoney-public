import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import { depositAmounts } from "../../../src/core/services/deposits/depositAmounts"

/** The whole deduction, raw units: 0.25 @ 18dp. */
const FEE = "250000000000000000"

describe("depositAmounts", () => {
  it("derives gross/net/fee for a pending record (gross from typed amount)", () => {
    const a = depositAmounts({ amount: "100", fee: FEE })
    expect(a.grossAtomic).toBe(100000000000000000000n)
    expect(a.netAtomic).toBe(99750000000000000000n)
    expect(a.feeAtomic).toBe(250000000000000000n)
    expect(a.grossAtomic).toBe(a.netAtomic + a.feeAtomic)
    expect(a.netDisplay).toBe("99.75")
    expect(a.feeKnown).toBe(true)
  })

  it("uses authoritative netAmount and reconstructs gross for a claimed record", () => {
    // `amount` is already net once claimed — the helper must ignore it for gross.
    const a = depositAmounts({ amount: "99.75", netAmount: "99750000000000000000", fee: FEE })
    expect(a.netAtomic).toBe(99750000000000000000n)
    expect(a.grossAtomic).toBe(100000000000000000000n)
    expect(a.grossDisplay).toBe("100")
    expect(a.feeDisplay).toBe("0.25")
  })

  it("treats netAmount and fee as raw units, never parseUnits (encoding guard)", () => {
    const a = depositAmounts({ amount: "0", netAmount: "99750000000000000000", fee: FEE })
    expect(a.feeAtomic).toBe(250000000000000000n)
    expect(a.netAtomic).toBe(99750000000000000000n)
    // A regression that re-parsed the raw strings would multiply by 10^18.
    expect(a.feeAtomic).not.toBe(parseUnits(FEE, 18))
    expect(a.netAtomic).not.toBe(parseUnits("99750000000000000000", 18))
  })

  it("clamps net to zero for a sub-fee pending amount", () => {
    const a = depositAmounts({ amount: "0.07", fee: FEE })
    expect(a.netAtomic).toBe(0n)
  })

  it("yields zero net when the amount exactly equals the fee", () => {
    const a = depositAmounts({ amount: "0.25", fee: FEE })
    expect(a.netAtomic).toBe(0n)
  })

  it("falls back to net = gross when the fee is unknown (pending)", () => {
    const a = depositAmounts({ amount: "100" })
    expect(a.feeKnown).toBe(false)
    expect(a.netAtomic).toBe(100000000000000000000n)
    expect(a.grossAtomic).toBe(100000000000000000000n)
  })

  it("falls back to net = netAmount when the fee is unknown (claimed)", () => {
    const a = depositAmounts({ amount: "99.75", netAmount: "99750000000000000000" })
    expect(a.feeKnown).toBe(false)
    expect(a.netAtomic).toBe(99750000000000000000n)
    expect(a.grossAtomic).toBe(99750000000000000000n)
  })

  it("is exact at 18dp (no float drift)", () => {
    const a = depositAmounts({ amount: "10.07", fee: FEE })
    expect(a.netAtomic).toBe(9820000000000000000n)
  })

  it("never throws on a malformed amount, falling back to netAmount or zero", () => {
    const withNet = depositAmounts({
      amount: "not-a-number",
      netAmount: "99750000000000000000",
      fee: FEE,
    })
    expect(withNet.netAtomic).toBe(99750000000000000000n)

    const bare = depositAmounts({ amount: "not-a-number" })
    expect(bare.grossAtomic).toBe(0n)
    expect(bare.netAtomic).toBe(0n)
  })

  it("reconciles the displayed 2dp strings (gross - fee = net)", () => {
    const a = depositAmounts({ amount: "100", fee: FEE })
    expect((Number(a.grossDisplay) - Number(a.feeDisplay)).toFixed(2)).toBe(
      Number(a.netDisplay).toFixed(2),
    )
  })

  it("reads the fee as the whole deduction and sums nothing onto it", () => {
    // A record from a deployment that skims 0.25 carries a 0.5 fee; the cut stamped beside it is
    // already inside that figure.
    const record = { amount: "100", fee: "500000000000000000", fpcFundingCut: FEE }
    const a = depositAmounts(record)
    expect(a.feeAtomic).toBe(500000000000000000n)
    expect(a.feeDisplay).toBe("0.5")
    expect(a.netAtomic).toBe(99500000000000000000n)

    const claimed = depositAmounts({ ...record, amount: "99.5", netAmount: "99500000000000000000" })
    expect(claimed.grossAtomic).toBe(100000000000000000000n)
  })
})
