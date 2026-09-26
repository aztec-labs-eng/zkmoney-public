import { beforeEach, describe, expect, it, vi } from "vitest"
import { keccak256, toBytes } from "viem"
import {
  askedTotal,
  clearRegistrationTerms,
  floorExceedsAsk,
  loadRegistrationTerms,
  registrationDepositCredit,
  registrationDepositGross,
  quotedRegistrationKind,
  registrationKind,
  registrationQuote,
  rememberReissuedClaim,
  saveRegistrationTerms,
  scheduleForRecord,
  signedSchedule,
  registrationOffer,
  wireTermsFundTicket,
  termsUnpriced,
  type RegistrationTerms,
} from "../src/features/onboarding/registrationTerms"
import { stashTicketSignup } from "../src/features/paylink/claimStash"
import { linkIdentity } from "../src/features/paylink/linkIdentity"
import { boundTicketSignup } from "../src/features/paylink/ticketContinuation"
import { signOutNow } from "../src/features/identity/signOut"

// The real codec needs a node realm (see linkIdentity.test.ts); here a hash stands in for it,
// with the one property the binding relies on: the identity carries nothing of the fragment.
vi.mock("../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => {
    if (fragment === "not-a-link") throw new Error("Invalid paylink link")
    return keccak256(toBytes(`link:${fragment}`))
  },
}))

const PAYLINK_FRAGMENT = "inline-bearer-secret"

const ACCOUNT_A = "0x00000000000000000000000000000000000000aa"
const ACCOUNT_B = "0x00000000000000000000000000000000000000bb"

const stale = () =>
  saveRegistrationTerms({
    account: ACCOUNT_A,
    tag: "oldtag",
    deadline: Math.floor(Date.now() / 1000) + 7200,
    fee: String(5n * 10n ** 18n),
    minDeposit: String(10n * 10n ** 18n),
    feeWaived: false,
  })

beforeEach(() => {
  localStorage.clear()
})

describe("registration terms are scoped to one account", () => {
  it("a caller that names no account gets nothing", () => {
    stale()
    // The terms step runs before any record exists, so it has no account to name. Handing it the
    // last claim's quote priced a new tag off a dead reservation.
    expect(loadRegistrationTerms(undefined)).toBeNull()
  })

  it("another account's registration never reads these terms", () => {
    stale()
    expect(loadRegistrationTerms(ACCOUNT_B)).toBeNull()
    expect(loadRegistrationTerms(ACCOUNT_A)?.tag).toBe("oldtag")
  })

  it("the owning account still reads them, case-insensitively", () => {
    stale()
    expect(loadRegistrationTerms(ACCOUNT_A.toUpperCase())?.tag).toBe("oldtag")
  })

  it("the same device's next tag does not inherit the last tag's quote", () => {
    stale()
    // One passkey CREATE2-derives one OxideAccount, so every claim from this device shares an
    // account. Only the tag separates the quote that priced @oldtag from the next one.
    expect(loadRegistrationTerms(ACCOUNT_A, "newtag")).toBeNull()
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.tag).toBe("oldtag")
    expect(loadRegistrationTerms(ACCOUNT_A, "OLDTAG")?.tag).toBe("oldtag")
  })

  it("clearing drops the registration it names", () => {
    stale()
    clearRegistrationTerms(ACCOUNT_A, "oldtag")
    expect(loadRegistrationTerms(ACCOUNT_A)).toBeNull()
  })

  it("keeps one registration's schedule when another is stored on the same account", () => {
    stale()
    saveRegistrationTerms({
      account: ACCOUNT_A,
      tag: "newtag",
      deadline: Math.floor(Date.now() / 1000) + 7200,
      fee: String(1n * 10n ** 18n),
      minDeposit: String(2n * 10n ** 18n),
    })
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.fee).toBe(String(5n * 10n ** 18n))
    expect(loadRegistrationTerms(ACCOUNT_A, "newtag")?.fee).toBe(String(1n * 10n ** 18n))
    clearRegistrationTerms(ACCOUNT_A, "newtag")
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.fee).toBe(String(5n * 10n ** 18n))
  })
})

