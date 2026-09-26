import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import { decimalPlaces, isDecimalAmount, validateAmount } from "../../src/utils/validate"

describe("isDecimalAmount", () => {
  it("accepts exactly the non-negative text parseUnits accepts", () => {
    for (const text of ["2", "2.", ".5", "10.25", "0"]) {
      expect(isDecimalAmount(text), text).toBe(true)
      expect(() => parseUnits(text, 18)).not.toThrow()
    }
  })

  it("rejects what parseUnits throws on, and negatives", () => {
    for (const text of ["2-", "1e3", "-1", "", ".", " 2", "2 ", "abc", "1,5", "0x10", "Infinity"]) {
      expect(isDecimalAmount(text), text).toBe(false)
    }
  })
})

describe("decimalPlaces", () => {
  it("counts digits after the point", () => {
    expect(decimalPlaces("12")).toBe(0)
    expect(decimalPlaces("12.")).toBe(0)
    expect(decimalPlaces(".5")).toBe(1)
    expect(decimalPlaces("1.11111111")).toBe(8)
  })
})

describe("validateAmount", () => {
  it("needs a decimal shape, at most cents, and a positive value", () => {
    expect(validateAmount("1.5")).toBe(true)
    expect(validateAmount("1.50")).toBe(true)
    expect(validateAmount("1.111")).toBe(false)
    expect(validateAmount("0")).toBe(false)
    expect(validateAmount("1e3")).toBe(false)
  })
})
