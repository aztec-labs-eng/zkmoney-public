import { describe, expect, it } from "vitest"
import { tokenAmount } from "../../src/utils/tokenAmount"

describe("tokenAmount", () => {
  it("trims to five places and drops trailing zeros", () => {
    expect(tokenAmount("0.123456789123456789")).toBe("0.12346")
    expect(tokenAmount("0.050000000000000000")).toBe("0.05")
    expect(tokenAmount("1234.5")).toBe("1,234.5")
    expect(tokenAmount("0")).toBe("0")
  })

  it("bounds a positive amount too small to show instead of rounding it to zero", () => {
    expect(tokenAmount("0.000000000000000001")).toBe("<0.00001")
    expect(tokenAmount("0.00001")).toBe("0.00001")
    expect(tokenAmount("0.04", 1)).toBe("<0.1")
  })

  it("passes through a figure that is not a number", () => {
    expect(tokenAmount("--")).toBe("--")
  })
})