describe("terms written under the single legacy key", () => {
  const LEGACY_KEY = "webwallet.registration.terms"
  const legacy = (over: Partial<RegistrationTerms> = {}) =>
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({
        account: ACCOUNT_A,
        tag: "oldtag",
        deadline: 100,
        fee: "5",
        minDeposit: "10",
        ...over,
      }),
    )

  it("still read by the registration they were written for", () => {
    legacy()
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.fee).toBe("5")
    expect(loadRegistrationTerms(ACCOUNT_A)?.fee).toBe("5")
  })

  it("never read for another account or another tag", () => {
    legacy()
    expect(loadRegistrationTerms(ACCOUNT_B, "oldtag")).toBeNull()
    expect(loadRegistrationTerms(ACCOUNT_A, "newtag")).toBeNull()
  })

  it("move to their own key on the next write", () => {
    legacy()
    saveRegistrationTerms({ account: ACCOUNT_A, tag: "oldtag", deadline: 200, fee: "5" })
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.deadline).toBe(200)
  })

  it("are left alone by a write for a different registration", () => {
    legacy()
    saveRegistrationTerms({ account: ACCOUNT_A, tag: "newtag", deadline: 200 })
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.fee).toBe("5")
  })
})

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

describe("a re-issued claim against the stored quote", () => {
  const RECORD = { account: ACCOUNT_A, tag: "oldtag", fee: "5000000000000000000" }
  const priced = () =>
    saveRegistrationTerms({
      account: ACCOUNT_A,
      tag: "oldtag",
      deadline: 100,
      fee: RECORD.fee,
      minDeposit: String(10n * 10n ** 18n),
      feeWaived: true,
      depositAmount: "7",
    })

  it("replaces the schedule when the claim prices the committed fee", () => {
    priced()
    rememberReissuedClaim(RECORD, {
      deadline: "500",
      terms: {
        fee: RECORD.fee,
        minDeposit: "9",
        nonce: "1",
        deadline: "500",
        signature: "0x",
        reduced: false,
      },
    })
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")).toMatchObject({
      deadline: 500,
      minDeposit: "9",
      feeWaived: false,
      depositAmount: "7",
    })
  })

  it("refreshes only the deadline when the claim carries no schedule", () => {
    priced()
    rememberReissuedClaim(RECORD, { deadline: "500" })
    // Silence is not evidence the signed schedule was wrong.
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")).toMatchObject({
      deadline: 500,
      fee: RECORD.fee,
      minDeposit: String(10n * 10n ** 18n),
      feeWaived: true,
      depositAmount: "7",
    })
  })

  it("leaves everything alone when the claim prices another fee", () => {
    priced()
    rememberReissuedClaim(RECORD, {
      deadline: "500",
      terms: {
        fee: "1",
        minDeposit: "9",
        nonce: "1",
        deadline: "500",
        signature: "0x",
        reduced: false,
      },
    })
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.deadline).toBe(100)
  })

  it("names no waiver for a record that never stored one", () => {
    saveRegistrationTerms({ account: ACCOUNT_A, tag: "oldtag", deadline: 100 })
    rememberReissuedClaim({ account: ACCOUNT_A, tag: "oldtag" }, { deadline: "500" })
    expect(loadRegistrationTerms(ACCOUNT_A, "oldtag")?.feeWaived).toBeUndefined()
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
  it("names no gross while the funding read is out and nothing else has a figure", () => {
    expect(registrationDepositGross(0n, undefined, 0n)).toBeUndefined()
    // A live balance and a stamped amount each answer on their own.
    expect(registrationDepositGross(7n, undefined, 0n)).toBe(7n)
    expect(registrationDepositGross(0n, undefined, 3n)).toBe(3n)
  })

  it("reads a landed read of no transfers as a deposit of nothing", () => {
    expect(registrationDepositGross(0n, 0n, 0n)).toBe(0n)
  })

  it("calls nothing short while the gross is unread", () => {
    expect(
      registrationDepositCredit({ gross: undefined, floor: 11n, feeOwed: 1n, fpcCut: 1n }),
    ).toEqual({ short: false })
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
    expect(registrationOffer({ ...stored, paylinkFunded: true, paylinkId: "id:link" })).toEqual({
      kind: "golden_ticket",
      funding: "paylink",
      paylinkId: "id:link",
      blocked: false,
    })
    expect(
      registrationOffer({
        ...stored,
        paylinkFunded: true,
        paylinkId: "id:link",
        paylinkBlocked: true,
      }).funding === "paylink" &&
        (
          registrationOffer({
            ...stored,
            paylinkFunded: true,
            paylinkId: "id:link",
            paylinkBlocked: true,
          }) as { blocked: boolean }
        ).blocked,
    ).toBe(true)
    // A funded flag without the link's identity names no link to continue with.
    expect(registrationOffer({ ...stored, paylinkFunded: true }).funding).toBe("external_deposit")
    // An unpriced quote cannot waive a fee it never priced.
    expect(registrationOffer({ fee: "0", minDeposit: "0", feeWaived: true }).kind).toBe("standard")
  })
})

