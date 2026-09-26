import { describe, expect, it } from "vitest"
import {
  EARNED_QUOTE_ERROR,
  EARNED_QUOTE_UNCONFIRMED_ERROR,
  assertEarnedQuote,
} from "../src/features/onboarding/earnedQuote"

describe("earned registration quote", () => {
  // The sandbox's portal funding cut; every minimum here clears it.
  const CUT = 0n
  const EARNED = { reduced: true, fee: "500000000000000000", minDeposit: "4500000000000000000" }

  it.each([
    undefined,
    { reduced: false, fee: "5000000000000000000", minDeposit: "10000000000000000000" },
    { reduced: true, fee: "500000000000000000", minDeposit: "5000000000000000000" },
  ])("rejects missing, paid or stale higher quotes", (terms) => {
    expect(() => assertEarnedQuote(terms, CUT)).toThrow(EARNED_QUOTE_ERROR)
  })

  it("refuses a quote that prices nothing, whatever the cut is", () => {
    const unpriced = { reduced: true, fee: "0", minDeposit: "0" }
    expect(() => assertEarnedQuote(unpriced, CUT)).toThrow(EARNED_QUOTE_ERROR)
    expect(() => assertEarnedQuote(unpriced, undefined)).toThrow(EARNED_QUOTE_ERROR)
  })

  it("accepts a signed earned quote inside the earned ask", () => {
    expect(() => assertEarnedQuote(EARNED, CUT)).not.toThrow()
  })

  it("refuses the same quote where the portal's cut outranks its minimum", () => {
    expect(() => assertEarnedQuote(EARNED, 4_500_000_000_000_000_000n)).toThrow(EARNED_QUOTE_ERROR)
  })

  it("fails closed on an unread cut, and says so as its own retryable refusal", () => {
    expect(() => assertEarnedQuote(EARNED, undefined)).toThrow(EARNED_QUOTE_UNCONFIRMED_ERROR)
    // A paid quote is refused on its own terms, whatever the cut is.
    expect(() => assertEarnedQuote({ ...EARNED, reduced: false }, undefined)).toThrow(
      EARNED_QUOTE_ERROR,
    )
  })
})
