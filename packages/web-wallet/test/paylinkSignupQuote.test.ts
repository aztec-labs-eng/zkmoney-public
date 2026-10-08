import { describe, expect, it } from "vitest"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { paylinkSignupQuote } from "../src/features/paylink/paylinkSignupQuote"

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
const CUT = dai(0.1)
const TICKET = { fee: dai(0.5), min: 0n }
const cuts = { withdrawalCut: CUT, depositCut: CUT }

describe("paylinkSignupQuote", () => {
  it("burns both portal cuts and the relayer tip, keeps the rest now and the return later", () => {
    const quote = paylinkSignupQuote({
      paylink: dai(3),
      schedule: TICKET,
      cuts,
      sweepFee: dai(0.5),
      proverTip: 0n,
    })
    expect(quote.burn).toBe(dai(0.81))
    // The burn's dust slice comes back with the sweep, but at a cent it is folded into the network
    // fee rather than shown as funds owed back.
    expect(quote.returned).toBe(0n)
    expect(quote.youReceive).toBe(dai(2.19))
    expect(quote.eventual).toBe(dai(2.2))
    expect(quote.covers).toBe(true)
    expect(quote.tagWaived).toBe(true)
    expect(quote.tagFee).toBe(0n)
    // Sweep fee, both cuts, the relayer tip and the dust.
    expect(quote.networkFee).toBe(dai(0.5) + CUT + CUT + WITHDRAW_RELAYER_TIP + dai(0.01))
    expect(quote.provingFee).toBe(0n)
    // Every row accounts for the note: what is kept and what leaves.
    expect(
      quote.youReceive! + quote.returned + quote.tagFee! + quote.networkFee + quote.provingFee,
    ).toBe(dai(3))
  })

  it("takes a committed prover tip from what the note leaves, on its own line", () => {
    const quote = paylinkSignupQuote({
      paylink: dai(3),
      schedule: TICKET,
      cuts,
      sweepFee: dai(0.5),
      proverTip: dai(0.4),
    })
    expect(quote.burn).toBe(dai(1.21))
    expect(quote.youReceive).toBe(dai(1.79))
    expect(quote.eventual).toBe(dai(1.8))
    expect(quote.networkFee).toBe(dai(0.5) + CUT + CUT + WITHDRAW_RELAYER_TIP + dai(0.01))
    expect(quote.provingFee).toBe(dai(0.4))
    expect(
      quote.youReceive! + quote.returned + quote.tagFee! + quote.networkFee + quote.provingFee,
    ).toBe(dai(3))
    expect(
      paylinkSignupQuote({ paylink: dai(1.21), schedule: TICKET, cuts, proverTip: dai(0.4) })
        .covers,
    ).toBe(false)
  })

  it("does not cover a note at or below the burn, and prices no coverage without an amount", () => {
    const at = (paylink: bigint) =>
      paylinkSignupQuote({ paylink, schedule: TICKET, cuts, proverTip: 0n }).covers
    expect(at(dai(0.81))).toBe(false)
    expect(at(dai(0.81) + 1n)).toBe(true)
    const unknown = paylinkSignupQuote({ schedule: TICKET, cuts, proverTip: 0n })
    expect(unknown.covers).toBeUndefined()
    expect(unknown.youReceive).toBeUndefined()
    expect(unknown.burn).toBe(dai(0.81))
  })

  it("names a fee above the live sweep fee as the tag's price, and withholds the verdict until that fee is read", () => {
    const dearer = paylinkSignupQuote({
      schedule: { fee: dai(0.7), min: 0n },
      cuts,
      sweepFee: dai(0.5),
      proverTip: 0n,
    })
    expect(dearer.tagWaived).toBe(false)
    expect(dearer.tagFee).toBe(dai(0.2))
    expect(dearer.networkFee).toBe(dai(0.5) + CUT + CUT + WITHDRAW_RELAYER_TIP + dai(0.01))
    const unread = paylinkSignupQuote({ schedule: TICKET, cuts, proverTip: 0n })
    expect(unread.tagWaived).toBeUndefined()
    expect(unread.tagFee).toBeUndefined()
    expect(unread.networkFee).toBe(dai(0.5) + CUT + CUT + WITHDRAW_RELAYER_TIP + dai(0.01))
  })

  it("funds a signed minimum above the cut once, and names its excess as returned", () => {
    const quote = paylinkSignupQuote({
      paylink: dai(3),
      schedule: { fee: dai(0.5), min: dai(1) },
      cuts,
      proverTip: 0n,
    })
    expect(quote.burn).toBe(dai(1.7))
    // Real funds held until the sweep, not dust: it is a row of its own, off the network fee.
    expect(quote.returned).toBe(dai(0.9))
    expect(quote.networkFee).toBe(dai(0.5) + CUT + CUT + WITHDRAW_RELAYER_TIP)
    expect(quote.eventual).toBe(dai(2.2))
    expect(quote.youReceive! + quote.returned + quote.networkFee + quote.provingFee).toBe(dai(3))
  })
})
