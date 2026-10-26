import { describe, expect, it } from "vitest"
import { goldenTicketBurn, goldenTicketCoverage } from "../../src/oxide/goldenTicketFunding"

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
const TICKET = { fee: dai(0.5), min: 0n }
/** An executor that takes no fee, so the figures below are the schedule's and the tips' alone. */
const NO_FEE = 0n

describe("goldenTicketBurn", () => {
  it("funds the fee, the bridge remainder and the relayer tip", () => {
    expect(goldenTicketBurn(TICKET, 0n, NO_FEE)).toEqual({
      sipaTarget: dai(0.51),
      burn: dai(0.61),
      returned: dai(0.01),
    })
  })

  it("adds the prover tip to the burn and leaves the SIPA target alone", () => {
    const quote = goldenTicketBurn(TICKET, dai(0.25), NO_FEE)
    expect(quote.burn).toBe(dai(0.86))
    expect(quote.sipaTarget).toBe(dai(0.51))
  })

  it("adds the executor's fee to the burn and leaves the SIPA target alone", () => {
    const quote = goldenTicketBurn(TICKET, 0n, dai(0.1))
    expect(quote.burn).toBe(dai(0.71))
    expect(quote.sipaTarget).toBe(dai(0.51))
  })

  it("funds a minimum above the remainder once", () => {
    const quote = goldenTicketBurn({ fee: dai(0.5), min: dai(1) }, 0n, NO_FEE)
    expect(quote.burn).toBe(dai(1.6))
    expect(quote.returned).toBe(dai(1))
  })
})

describe("goldenTicketCoverage", () => {
  it("keeps the rest of the note at once and adds the return later", () => {
    const coverage = goldenTicketCoverage(dai(3), TICKET, 0n, NO_FEE)
    expect(coverage.covers).toBe(true)
    expect(coverage.immediate).toBe(dai(2.39))
    expect(coverage.eventual).toBe(dai(2.4))
  })

  it("takes the prover tip from what the recipient keeps", () => {
    const coverage = goldenTicketCoverage(dai(3), TICKET, dai(1), NO_FEE)
    expect(coverage.immediate).toBe(dai(1.39))
    expect(coverage.eventual).toBe(dai(1.4))
  })

  it("takes the executor's fee from what the recipient keeps", () => {
    const coverage = goldenTicketCoverage(dai(3), TICKET, 0n, dai(0.1))
    expect(coverage.immediate).toBe(dai(2.29))
    expect(coverage.eventual).toBe(dai(2.3))
    expect(goldenTicketCoverage(dai(0.71), TICKET, 0n, dai(0.1)).covers).toBe(false)
  })

  it("refuses a note that only equals the burn", () => {
    expect(goldenTicketCoverage(dai(0.61), TICKET, 0n, NO_FEE).covers).toBe(false)
    expect(goldenTicketCoverage(dai(0.61) + 1n, TICKET, 0n, NO_FEE).covers).toBe(true)
  })

  it("refuses a note the prover tip would exhaust", () => {
    expect(goldenTicketCoverage(dai(1.5), TICKET, 0n, NO_FEE).covers).toBe(true)
    expect(goldenTicketCoverage(dai(1.5), TICKET, dai(0.89), NO_FEE).covers).toBe(false)
  })

  it("refuses a note the withdrawal leg alone would exhaust", () => {
    expect(goldenTicketCoverage(dai(0.6), TICKET, 0n, NO_FEE).covers).toBe(false)
  })
})