describe("registrationDepositCredit", () => {
  const base = { floor: 11n, feeOwed: 1n, fpcCut: 1n }

  it("calls a deposit short of the floor short, and names no credit for it", () => {
    // A settled verdict, not a read in flight: the row shows what was deposited.
    expect(registrationDepositCredit({ ...base, gross: 10n })).toEqual({ short: true })
  })

  it("withholds both figures until the portal's cut is read", () => {
    expect(registrationDepositCredit({ ...base, gross: 11n, fpcCut: undefined })).toEqual({
      short: false,
    })
  })

  it("nets the fee owed plus the portal's cut", () => {
    const credit = (feeOwed: bigint) =>
      registrationDepositCredit({ ...base, gross: 15n, feeOwed }).credit
    expect(credit(1n)).toBe(13n)
    expect(credit(3n)).toBe(11n)
    expect(credit(0n)).toBe(14n)
  })

  it("withholds both figures while the floor or the fee is unknown", () => {
    expect(registrationDepositCredit({ ...base, floor: undefined, gross: 11n })).toEqual({
      short: false,
    })
    expect(registrationDepositCredit({ ...base, feeOwed: undefined, gross: 11n })).toEqual({
      short: false,
    })
  })

  it("credits a deposit that clears the floor without reaching the asked total", () => {
    const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
    // 14.7 sent against a 14.5 floor: the chain takes it, so the row projects a credit rather
    // than reporting the whole gross as still-short.
    expect(
      registrationDepositCredit({
        gross: dai(14.7),
        floor: dai(14.5),
        feeOwed: dai(5),
        fpcCut: dai(0.25),
      }),
    ).toEqual({ credit: dai(9.45), short: false })
  })

  it("matches staging: a 15 DAI deposit, a 5 DAI fee and a 0.1 cut credit 9.9", () => {
    const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
    expect(
      registrationDepositCredit({
        gross: dai(15),
        floor: dai(15),
        feeOwed: dai(5),
        fpcCut: dai(0.1),
      }),
    ).toEqual({ credit: dai(9.9), short: false })
  })
})

