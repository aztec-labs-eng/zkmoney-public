import { describe, expect, it } from "vitest"
import { GOLDEN_TICKET_PROVER_TIP, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { paylinkSignupQuote } from "../src/features/paylink/paylinkSignupQuote"

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
const CUT = dai(0.1)
const TICKET = { fee: dai(0.5), min: 0n }
const cuts = { withdrawalCut: CUT, depositCut: CUT }

describe("paylinkSignupQuote", () => {
  it("burns both portal cuts and the tips, keeps the rest now and the return later", () => {
    const quote = paylinkSignupQuote({
      paylink: dai(3),
      schedule: TICKET,
      cuts,
      sweepFee: dai(0.5),
    })
    expect(quote.burn).toBe(dai(1.81))
    expect(quote.returned).toBe(dai(0.01))
    expect(quote.youReceive).toBe(dai(1.19))
    expect(quote.eventual).toBe(dai(1.2))
    expect(quote.covers).toBe(true)
    expect(quote.tagWaived).toBe(true)
    expect(quote.tagFee).toBe(0n)
    // Sweep fee, both cuts and the relayer tip; the prover tip on its own.
    expect(quote.networkFee).toBe(dai(0.5) + CUT + CUT + WITHDRAW_RELAYER_TIP)
    expect(quote.provingFee).toBe(GOLDEN_TICKET_PROVER_TIP)
    // Every row accounts for the note: what is kept, what returns, and what leaves.
    expect(
      quote.youReceive! + quote.returned + quote.tagFee! + quote.networkFee + quote.provingFee,
    ).toBe(dai(3))
  })

  it("does not cover a note at or below the burn, and prices no coverage without an amount", () => {
    expect(paylinkSignupQuote({ paylink: dai(1.81), schedule: TICKET, cuts }).covers).toBe(false)
    expect(paylinkSignupQuote({ paylink: dai(1.81) + 1n, schedule: TICKET, cuts }).covers).toBe(
      true,
    )
    const unknown = paylinkSignupQuote({ schedule: TICKET, cuts })
    expect(unknown.covers).toBeUndefined()
    expect(unknown.youReceive).toBeUndefined()
    expect(unknown.burn).toBe(dai(1.81))
  })

  it("names a fee above the live sweep fee as the tag's price, and withholds the verdict until that fee is read", () => {
    const dearer = paylinkSignupQuote({
      schedule: { fee: dai(0.7), min: 0n },
      cuts,
      sweepFee: dai(0.5),
    })
    expect(dearer.tagWaived).toBe(false)
    expect(dearer.tagFee).toBe(dai(0.2))
    expect(dearer.networkFee).toBe(dai(0.5) + CUT + CUT + WITHDRAW_RELAYER_TIP)
    const unread = paylinkSignupQuote({ schedule: TICKET, cuts })
    expect(unread.tagWaived).toBeUndefined()
    expect(unread.tagFee).toBeUndefined()
    expect(unread.networkFee).toBe(dai(0.5) + CUT + CUT + WITHDRAW_RELAYER_TIP)
  })

  it("funds a signed minimum above the cut once", () => {
    const quote = paylinkSignupQuote({
      paylink: dai(3),
      schedule: { fee: dai(0.5), min: dai(1) },
      cuts,
    })
    expect(quote.burn).toBe(dai(2.7))
    expect(quote.returned).toBe(dai(0.9))
    expect(quote.eventual).toBe(dai(1.2))
  })
})
