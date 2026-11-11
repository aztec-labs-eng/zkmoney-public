// @vitest-environment node
import { describe, expect, it } from "vitest"
import { ticketAmountFigure } from "../../../../src/features/onboarding/steps/GoldenTicketHead"

const ONE = 10n ** 18n

describe("ticketAmountFigure", () => {
  it("floors the amount to cents rather than rounding it up", () => {
    expect(ticketAmountFigure(20n * ONE - ONE / 1000n, 18)).toBe("19.99")
  })
})
