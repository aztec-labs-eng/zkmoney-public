// @vitest-environment node
/** A withdrawal's hero states what left the balance: a backup add's cost once known, else the burn. */
import { describe, expect, it } from "vitest"
import { withdrawalHeroAmount } from "../../../src/ui/screens/WithdrawalDetailModal"

const COST = {
  withdrawalFeeDisplay: "0.2",
  accountChangeFeeDisplay: "0.5",
  returnedDisplay: "0.6",
  costDisplay: "0.7",
}

describe("withdrawalHeroAmount", () => {
  it("leads with the cost of a backup add once its leftover is back, else with the burn", () => {
    expect(withdrawalHeroAmount({ amount: "1.3" }, COST)).toBe("-$0.70")
    expect(withdrawalHeroAmount({ amount: "1.3" })).toBe("-$1.30")
    expect(withdrawalHeroAmount({ amount: "120" })).toBe("-$120")
  })
})
