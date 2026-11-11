import { describe, expect, it } from "vitest"
import { tokenAtomicFloor } from "../../src/ui/format"

const DAI = 10n ** 18n

describe("tokenAtomicFloor", () => {
  it("truncates to the cent and groups the amount", () => {
    expect(tokenAtomicFloor((19999n * DAI) / 1000n, "DAI")).toBe("19.99 DAI")
    expect(tokenAtomicFloor(1200n * DAI, "DAI")).toBe("1,200 DAI")
  })
  it("never shows a nonzero amount as zero", () => {
    expect(tokenAtomicFloor((6n * DAI) / 1000n, "DAI")).toBe("<0.01 DAI")
    expect(tokenAtomicFloor(0n, "DAI")).toBe("0 DAI")
  })
})
