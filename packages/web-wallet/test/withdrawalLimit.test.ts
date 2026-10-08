/** The per-withdrawal limit the sheets and the gateways share: the burn, fees included, at $1 a token. */
import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import {
  assertWithinWithdrawalLimit,
  withdrawalLimitProblem,
  withdrawalLimitRefusal,
} from "../src/features/limits/withdrawalLimit"

const LIMIT = parseUnits("2500", 18)

describe("withdrawalLimitProblem", () => {
  it("admits a burn of exactly $2,500 and refuses one atomic unit more", () => {
    expect(withdrawalLimitProblem(LIMIT)).toBeUndefined()
    expect(withdrawalLimitProblem(LIMIT + 1n)).toBe("public")
  })

  it("counts in the token's own units", () => {
    expect(withdrawalLimitProblem(parseUnits("2500", 6), 6)).toBeUndefined()
    expect(withdrawalLimitProblem(parseUnits("2500", 6) + 1n, 6)).toBe("public")
  })
})

describe("assertWithinWithdrawalLimit", () => {
  it("throws the refusal for the subject over the limit, and nothing within it", () => {
    expect(() => assertWithinWithdrawalLimit(LIMIT)).not.toThrow()
    expect(() => assertWithinWithdrawalLimit(LIMIT + 1n)).toThrow(
      "This withdrawal is over the $2,500 limit, fees included.",
    )
    expect(() => assertWithinWithdrawalLimit(LIMIT + 1n, "link")).toThrow(
      "This link holds more than the $2,500 withdrawal limit, so it cannot be claimed to an Ethereum wallet.",
    )
  })

  it("never names the protocol ceiling as a figure", () => {
    for (const subject of ["withdrawal", "link"] as const) {
      expect(withdrawalLimitRefusal("protocol", subject)).not.toMatch(/\d/)
    }
  })
})