describe("a paylink-funded registration names its link without its secret", () => {
  const TERMS_KEY = `webwallet.registration.terms:${ACCOUNT_A}:taga`
  const funded = () =>
    saveRegistrationTerms({
      account: ACCOUNT_A,
      tag: "taga",
      deadline: 1_100,
      fee: "1",
      minDeposit: "0",
      feeWaived: true,
      paylinkFunded: true,
      paylinkId: linkIdentity(PAYLINK_FRAGMENT),
    })
  const stash = () =>
    stashTicketSignup({
      fragment: PAYLINK_FRAGMENT,
      threshold: "2",
      schedule: { fee: "1", minDeposit: "0" },
    })

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it("survives sign-out and a closed tab in localStorage, with no bearer secret in it", () => {
    stash()
    funded()
    signOutNow()
    sessionStorage.clear()
    const stored = localStorage.getItem(TERMS_KEY)!
    expect(stored).not.toContain(PAYLINK_FRAGMENT)
    expect(stored).toContain(linkIdentity(PAYLINK_FRAGMENT))
    // The link reopened in the tab binds again by identity alone.
    stash()
    expect(boundTicketSignup(loadRegistrationTerms(ACCOUNT_A, "taga"))?.fragment).toBe(
      PAYLINK_FRAGMENT,
    )
  })

  it("a marker for another link, or none, is not this registration's continuation", () => {
    funded()
    expect(boundTicketSignup(loadRegistrationTerms(ACCOUNT_A, "taga"))).toBeNull()
    stashTicketSignup({
      fragment: "other-link",
      threshold: "2",
      schedule: { fee: "1", minDeposit: "0" },
    })
    expect(boundTicketSignup(loadRegistrationTerms(ACCOUNT_A, "taga"))).toBeNull()
  })

  it("keeps the binding through every write that does not name the funding", () => {
    funded()
    // A deposit stamp, a deadline refresh, a schedule rewrite: none of them drop the link.
    saveRegistrationTerms({
      account: ACCOUNT_A,
      tag: "taga",
      deadline: 1_200,
      fee: "1",
      minDeposit: "0",
    })
    saveRegistrationTerms({
      ...loadRegistrationTerms(ACCOUNT_A, "taga")!,
      depositAmount: "5",
    })
    expect(loadRegistrationTerms(ACCOUNT_A, "taga")).toMatchObject({
      deadline: 1_200,
      depositAmount: "5",
      paylinkFunded: true,
      paylinkId: linkIdentity(PAYLINK_FRAGMENT),
    })
    expect(registrationOffer(loadRegistrationTerms(ACCOUNT_A, "taga")).funding).toBe("paylink")
  })

  it("never carries one registration's link into another account or tag", () => {
    funded()
    saveRegistrationTerms({
      account: ACCOUNT_A,
      tag: "tagb",
      deadline: 1_100,
      fee: "1",
      minDeposit: "0",
    })
    saveRegistrationTerms({
      account: ACCOUNT_B,
      tag: "taga",
      deadline: 1_100,
      fee: "1",
      minDeposit: "0",
    })
    expect(loadRegistrationTerms(ACCOUNT_A, "tagb")?.paylinkFunded).toBeUndefined()
    expect(loadRegistrationTerms(ACCOUNT_B, "taga")?.paylinkFunded).toBeUndefined()
    expect(registrationOffer(loadRegistrationTerms(ACCOUNT_A, "tagb")).funding).toBe(
      "external_deposit",
    )
  })

  it("a renewal the link can pay keeps the binding and lifts a block; one it cannot pay blocks it", () => {
    funded()
    const record = { account: ACCOUNT_A, tag: "taga", fee: "1" }
    const refused = rememberReissuedClaim(record, {
      deadline: "1300",
      terms: {
        fee: "1",
        minDeposit: "0",
        nonce: "1",
        deadline: "1300",
        signature: "0x",
        reduced: true,
        ticket: false,
      },
    })
    expect(refused.ticketRefused).toBe(true)
    expect(loadRegistrationTerms(ACCOUNT_A, "taga")).toMatchObject({
      deadline: 1300,
      paylinkFunded: true,
      paylinkId: linkIdentity(PAYLINK_FRAGMENT),
      paylinkBlocked: true,
    })
    expect(registrationOffer(loadRegistrationTerms(ACCOUNT_A, "taga"))).toMatchObject({
      funding: "paylink",
      blocked: true,
    })
    // Renewed terms carrying no schedule leave the block, and the signed amounts, standing.
    expect(rememberReissuedClaim(record, { deadline: "1400" }).ticketRefused).toBe(false)
    expect(loadRegistrationTerms(ACCOUNT_A, "taga")).toMatchObject({
      deadline: 1400,
      fee: "1",
      minDeposit: "0",
      paylinkBlocked: true,
    })
    const renewed = rememberReissuedClaim(record, {
      deadline: "1500",
      terms: {
        fee: "1",
        minDeposit: "0",
        nonce: "2",
        deadline: "1500",
        signature: "0x",
        reduced: true,
        ticket: true,
      },
    })
    expect(renewed.ticketRefused).toBe(false)
    expect(loadRegistrationTerms(ACCOUNT_A, "taga")).toMatchObject({
      deadline: 1500,
      paylinkFunded: true,
    })
    expect(loadRegistrationTerms(ACCOUNT_A, "taga")?.paylinkBlocked).toBeUndefined()
  })

  it("a renewal that prices another fee keeps the stored quote and blocks the link on it", () => {
    funded()
    const before = loadRegistrationTerms(ACCOUNT_A, "taga")!
    const refused = rememberReissuedClaim(
      { account: ACCOUNT_A, tag: "taga", fee: "1" },
      {
        deadline: "1300",
        terms: {
          fee: "2",
          minDeposit: "0",
          nonce: "1",
          deadline: "1300",
          signature: "0x",
          reduced: true,
          ticket: true,
        },
      },
    )
    expect(refused.ticketRefused).toBe(true)
    expect(loadRegistrationTerms(ACCOUNT_A, "taga")).toEqual({ ...before, paylinkBlocked: true })
    // An ordinary registration on the same terms is simply left alone.
    saveRegistrationTerms({
      account: ACCOUNT_A,
      tag: "tagb",
      deadline: 1_100,
      fee: "1",
      minDeposit: "0",
    })
    const plain = loadRegistrationTerms(ACCOUNT_A, "tagb")
    expect(
      rememberReissuedClaim(
        { account: ACCOUNT_A, tag: "tagb", fee: "1" },
        {
          deadline: "1300",
          terms: {
            fee: "2",
            minDeposit: "0",
            nonce: "1",
            deadline: "1300",
            signature: "0x",
            reduced: false,
            ticket: false,
          },
        },
      ).ticketRefused,
    ).toBe(false)
    expect(loadRegistrationTerms(ACCOUNT_A, "tagb")).toEqual(plain)
  })

  it("only a write that names the funding as none drops the link", () => {
    funded()
    saveRegistrationTerms({
      account: ACCOUNT_A,
      tag: "taga",
      deadline: 1_100,
      fee: "1",
      minDeposit: "0",
      paylinkFunded: false,
    })
    expect(registrationOffer(loadRegistrationTerms(ACCOUNT_A, "taga")).funding).toBe(
      "external_deposit",
    )
  })
})

