// @vitest-environment node
/** A withdrawal's hero states what left the balance: a backup add's fee once known, else the burn. */
import { describe, expect, it } from "vitest"
import { withdrawalHeroAmount } from "../../../src/ui/screens/WithdrawalDetailModal"

const E16 = 10n ** 16n
const FEE = { amount: 70n * E16, hold: 60n * E16, returned: false }

describe("withdrawalHeroAmount", () => {
  it("leads with a backup add's fee, apart from its hold, else with the burn", () => {
    expect(withdrawalHeroAmount({ amount: "1.3", tokenDecimals: 18 }, FEE)).toBe("-$0.70")
    expect(withdrawalHeroAmount({ amount: "1.3", tokenDecimals: 18 })).toBe("-$1.30")
    expect(withdrawalHeroAmount({ amount: "120", tokenDecimals: 18 })).toBe("-$120")
  })
})
