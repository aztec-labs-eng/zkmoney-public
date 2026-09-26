import { describe, expect, it } from "vitest"

import { parseEscrowAmount } from "../../src/utils/escrowAmount"

// The single amount-parse the direct/email paylink hooks and the request-link
// mint (useReceiveMoneyLink) all delegate to. These amounts become on-chain
// escrow / request atomic values, so they must be exact at 18 dp for every shape
// an amount field can forward — including a comma decimal separator,
// which raw parseUnits rejects.
describe("parseEscrowAmount (18-dp)", () => {
  const D = 18

  it("scales whole and fractional dot-decimals exactly", () => {
    expect(parseEscrowAmount("5", D).atomic).toBe(5_000_000_000_000_000_000n)
    expect(parseEscrowAmount("5.25", D).atomic).toBe(5_250_000_000_000_000_000n)
    expect(parseEscrowAmount("0.07", D).atomic).toBe(70_000_000_000_000_000n)
  })

  it("accepts a comma decimal separator", () => {
    expect(parseEscrowAmount("5,25", D).atomic).toBe(5_250_000_000_000_000_000n)
    expect(parseEscrowAmount("5,25", D).human).toBe(5.25)
  })

  it("tolerates trailing- and leading-dot forms", () => {
    expect(parseEscrowAmount("5.", D).atomic).toBe(5_000_000_000_000_000_000n)
    expect(parseEscrowAmount(".5", D).atomic).toBe(500_000_000_000_000_000n)
  })

  it("rounds fractions longer than the decimal precision instead of throwing", () => {
    expect(parseEscrowAmount("1.0000000000000000004", D).atomic).toBe(1_000_000_000_000_000_000n)
    expect(parseEscrowAmount("1.0000000000000000005", D).atomic).toBe(1_000_000_000_000_000_001n)
  })

  it("keeps the smallest representable unit but rejects sub-atomic amounts", () => {
    // 1e-18 is the smallest non-zero atomic value; anything below it rounds to 0
    // base units, which would escrow nothing / collide with the any-amount
    // sentinel — so a positive input that scales to zero fails closed.
    expect(parseEscrowAmount("0.000000000000000001", D).atomic).toBe(1n)
    expect(() => parseEscrowAmount("0.0000000000000000004", D)).toThrow()
  })

  it("mirrors the normalized value in `human` for display metadata", () => {
    expect(parseEscrowAmount("5.25", D).human).toBe(5.25)
    expect(parseEscrowAmount("5", D).human).toBe(5)
  })
})
