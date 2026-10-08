/**
 * Each address route states its own send and credit. The published limit counts what is sent, fees
 * included; the protocol ceiling counts what the portal credits. Registration takes the schedule
 * fee and the funding cut, not the plain deposit fee.
 */
import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import { TX_AMOUNT_CAP } from "@obsidion/sdk"
import {
  addressAmountBasis,
  addressShareDecision,
  fixedAmountLimits,
  maximumCreditAtomic,
  maximumSendAtomic,
  maximumSendForCapacity,
} from "../../../src/core/services/limits/addressLimits"
import type { CapacityEligibility } from "../../../src/oxide/portalCapacityEligibility"
import {
  NOMINAL_USD_VALUATION,
  type UsdValuation,
} from "../../../src/core/services/limits/amountLimits"

const dai = (v: string) => parseUnits(v, 18)
const usdc = (v: string) => parseUnits(v, 6)
/** Two tokens to the dollar: the published limit (5,000 tokens) then sits above the ceiling. */
const HALF_USD: UsdValuation = {
  source: "test",
  usdPerToken: { numerator: 1n, denominator: 2n },
}
const FEE = dai("0.35")

describe("amount basis per route", () => {
  it("leaves the amount to the sender on a deposit address", () => {
    expect(
      addressAmountBasis({ kind: "deposit", decimals: 18, swap: false, feeAtomic: FEE }),
    ).toEqual({ deductionAtomic: FEE })
  })

  it("does not state a credit for a swapped token", () => {
    expect(
      addressAmountBasis({ kind: "deposit", decimals: 6, swap: true, feeAtomic: FEE }),
    ).toEqual({
      deductionAtomic: undefined,
    })
  })

  it("sends a fixed request plus its fee and credits the requested amount", () => {
    const basis = addressAmountBasis({
      kind: "fixed-request",
      decimals: 18,
      requestedAtomic: dai("100"),
      feeAtomic: FEE,
    })
    expect(basis).toEqual({
      sendAtomic: dai("100.35"),
      creditAtomic: dai("100"),
      deductionAtomic: FEE,
    })
  })

  it("names no amount for an open request", () => {
    const basis = addressAmountBasis({ kind: "open-request", decimals: 18, feeAtomic: FEE })
    expect(basis.sendAtomic).toBeUndefined()
    expect(basis.creditAtomic).toBeUndefined()
  })

  it("credits a registration after its schedule fee and funding cut, not the deposit fee", () => {
    const basis = addressAmountBasis({
      kind: "registration",
      decimals: 18,
      askAtomic: dai("15"),
      scheduleFeeAtomic: dai("5"),
      fpcCutAtomic: dai("0.25"),
    })
    expect(basis.creditAtomic).toBe(dai("9.75"))
    // The plain-deposit formula would credit the ask less the relayer fee and cut only.
    expect(basis.creditAtomic).not.toBe(dai("15") - dai("0.5") - dai("0.25"))
  })

  it("holds a registration credit until both deductions are read", () => {
    const route = { kind: "registration", decimals: 18, askAtomic: dai("15") } as const
    expect(
      addressAmountBasis({ ...route, scheduleFeeAtomic: dai("5") }).creditAtomic,
    ).toBeUndefined()
    expect(addressAmountBasis({ ...route, fpcCutAtomic: dai("0.25") }).creditAtomic).toBeUndefined()
  })

  it("credits nothing when a registration's deductions reach its ask", () => {
    const basis = addressAmountBasis({
      kind: "registration",
      decimals: 18,
      askAtomic: dai("5"),
      scheduleFeeAtomic: dai("5"),
      fpcCutAtomic: dai("0.25"),
    })
    expect(basis.creditAtomic).toBe(0n)
  })
})

describe("maximum send amount", () => {
  it("is the published limit for the settlement token at the nominal rate", () => {
    const route = { kind: "deposit", decimals: 18, swap: false, feeAtomic: FEE } as const
    expect(maximumSendAtomic(route, NOMINAL_USD_VALUATION)).toBe(dai("2500"))
  })

  it("is the published limit for a 6-decimal swapped token", () => {
    const route = { kind: "deposit", decimals: 6, swap: true } as const
    expect(maximumSendAtomic(route, NOMINAL_USD_VALUATION)).toBe(usdc("2500"))
  })

  it("cannot be established without a valuation", () => {
    const route = { kind: "open-request", decimals: 18, feeAtomic: FEE } as const
    expect(maximumSendAtomic(route, undefined)).toBeUndefined()
  })

  it("stops at the ceiling plus the route's deductions when that is lower", () => {
    const deposit = { kind: "deposit", decimals: 18, swap: false, feeAtomic: FEE } as const
    expect(maximumSendAtomic(deposit, HALF_USD)).toBe(TX_AMOUNT_CAP + FEE)
    const registration = {
      kind: "registration",
      decimals: 18,
      scheduleFeeAtomic: dai("5"),
      fpcCutAtomic: dai("0.25"),
    } as const
    expect(maximumSendAtomic(registration, HALF_USD)).toBe(TX_AMOUNT_CAP + dai("5.25"))
  })

  it("cannot be established above the ceiling before the deductions are read", () => {
    const route = { kind: "deposit", decimals: 18, swap: false } as const
    expect(maximumSendAtomic(route, HALF_USD)).toBeUndefined()
  })

  it("applies only the published limit to a swapped token", () => {
    const route = { kind: "deposit", decimals: 6, swap: true } as const
    expect(maximumSendAtomic(route, HALF_USD)).toBe(usdc("5000"))
  })
})

