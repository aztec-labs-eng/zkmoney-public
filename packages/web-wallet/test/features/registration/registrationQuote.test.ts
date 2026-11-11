import { describe, expect, it, vi } from "vitest"
import type { NameClaimResponse } from "@obsidion/core/types"
import {
  askedTotal,
  claimTerms,
  floorExceedsAsk,
  registrationDepositCredit,
  registrationDepositGross,
  quoteExpired,
  quotedRegistrationKind,
  registrationQuote,
  reservedUntil,
  scheduleForRecord,
  signedSchedule,
  registrationOffer,
  wireTermsFundTicket,
  termsUnpriced,
} from "../../../src/features/registration/registrationTerms"
import { reportShortAsk } from "../../../src/features/registration/registrationAsk"
import { PAID_ASK, RANDOM, RANDOM_ASK } from "../../support/registrationPrices"
import { dai } from "../../support/registrationFixtures"

describe("an unpriced quote prices nothing", () => {
  it("all-zero signed terms are a claim server with no schedule, not a free tag", () => {
    const zero = { fee: "0", minDeposit: "0" }
    expect(termsUnpriced(zero)).toBe(true)
    expect(signedSchedule(zero)).toBeUndefined()
  })

  it("a zero fee over a real minimum is still a priced quote", () => {
    const zeroFee = { fee: "0", minDeposit: String(5n * 10n ** 18n) }
    expect(termsUnpriced(zeroFee)).toBe(false)
    expect(signedSchedule(zeroFee)).toEqual({ min: 5n * 10n ** 18n, fee: 0n })
  })

  it("terms carrying no schedule at all fall through without claiming to be unpriced", () => {
    expect(termsUnpriced({})).toBe(false)
    expect(signedSchedule({})).toBeUndefined()
  })
})

describe("the reservation's deadline", () => {
  const NOW = 1_000_000_000_000

  it("keeps the claim server's hold as the reservation's one deadline", () => {
    const hold = NOW / 1000 + 7 * 86_400
    const claim: NameClaimResponse = {
      signature: "0x",
      nonce: "1",
      deadline: String(NOW / 1000 + 14 * 86_400),
      hold: { deadline: String(hold) },
      terms: {
        fee: "1",
        minDeposit: "9",
        nonce: "1",
        deadline: String(NOW / 1000 + 86_400),
        signature: "0x",
        reduced: false,
        ticket: false,
      },
    }
    expect(claimTerms(claim).deadline).toBe(hold)
    expect(reservedUntil(claimTerms(claim), NOW)).toBe(hold * 1000)
  })

  it("names the reservation's end only while it holds", () => {
    const live = NOW / 1000 + 60
    expect(reservedUntil({ deadline: live }, NOW)).toBe(live * 1000)
    expect(reservedUntil({ deadline: NOW / 1000 - 60 }, NOW)).toBeUndefined()
    expect(reservedUntil({ deadline: 0 }, NOW)).toBeUndefined()
    expect(reservedUntil(null, NOW)).toBeUndefined()
  })

  it("an unknown claim deadline never reads as expired", () => {
    expect(quoteExpired({ deadline: NOW / 1000 - 60 }, NOW)).toBe(true)
    expect(quoteExpired({ deadline: NOW / 1000 + 60 }, NOW)).toBe(false)
    expect(quoteExpired({ deadline: 0 }, NOW)).toBe(false)
    expect(quoteExpired(null, NOW)).toBe(false)
  })
})

describe("the schedule that prices one registration", () => {
  const signed = { fee: "5", minDeposit: "10" }

  it("prefers the signed schedule over the deployment's", () => {
    expect(scheduleForRecord(signed, { min: 2n, fee: 9n }, undefined)).toEqual({
      min: 10n,
      fee: 5n,
    })
  })

  it("prices nothing off a signed schedule that names another fee", () => {
    // A signed minimum paired with the committed fee would be a schedule nobody signed.
    expect(scheduleForRecord(signed, undefined, 9n)).toBeUndefined()
  })

  it("prices nothing off a deployment schedule that names another fee", () => {
    expect(scheduleForRecord(null, { min: 2n, fee: 9n }, 5n)).toBeUndefined()
  })

  it("takes either schedule when it names the committed fee", () => {
    expect(scheduleForRecord(signed, undefined, 5n)).toEqual({ min: 10n, fee: 5n })
    expect(scheduleForRecord(null, { min: 2n, fee: 9n }, 9n)).toEqual({ min: 2n, fee: 9n })
  })
})

