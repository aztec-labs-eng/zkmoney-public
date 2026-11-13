// @vitest-environment node
import { describe, expect, it } from "vitest"
import { addCost, feeSplit } from "../../../src/features/backupPasskey/backupCost"

const DAI = 10n ** 18n
/** Base units from hundredths of a cent, so a test can name a figure that rounds. */
const at = (tenThousandths: bigint) => (tenThousandths * DAI) / 10_000n

describe("addCost", () => {
  it("adds up to the cent where rounding each figure apart would not", () => {
    // Staging's add: 2.0551 sent, 1.5004 back. Rounded apart, the fee would read $0.55 beside $2.06
    // and $1.50.
    const cost = addCost({ sent: at(20551n), credited: at(15004n) })
    expect(cost).toEqual({ total: 206n, hold: 150n, fee: 56n })
    expect(cost.fee + cost.hold).toBe(cost.total)
  })

  it("never asks for less than leaves, nor promises more back than comes", () => {
    const cost = addCost({ sent: 2n * DAI + 1n, credited: (15n * DAI) / 10n - 1n })
    expect(cost).toEqual({ total: 201n, hold: 149n, fee: 52n })
  })

  it("keeps whole cents as they are", () => {
    expect(addCost({ sent: 2n * DAI, credited: (14n * DAI) / 10n })).toEqual({
      total: 200n,
      hold: 140n,
      fee: 60n,
    })
  })
})

describe("feeSplit", () => {
  it("splits the fee into two parts that add up to it, the rest taking the rounding", () => {
    // Rounded up apart, 0.2001 and 0.3501 would read 21 and 36 cents, a cent past the fee.
    expect(feeSplit(56n, at(3501n))).toEqual([20n, 36n])
    expect(feeSplit(60n, (4n * DAI) / 10n)).toEqual([20n, 40n])
  })
})
