/** The per-withdrawal limit the sheets and the gateways share: the burn, fees included, at $1 a token. */
import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import { TX_AMOUNT_CAP } from "@obsidion/sdk"
import {
  assertWithinWithdrawalLimit,
  sharesBurnLimitProblem,
  sharesBurnMax,
  withdrawalLimitProblem,
  withdrawalLimitRefusal,
  withdrawalMaxAtomic,
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

describe("sharesBurnLimitProblem", () => {
  it("holds a Savings move out to the network's maximum per burn, not to Main's dollar limit", () => {
    expect(sharesBurnLimitProblem(LIMIT + 1n)).toBeUndefined()
    expect(sharesBurnLimitProblem(TX_AMOUNT_CAP)).toBeUndefined()
    expect(sharesBurnLimitProblem(TX_AMOUNT_CAP + 1n)).toBe("protocol")
    expect(sharesBurnMax(TX_AMOUNT_CAP + 5n)).toBe(TX_AMOUNT_CAP)
    expect(sharesBurnMax(7n)).toBe(7n)
  })
})

describe("withdrawalMaxAtomic", () => {
  it("takes the whole balance within the limit, and the limit to the cent above it", () => {
    expect(withdrawalMaxAtomic(LIMIT - 7n)).toBe(LIMIT - 7n)
    expect(withdrawalMaxAtomic(LIMIT * 3n)).toBe(LIMIT)
  })
})
