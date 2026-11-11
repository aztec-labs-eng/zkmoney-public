// @vitest-environment node
import { describe, expect, it } from "vitest"
import { floorTo } from "../../src/ui/format"

describe("floorTo", () => {
  it("floors to the given places, never rounding up", () => {
    expect(floorTo(1_239_999n, 6, 2)).toBe("1.23")
    expect(floorTo(123_456_789_000_000_000n, 18, 5)).toBe("0.12345")
    expect(floorTo(9_999n, 6, 2)).toBe("0")
  })

  it("keeps the exact amount when the token has no more places than asked", () => {
    expect(floorTo(1_234_567n, 6, 6)).toBe("1.234567")
    expect(floorTo(125n, 2, 5)).toBe("1.25")
  })
})