describe("maximum credit", () => {
  it("is the maximum send less the current deposit fee on the settlement token", () => {
    const route = { kind: "deposit", decimals: 18, swap: false, feeAtomic: FEE } as const
    expect(maximumCreditAtomic(route, NOMINAL_USD_VALUATION)).toBe(dai("2499.65"))
  })

  it("is the maximum send less the fee on an open request", () => {
    const route = { kind: "open-request", decimals: 18, feeAtomic: FEE } as const
    expect(maximumCreditAtomic(route, NOMINAL_USD_VALUATION)).toBe(dai("2499.65"))
  })

  it("nets a registration's schedule fee and funding cut", () => {
    const route = {
      kind: "registration",
      decimals: 18,
      scheduleFeeAtomic: dai("5"),
      fpcCutAtomic: dai("0.25"),
    } as const
    expect(maximumCreditAtomic(route, NOMINAL_USD_VALUATION)).toBe(dai("2494.75"))
  })

  it("is unknown for a swapped token, whose credit the swap sets", () => {
    const route = { kind: "deposit", decimals: 6, swap: true, feeAtomic: FEE } as const
    expect(maximumCreditAtomic(route, NOMINAL_USD_VALUATION)).toBeUndefined()
  })

  it("is unknown before the fee is read", () => {
    const route = { kind: "deposit", decimals: 18, swap: false } as const
    expect(maximumCreditAtomic(route, NOMINAL_USD_VALUATION)).toBeUndefined()
  })

  it("is unknown without a valuation", () => {
    const route = { kind: "deposit", decimals: 18, swap: false, feeAtomic: FEE } as const
    expect(maximumCreditAtomic(route, undefined)).toBeUndefined()
  })
})

describe("fixed amount limits", () => {
  const request = (requested: bigint, decimals = 18, feeAtomic = FEE) =>
    ({ kind: "fixed-request", decimals, requestedAtomic: requested, feeAtomic } as const)

  it("accepts a request whose send, fee included, is exactly $2,500", () => {
    const limits = fixedAmountLimits(request(dai("2499.65")), NOMINAL_USD_VALUATION)
    expect(limits).toEqual({ publicLimit: "within", protocolCeiling: "within" })
  })

  it("refuses one base unit more", () => {
    const limits = fixedAmountLimits(request(dai("2499.65") + 1n), NOMINAL_USD_VALUATION)
    expect(limits?.publicLimit).toBe("over")
    expect(limits?.over).toBe("public")
  })

  it("draws the same line for a 6-decimal token", () => {
    const fee = usdc("0.35")
    expect(fixedAmountLimits(request(usdc("2499.65"), 6, fee), NOMINAL_USD_VALUATION)?.over).toBe(
      undefined,
    )
    expect(
      fixedAmountLimits(request(usdc("2499.65") + 1n, 6, fee), NOMINAL_USD_VALUATION)?.over,
    ).toBe("public")
  })

  it("checks the credit against the protocol ceiling apart from the published limit", () => {
    expect(fixedAmountLimits(request(TX_AMOUNT_CAP), HALF_USD)).toEqual({
      publicLimit: "within",
      protocolCeiling: "within",
    })
    expect(fixedAmountLimits(request(TX_AMOUNT_CAP + 1n), HALF_USD)).toEqual({
      publicLimit: "within",
      protocolCeiling: "over",
      over: "protocol",
    })
  })

  it("leaves the published limit open without a valuation", () => {
    const limits = fixedAmountLimits(request(dai("100")), undefined)
    expect(limits?.publicLimit).toBe("valuation-unavailable")
    expect(limits?.over).toBeUndefined()
  })

  it("has nothing to check on a route without an amount", () => {
    const open = { kind: "open-request", decimals: 18, feeAtomic: FEE } as const
    expect(fixedAmountLimits(open, NOMINAL_USD_VALUATION)).toBeUndefined()
    const deposit = { kind: "deposit", decimals: 18, swap: false, feeAtomic: FEE } as const
    expect(fixedAmountLimits(deposit, NOMINAL_USD_VALUATION)).toBeUndefined()
  })

  it("counts a registration's whole ask as its send", () => {
    const registration = (ask: bigint) =>
      ({
        kind: "registration",
        decimals: 18,
        askAtomic: ask,
        scheduleFeeAtomic: dai("5"),
        fpcCutAtomic: dai("0.25"),
      } as const)
    expect(fixedAmountLimits(registration(dai("2500")), NOMINAL_USD_VALUATION)?.over).toBe(
      undefined,
    )
    expect(fixedAmountLimits(registration(dai("2500") + 1n), NOMINAL_USD_VALUATION)?.over).toBe(
      "public",
    )
  })

  it("leaves a registration's ceiling open until its deductions are read", () => {
    const limits = fixedAmountLimits(
      { kind: "registration", decimals: 18, askAtomic: dai("15") },
      NOMINAL_USD_VALUATION,
    )
    expect(limits).toEqual({ publicLimit: "within", protocolCeiling: "credit-unknown" })
  })
})

