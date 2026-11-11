// @vitest-environment node
/** The swap notes name each token in its own place: the sent coin and the one credited. */
import { describe, expect, it } from "vitest"
import { swapCapacityNote, swapCreditNote } from "../../../src/features/limits/limitsCopy"

describe.each([
  ["swapCreditNote", swapCreditNote],
  ["swapCapacityNote", swapCapacityNote],
])("%s", (_, note) => {
  it("fills both tokens, and reads differently with their places swapped", () => {
    const text = note("TOKA", "TOKB")
    expect(text).toContain("TOKA")
    expect(text).toContain("TOKB")
    expect(text).not.toContain("{")
    expect(note("TOKB", "TOKA")).not.toBe(text)
  })
})