it("preserves the campaign expectation when the same quote is refreshed, but never transfers it to another tag", () => {
  saveRegistrationTerms({
    account: ACCOUNT_A,
    tag: "earned",
    deadline: 0,
    feeWaived: false,
    earnedExpected: true,
  })
  saveRegistrationTerms({
    account: ACCOUNT_A,
    tag: "earned",
    deadline: 100,
    feeWaived: false,
    fee: "5",
    minDeposit: "10",
  })
  expect(loadRegistrationTerms(ACCOUNT_A, "earned")).toMatchObject({
    earnedExpected: true,
    feeWaived: false,
  })
  saveRegistrationTerms({ account: ACCOUNT_A, tag: "different", deadline: 100, feeWaived: false })
  expect(loadRegistrationTerms(ACCOUNT_A, "different")?.earnedExpected).toBeUndefined()
})

describe("what to ask for and what the chain takes are two figures", () => {
  const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
  // Staging's v9 controller: a 14.5 floor under the 15 every registration is asked for.
  const staging = { min: dai(9.5), fee: dai(5) }
  // An earned schedule: the tag price waived down to the relayer's cut, its 4.9 floor under the 5
  // an earned tag is asked for.
  const earned = { min: dai(4.4), fee: dai(0.5) }
  // Staging's portal funding cut, under both minimums.
  const CUT = dai(0.1)

  it("asks a constant total before any schedule is known, and names no split", () => {
    const quote = registrationQuote(undefined, "standard", CUT)
    expect(quote.total).toBe(dai(15))
    expect(quote.fee).toBeUndefined()
    expect(quote.floor).toBeUndefined()
  })

  it("holds that total once the schedule lands, with the headroom over the floor", () => {
    const quote = registrationQuote(staging, "standard", CUT)
    expect(quote.total).toBe(dai(15))
    expect(quote.fee).toBe(dai(5))
    expect(quote.floor).toBe(dai(14.5))
  })

  it("quotes the fee on the schedule alone; the floor waits for the cut", () => {
    const quote = registrationQuote(staging)
    expect(quote.total).toBe(dai(15))
    expect(quote.fee).toBe(dai(5))
    expect(quote.floor).toBeUndefined()
  })

  it("asks the earned total for an earned schedule, with headroom over its floor", () => {
    const quote = registrationQuote(earned, "earned_tag", CUT)
    expect(quote.total).toBe(dai(5))
    expect(quote.floor).toBe(dai(4.9))
    expect(registrationQuote(undefined, "earned_tag", CUT).total).toBe(dai(5))
  })

  it("prices the floor off the cut once it outranks the minimum", () => {
    const quote = registrationQuote({ min: dai(0.1), fee: dai(0.5) }, "earned_tag", CUT)
    expect(quote.floor).toBe(dai(0.6) + 1n)
  })

  it("reads a signed earned floor under the ask as quotable, and one over it as not", () => {
    expect(floorExceedsAsk({ min: dai(4.4), fee: dai(0.5) }, "earned_tag", CUT)).toBe(false)
    expect(floorExceedsAsk({ min: dai(5), fee: dai(0.5) }, "earned_tag", CUT)).toBe(true)
    // The standard ask leaves the same schedule far inside its own bar.
    expect(floorExceedsAsk({ min: dai(5), fee: dai(0.5) }, "standard", CUT)).toBe(false)
    // A cut that outranks the minimum lifts the floor over the earned ask.
    expect(floorExceedsAsk({ min: dai(4.4), fee: dai(0.5) }, "earned_tag", dai(4.5))).toBe(true)
    // No cut, no verdict.
    expect(floorExceedsAsk({ min: dai(5), fee: dai(0.5) }, "earned_tag", undefined)).toBeUndefined()
  })

  it("names the schedule a stored waiver or a wire `reduced` flag stands for", () => {
    expect(registrationKind(true)).toBe("earned_tag")
    expect(registrationKind(false)).toBe("standard")
    expect(registrationKind(undefined)).toBe("standard")
  })

  it("refuses a kind nothing here prices, rather than quoting it as standard", () => {
    // The compiler forbids this; the runtime backstop is what stops a third kind priced as the
    // cheapest one if a wire value ever reaches here uncoerced.
    expect(() => askedTotal("future_kind" as never)).toThrow("future_kind")
  })

  it("reports a floor above the asked total and quotes the floor, never a refused figure", () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      // Renders call this, so a misconfigured deployment must not take the screen down with it.
      const quote = registrationQuote({ min: dai(15), fee: dai(1) }, "standard", CUT)
      expect(quote.total).toBe(dai(16))
      expect(quote.floor).toBe(dai(16))
      expect(report).toHaveBeenCalledTimes(1)
      // Once per distinct message: a re-render must not fill the console.
      registrationQuote({ min: dai(15), fee: dai(1) }, "standard", CUT)
      expect(report).toHaveBeenCalledTimes(1)
    } finally {
      report.mockRestore()
    }
  })

  it("decides the kind a registration is quoted as, and withholds it until it can", () => {
    expect(quotedRegistrationKind(false, undefined, undefined)).toBe("standard")
    expect(quotedRegistrationKind(undefined, earned, CUT)).toBe("standard")
    expect(quotedRegistrationKind(true, earned, CUT)).toBe("earned_tag")
    // A waived schedule whose floor outgrew the earned ask is quoted on the standard one.
    expect(quotedRegistrationKind(true, { min: dai(5), fee: dai(0.5) }, CUT)).toBe("standard")
    // Neither figure can be named without the schedule or the cut the floor is priced against.
    expect(quotedRegistrationKind(true, undefined, CUT)).toBe("earned_tag")
    expect(quotedRegistrationKind(true, earned, undefined)).toBeUndefined()
  })
})