describe("maximum send for current capacity", () => {
  const deposit = { kind: "deposit", decimals: 18, swap: false, feeAtomic: FEE } as const

  it("is the available capacity plus the route's deductions", () => {
    expect(maximumSendForCapacity(deposit, dai("500"), NOMINAL_USD_VALUATION)).toBe(dai("500.35"))
  })

  it("never exceeds the per-deposit maximum", () => {
    expect(maximumSendForCapacity(deposit, dai("50000"), NOMINAL_USD_VALUATION)).toBe(dai("2500"))
  })

  it("adds a registration's schedule fee and funding cut", () => {
    const registration = {
      kind: "registration",
      decimals: 18,
      scheduleFeeAtomic: dai("5"),
      fpcCutAtomic: dai("0.25"),
    } as const
    expect(maximumSendForCapacity(registration, dai("100"), NOMINAL_USD_VALUATION)).toBe(
      dai("105.25"),
    )
  })

  it("is unknown for a swapped token and before the fee is read", () => {
    const swapped = { kind: "deposit", decimals: 6, swap: true, feeAtomic: FEE } as const
    expect(maximumSendForCapacity(swapped, dai("500"), NOMINAL_USD_VALUATION)).toBeUndefined()
    const unread = { kind: "deposit", decimals: 18, swap: false } as const
    expect(maximumSendForCapacity(unread, dai("500"), NOMINAL_USD_VALUATION)).toBeUndefined()
  })

  it("rounds down to a typeable amount", () => {
    expect(maximumSendForCapacity(deposit, dai("500") + 1n, NOMINAL_USD_VALUATION)).toBe(
      dai("500.35"),
    )
  })
})

describe("address share decision", () => {
  const observed = {
    snapshot: {
      chainId: 1,
      portal: "0x0000000000000000000000000000000000000001",
      token: "0x0000000000000000000000000000000000000002",
      decimals: 18,
      blockNumber: 1n,
      blockTimestamp: 1n,
      rateAtomicPerSecond: 0n,
      globalLimitAtomic: dai("50000"),
      availableAtomic: 0n,
    },
    fetchedAt: 0,
  } as const
  const e = (value: object) => value as CapacityEligibility

  it("holds a fixed amount that known capacity cannot take", () => {
    const short = e({
      kind: "exceeds-available",
      requiredAtomic: 2n,
      shortfallAtomic: 1n,
      estimate: { status: "none" },
      ...observed,
    })
    expect(addressShareDecision(short, true)).toBe("block")
    expect(
      addressShareDecision(e({ kind: "exceeds-ceiling", requiredAtomic: 2n, ...observed }), true),
    ).toBe("block")
    expect(
      addressShareDecision(
        e({
          kind: "exceeds-operation-cap",
          operationCap: { status: "unverified", sourceAtomic: 1n },
        }),
        true,
      ),
    ).toBe("block")
  })

  it("allows a fixed amount that fits, even when capacity is low", () => {
    expect(
      addressShareDecision(e({ kind: "fits", requiredAtomic: 1n, low: true, ...observed }), true),
    ).toBe("allow")
  })

  it("warns about zero capacity with or without an amount", () => {
    const zero = e({ kind: "amount-unknown", low: true, zero: true, ...observed })
    expect(addressShareDecision(zero, false)).toBe("warn-zero")
    expect(addressShareDecision(zero, true)).toBe("warn-zero")
  })

  it("allows an open amount when capacity is known and above zero", () => {
    const some = e({ kind: "amount-unknown", low: true, zero: false, ...observed })
    expect(addressShareDecision(some, false)).toBe("allow")
    // A fixed amount whose credit is unknown cannot be matched to it.
    expect(addressShareDecision(some, true)).toBe("warn-unknown")
  })

  it("warns while capacity is being read, out of date, unavailable or unsupported", () => {
    for (const kind of ["checking", "stale", "unavailable", "unsupported"]) {
      expect(addressShareDecision(e({ kind, reason: "age", ...observed }), false)).toBe(
        "warn-unknown",
      )
      expect(addressShareDecision(e({ kind, reason: "age", ...observed }), true)).toBe(
        "warn-unknown",
      )
    }
  })
})
