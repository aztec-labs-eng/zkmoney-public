import { describe, expect, it } from "vitest"
import { normalizeAmountInput } from "../src/utils/amountInput"

describe("normalizeAmountInput", () => {
  it.each([
    ["12,34", "12.34"],
    ["١٢٫٣٤", "12.34"],
    ["۱۲٫۳۴", "12.34"],
    ["१२.३४", "12.34"],
    ["১২.৩৪", "12.34"],
    ["１２．３４", "12.34"],
    ["", ""],
    ["0,", "0."],
    [",5", ".5"],
    ["9007199254740993,12", "9007199254740993.12"],
  ])("normalizes %s without losing digits", (input, expected) => {
    expect(normalizeAmountInput(input)).toBe(expected)
  })

  it.each(["1,000.00", "1.000,00", "1 234,56", "1 234,56", "1,2,3", "1e3", "-1", "$1", "²", "½"])(
    "does not turn invalid input %s into a valid decimal",
    (input) => expect(normalizeAmountInput(input)).not.toMatch(/^(\d+\.?\d*|\.\d+)$/),
  )
})
