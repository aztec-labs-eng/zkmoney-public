import { describe, expect, it } from "vitest"
import { chargedAmount } from "../src/features/deposit/DepositFromWalletModal"

describe("chargedAmount", () => {
  it("adds the fee on top of the typed amount", () => {
    expect(chargedAmount("2", "0.5", 18)).toBe("2.5")
    expect(chargedAmount("0.1", "0.2", 6)).toBe("0.3")
  })
  it("rejects unparsable input", () => {
    expect(chargedAmount("abc", "0.5", 18)).toBeUndefined()
  })
})
