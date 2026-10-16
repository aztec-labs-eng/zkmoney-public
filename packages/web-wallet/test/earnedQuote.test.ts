import { describe, expect, it } from "vitest"
import {
  EARNED_QUOTE_ERROR,
  EARNED_QUOTE_UNCONFIRMED_ERROR,
  assertEarnedQuote,
} from "../src/features/onboarding/earnedQuote"
import { PAID, RANDOM, RANDOM_ASK } from "./support/registrationPrices"

describe("earned registration quote", () => {
  // The sandbox's portal funding cut; every minimum here clears it.
  const CUT = 0n
  const EARNED = { reduced: true, fee: String(RANDOM.fee), minDeposit: String(RANDOM.min) }

  it.each([
    undefined,
    { reduced: false, fee: String(PAID.fee), minDeposit: String(PAID.min) },
    // Reduced, but its floor is over the earned ask.
    { reduced: true, fee: String(RANDOM.fee), minDeposit: String(RANDOM_ASK) },
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
    expect(() => assertEarnedQuote(EARNED, RANDOM_ASK)).toThrow(EARNED_QUOTE_ERROR)
  })

  it("fails closed on an unread cut, and says so as its own retryable refusal", () => {
    expect(() => assertEarnedQuote(EARNED, undefined)).toThrow(EARNED_QUOTE_UNCONFIRMED_ERROR)
    // A paid quote is refused on its own terms, whatever the cut is.
    expect(() => assertEarnedQuote({ ...EARNED, reduced: false }, undefined)).toThrow(
      EARNED_QUOTE_ERROR,
    )
  })
})
