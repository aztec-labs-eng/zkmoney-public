import { describe, expect, it } from "vitest"
import { goldenTicketBurn, goldenTicketCoverage } from "../../src/oxide/goldenTicketFunding"

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
const CUT = dai(0.1)
const TICKET = { fee: dai(0.5), min: 0n }

describe("goldenTicketBurn", () => {
  it("funds the withdrawal cut, the return-deposit cut and the tips", () => {
    expect(goldenTicketBurn(TICKET, { withdrawalCut: CUT, depositCut: CUT })).toEqual({
      sipaTarget: dai(0.61),
      burn: dai(1.81),
      returned: dai(0.01),
    })
  })

  it("burns the fee, the remainder and the tips alone at a zero cut", () => {
    expect(goldenTicketBurn(TICKET, { withdrawalCut: 0n, depositCut: 0n }).burn).toBe(dai(1.61))
  })

  it("funds a minimum above the cut once", () => {
    const quote = goldenTicketBurn(
      { fee: dai(0.5), min: dai(1) },
      { withdrawalCut: CUT, depositCut: CUT },
    )
    expect(quote.burn).toBe(dai(2.7))
    expect(quote.returned).toBe(dai(0.9))
  })

  it("prices unequal cuts leg by leg", () => {
    expect(goldenTicketBurn(TICKET, { withdrawalCut: dai(0.25), depositCut: CUT }).burn).toBe(
      dai(1.96),
    )
    expect(goldenTicketBurn(TICKET, { withdrawalCut: CUT, depositCut: dai(0.25) }).burn).toBe(
      dai(1.96),
    )
  })
})

describe("goldenTicketCoverage", () => {
  const cuts = { withdrawalCut: CUT, depositCut: CUT }

  it("keeps the rest of the note at once and adds the return later", () => {
    const coverage = goldenTicketCoverage(dai(3), TICKET, cuts)
    expect(coverage.covers).toBe(true)
    expect(coverage.immediate).toBe(dai(1.19))
    expect(coverage.eventual).toBe(dai(1.2))
  })

  it("refuses a note that only equals the burn", () => {
    expect(goldenTicketCoverage(dai(1.81), TICKET, cuts).covers).toBe(false)
    expect(goldenTicketCoverage(dai(1.81) + 1n, TICKET, cuts).covers).toBe(true)
  })

  it("refuses a note the withdrawal leg alone would exhaust", () => {
    expect(goldenTicketCoverage(dai(1.7), TICKET, cuts).covers).toBe(false)
  })
})