describe("what a registration deposit is worth", () => {
  it.each([
    ["nothing while the funding read is out", 0n, undefined, 0n, undefined],
    ["the live balance while the address holds it", 7n, undefined, 0n, 7n],
    ["the stamped amount before the funding read lands", 0n, undefined, 3n, 3n],
    ["nothing for a landed read of no transfers", 0n, 0n, 0n, 0n],
    ["the summed funding of a topped-up deposit, not its first tranche", 0n, 11n, 5n, 11n],
    ["the stamped amount over a landed read that missed it", 0n, 0n, 5n, 5n],
  ])("the gross is %s", (_, live, fundedTotal, stamped, gross) => {
    expect(registrationDepositGross(live, fundedTotal, stamped)).toBe(gross)
  })

  it("the wire ticket flag, not a reduced flag or a low fee, makes terms a paylink can pay", () => {
    const sweep = { fee: String(5n * 10n ** 17n), minDeposit: "0" }
    expect(wireTermsFundTicket({ ...sweep, ticket: true })).toBe(true)
    expect(wireTermsFundTicket({ ...sweep, ticket: true, reduced: true })).toBe(true)
    // Reduced alone is an earned tag: its deposit is asked for, never burned from a link.
    expect(wireTermsFundTicket({ ...sweep, reduced: true })).toBe(false)
    expect(wireTermsFundTicket(sweep)).toBe(false)
    // A ticket that prices no sweep, or nothing at all, cannot be paid by a burn.
    expect(
      wireTermsFundTicket({ fee: "0", minDeposit: String(5n * 10n ** 18n), ticket: true }),
    ).toBe(false)
    expect(wireTermsFundTicket({ fee: "0", minDeposit: "0", ticket: true })).toBe(false)
    expect(wireTermsFundTicket(undefined)).toBe(false)
  })

  it("the stored ticket binding decides the funding before the reduced flag does", () => {
    const stored = { fee: String(5n * 10n ** 17n), minDeposit: "0", feeWaived: true }
    expect(registrationOffer(stored)).toEqual({ kind: "earned_tag", funding: "external_deposit" })
    expect(registrationOffer({ ...stored, feeWaived: false })).toEqual({
      kind: "standard",
      funding: "external_deposit",
    })
    const bound = { ...stored, paylinkFunded: true, paylinkId: "id:link" }
    expect(registrationOffer(bound)).toEqual({
      kind: "golden_ticket",
      funding: "paylink",
      paylinkId: "id:link",
      blocked: false,
    })
    expect(registrationOffer({ ...bound, paylinkBlocked: true })).toMatchObject({
      funding: "paylink",
      blocked: true,
    })
    // A funded flag without the link's identity names no link to continue with.
    expect(registrationOffer({ ...stored, paylinkFunded: true }).funding).toBe("external_deposit")
    // An unpriced quote cannot waive a fee it never priced.
    expect(registrationOffer({ fee: "0", minDeposit: "0", feeWaived: true }).kind).toBe("standard")
  })
})

describe("registrationDepositCredit", () => {
  const base = { floor: 11n, feeOwed: 1n }

  it("calls a deposit short of the floor short, and names no credit for it", () => {
    // A settled verdict, not a read in flight: the row shows what was deposited.
    expect(registrationDepositCredit({ ...base, gross: 10n })).toEqual({ short: true })
  })

  it.each(["gross", "floor", "feeOwed"] as const)(
    "withholds both figures while the %s is unread",
    (unread) => {
      expect(registrationDepositCredit({ ...base, gross: 11n, [unread]: undefined })).toEqual({
        short: false,
      })
    },
  )

  it.each([
    ["no fee", { ...base, gross: 15n, feeOwed: 0n }, 15n],
    // 14.7 sent against a 14.5 floor: the chain takes it, so the row projects a credit rather
    // than reporting the whole gross as still-short.
    [
      "a deposit over the floor but under the asked total",
      { gross: dai(14.7), floor: dai(14.5), feeOwed: dai(5) },
      dai(9.7),
    ],
  ])("nets %s", (_, input, credit) => {
    expect(registrationDepositCredit(input)).toEqual({ credit, short: false })
  })
})

describe("what to ask for and what the chain takes are two figures", () => {
  // The default schedules: each floor is its fee plus its minimum.
  const earned = RANDOM
  // An earned schedule whose floor is over the earned ask.
  const overAsk = { min: RANDOM_ASK, fee: RANDOM.fee }

  it.each([["before any schedule is known, with no split", undefined, undefined, undefined]])(
    "asks the constant standard total %s",
    (_, schedule, fee, floor) => {
      expect(registrationQuote(schedule, "standard")).toEqual({ total: PAID_ASK, fee, floor })
    },
  )

  it("asks the earned total for an earned schedule, with headroom over its floor", () => {
    const quote = registrationQuote(earned, "earned_tag")
    expect(quote.total).toBe(RANDOM_ASK)
    expect(quote.floor).toBe(earned.fee + earned.min)
    expect(registrationQuote(undefined, "earned_tag").total).toBe(RANDOM_ASK)
  })

  it("reads a signed earned floor under the ask as quotable, and one over it as not", () => {
    expect(floorExceedsAsk(earned, "earned_tag")).toBe(false)
    expect(floorExceedsAsk(overAsk, "earned_tag")).toBe(true)
    // The standard ask leaves the same schedule inside its own bar.
    expect(floorExceedsAsk(overAsk, "standard")).toBe(false)
  })

  it("refuses a kind nothing here prices, rather than quoting it as standard", () => {
    // The compiler forbids this; the runtime backstop is what stops a third kind priced as the
    // cheapest one if a wire value ever reaches here uncoerced.
    expect(() => askedTotal("future_kind" as never)).toThrow("future_kind")
  })

  it("quotes a floor above the asked total, never a refused figure, and the read reports it", () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      // Renders call this, so a misconfigured deployment must not take the screen down with it.
      const quote = registrationQuote({ min: dai(15), fee: dai(1) }, "standard")
      expect(quote.total).toBe(dai(16))
      expect(quote.floor).toBe(dai(16))
      expect(report).not.toHaveBeenCalled()
      // The schedule's read reports it, not each render.
      reportShortAsk({ min: dai(15), fee: dai(1) })
      expect(report).toHaveBeenCalledTimes(1)
    } finally {
      report.mockRestore()
    }
  })

  it("decides the kind a registration is quoted as", () => {
    expect(quotedRegistrationKind(false, undefined)).toBe("standard")
    expect(quotedRegistrationKind(undefined, earned)).toBe("standard")
    expect(quotedRegistrationKind(true, earned)).toBe("earned_tag")
    // A waived schedule whose floor outgrew the earned ask is quoted on the standard one.
    expect(quotedRegistrationKind(true, overAsk)).toBe("standard")
    // With no schedule the waiver's hint stands.
    expect(quotedRegistrationKind(true, undefined)).toBe("earned_tag")
  })
})
