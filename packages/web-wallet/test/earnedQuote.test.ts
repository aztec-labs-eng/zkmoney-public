import { describe, expect, it } from "vitest"
import { EARNED_QUOTE_ERROR, assertEarnedQuote } from "../src/features/onboarding/earnedQuote"
import { PAID, RANDOM, RANDOM_ASK } from "./support/registrationPrices"

describe("earned registration quote", () => {
  const EARNED = { reduced: true, fee: String(RANDOM.fee), minDeposit: String(RANDOM.min) }

  it.each([
    undefined,
    { reduced: false, fee: String(PAID.fee), minDeposit: String(PAID.min) },
    // Reduced, but its floor is over the earned ask.
    { reduced: true, fee: String(RANDOM.fee), minDeposit: String(RANDOM_ASK) },
  ])("rejects missing, paid or stale higher quotes", (terms) => {
    expect(() => assertEarnedQuote(terms)).toThrow(EARNED_QUOTE_ERROR)
  })

  it("refuses a quote that prices nothing", () => {
    expect(() => assertEarnedQuote({ reduced: true, fee: "0", minDeposit: "0" })).toThrow(
      EARNED_QUOTE_ERROR,
    )
  })

  it("accepts a signed earned quote inside the earned ask", () => {
    expect(() => assertEarnedQuote(EARNED)).not.toThrow()
  })
})
