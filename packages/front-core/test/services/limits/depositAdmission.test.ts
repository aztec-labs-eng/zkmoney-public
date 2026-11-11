import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import { PUBLIC_TX_LIMIT_USD } from "@obsidion/core/constants"
import {
  publicLimitAtomic,
  type UsdValuation,
} from "../../../src/core/services/limits/amountLimits"
import {
  admitDeposit,
  type DepositLanding,
} from "../../../src/core/services/limits/depositAdmission"

const price = (numerator: bigint, denominator = 1n): UsdValuation => ({
  source: "test",
  usdPerToken: { numerator, denominator },
})
const PAR = price(1n)
const dai = (display: string) => parseUnits(display, 18)
const usdc = (display: string) => parseUnits(display, 6)
const DAI = "0x00000000000000000000000000000000000000da"
const TX_AMOUNT_CAP = dai("5166")
const LIMIT = String(PUBLIC_TX_LIMIT_USD)
const FEE = dai("0.35")

const settlement: DepositLanding = {
  token: { symbol: "DAI", decimals: 18, settlesIn: DAI, swapped: false },
  depositFeeAtomic: FEE,
  txAmountCap: TX_AMOUNT_CAP,
  minimumAtomic: dai("1"),
}
/** The Ethereum route: the wallet sends exactly what lands. */
const sent = (landing: DepositLanding, landed: bigint, valuation?: UsdValuation) =>
  admitDeposit(landing, {
    landedAtomic: landed,
    gross: { atomic: landed, decimals: landing.token.decimals, valuation },
  })

describe("admitDeposit on the settlement token", () => {
  it("counts the gross send, fee included, against the published limit", () => {
    const at = sent(settlement, dai(LIMIT), PAR)
    expect(at.problem).toBeUndefined()
    expect(at.creditAtomic).toBe(dai(LIMIT) - FEE)
    expect(at.required).toEqual({
      status: "known",
      atomic: dai(LIMIT) - FEE,
      token: DAI,
      decimals: 18,
    })
    expect(at.maxLandedAtomic).toBe(dai(LIMIT))
    expect(sent(settlement, dai(LIMIT) + 1n, PAR).problem).toBe("public")
  })

  it("checks the net credit against the protocol ceiling, the fee on top", () => {
    // A valuation under a dollar lifts the published limit above the ceiling.
    const cheap = price(4n, 10n)
    const at = sent(settlement, TX_AMOUNT_CAP + FEE, cheap)
    expect(at.problem).toBeUndefined()
    expect(at.maxLandedAtomic).toBe(TX_AMOUNT_CAP + FEE)
    expect(sent(settlement, TX_AMOUNT_CAP + FEE + 1n, cheap).problem).toBe("protocol")
  })

  it("leaves the ceiling undecided and MAX at the published limit before the cap is read", () => {
    const cheap = price(95n, 100n)
    const unread = { ...settlement, txAmountCap: undefined }
    const limits = sent(unread, dai("5200"), cheap)
    expect(limits.problem).toBeUndefined()
    expect(limits.maxLandedAtomic).toBe(publicLimitAtomic(18, cheap))
  })

  it("refuses what reaches the private balance below the minimum", () => {
    expect(sent(settlement, dai("1") + FEE, PAR).problem).toBeUndefined()
    expect(sent(settlement, dai("1") + FEE - 1n, PAR).problem).toBe("minimum")
  })

  it("has no MAX and refuses without a valuation", () => {
    const limits = sent(settlement, dai("10"), undefined)
    expect(limits.problem).toBe("valuation")
    expect(limits.maxLandedAtomic).toBeUndefined()
  })
})

describe("admitDeposit on a swapped token", () => {
  const swapped: DepositLanding = {
    token: { symbol: "USDC", decimals: 6, settlesIn: DAI, swapped: true },
    depositFeeAtomic: usdc("0.35"),
    txAmountCap: TX_AMOUNT_CAP,
    minimumAtomic: usdc("1"),
  }

  it("leaves the credit unknown and prices the send in the sent token", () => {
    const limits = sent(swapped, usdc(LIMIT), PAR)
    expect(limits.creditAtomic).toBeUndefined()
    expect(limits.required).toEqual({ status: "unknown" })
    expect(limits.problem).toBeUndefined()
    // The cap counts settlement units, so only the published limit bounds MAX.
    expect(limits.maxLandedAtomic).toBe(usdc(LIMIT))
  })
})

describe("admitDeposit on a bridge-in", () => {
  // 1 USDC on the origin lands as 0.99 DAI on L1; the landing is valued at $1.
  const landed = dai("990")
  const ask = (origin: bigint, lands: bigint) => ({
    landedAtomic: lands,
    gross: { atomic: origin, decimals: 6, valuation: price(99n, 100n) },
  })

  it("counts the gross origin amount at the quote's rate against the published limit", () => {
    expect(admitDeposit(settlement, ask(usdc("1000"), landed)).problem).toBeUndefined()
    // $5,000 at the quote's rate is about 5,050.5 USDC sent.
    expect(admitDeposit(settlement, ask(usdc("5050"), dai("4999.5"))).problem).toBeUndefined()
    expect(admitDeposit(settlement, ask(usdc("5051"), dai("5000.49"))).problem).toBe("public")
  })

  it("maps the published limit into landing units at the ask's own ratio", () => {
    const limits = admitDeposit(
      { ...settlement, txAmountCap: undefined },
      ask(usdc("1000"), landed),
    )
    const limit = publicLimitAtomic(6, price(99n, 100n))!
    expect(limits.maxLandedAtomic).toBe((limit * landed) / usdc("1000"))
  })

  it("bounds MAX by the cap on the settlement credit", () => {
    const capped = { ...settlement, txAmountCap: dai("500") }
    expect(admitDeposit(capped, ask(usdc("1000"), landed)).maxLandedAtomic).toBe(dai("500") + FEE)
  })
})
