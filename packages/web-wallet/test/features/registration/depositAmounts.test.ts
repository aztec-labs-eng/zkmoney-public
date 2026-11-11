// @vitest-environment node
/** A deposit's due and seen figures round to the cent in the direction that never short-asks. */
import { describe, expect, it } from "vitest"
import {
  formatDepositDue,
  formatDepositSeen,
} from "../../../src/features/registration/depositAmounts"

const dai = (v: string) => BigInt(v.replace(".", "").padEnd(v.indexOf(".") + 18, "0"))

describe("deposit amount formatters", () => {
  it("what is due rounds up to the cent, what was seen rounds down, in the token's own units", () => {
    expect(formatDepositDue(dai("15.0"), 18)).toBe("$15.00")
    expect(formatDepositDue(dai("0.001"), 18)).toBe("$0.01")
    expect(formatDepositDue(1n, 18)).toBe("$0.01")
    expect(formatDepositDue(dai("15.005"), 18)).toBe("$15.01")
    expect(formatDepositDue(dai("1234.5"), 18)).toBe("$1,234.50")
    expect(formatDepositDue(0n, 18)).toBe("$0.00")
    expect(formatDepositSeen(dai("14.999"), 18)).toBe("$14.99")
    expect(formatDepositSeen(dai("15.0"), 18)).toBe("$15.00")
    expect(formatDepositSeen(1n, 18)).toBe("$0.00")
    // A six-decimal token and a cent-precision one round the same way.
    expect(formatDepositDue(14_999_001n, 6)).toBe("$15.00")
    expect(formatDepositSeen(14_999_999n, 6)).toBe("$14.99")
    expect(formatDepositDue(1501n, 2)).toBe("$15.01")
    expect(formatDepositDue(15n, 0)).toBe("$15.00")
  })
})
