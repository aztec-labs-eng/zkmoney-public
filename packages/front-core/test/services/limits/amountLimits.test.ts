import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import { PUBLIC_TX_LIMIT_USD } from "@obsidion/core/constants"
import {
  checkProtocolCeiling,
  checkPublicLimit,
  depositLimits,
  depositTokenValuation,
  floorToTypeable,
  NOMINAL_USD_VALUATION,
  publicLimitAtomic,
  withdrawalLimits,
  withdrawalMax,
  withdrawalMaxNet,
  type UsdValuation,
} from "../../../src/core/services/limits/amountLimits"

/** Test prices only: no production valuation source is implied. */
const price = (numerator: bigint, denominator = 1n): UsdValuation => ({
  source: "test",
  usdPerToken: { numerator, denominator },
})
const PAR = price(1n)
const dai = (display: string) => parseUnits(display, 18)
const usdc = (display: string) => parseUnits(display, 6)
/** The portal's `TX_AMOUNT_CAP()`, as the caller reads it. */
const TX_AMOUNT_CAP = dai("5166")
const LIMIT = String(PUBLIC_TX_LIMIT_USD)
const CENT = "0.01"

describe("published USD limit", () => {
  it("admits exactly the limit and refuses one typeable unit or one atomic unit above", () => {
    expect(checkPublicLimit(dai(LIMIT), 18, PAR)).toBe("within")
    expect(checkPublicLimit(dai(LIMIT) + dai(CENT), 18, PAR)).toBe("over")
    expect(checkPublicLimit(dai(LIMIT) + 1n, 18, PAR)).toBe("over")
    expect(checkPublicLimit(usdc(LIMIT), 6, PAR)).toBe("within")
    expect(checkPublicLimit(usdc(LIMIT) + usdc(CENT), 6, PAR)).toBe("over")
    expect(checkPublicLimit(usdc(LIMIT) + 1n, 6, PAR)).toBe("over")
  })

  it("converts through the valuation, never by assuming one token is one dollar", () => {
    const below = price(9998n, 10_000n)
    const belowLimit = floorToTypeable((dai(LIMIT) * 10_000n) / 9998n, 18)
    expect(belowLimit).toBeGreaterThan(dai(LIMIT))
    expect(publicLimitAtomic(18, below)).toBe(belowLimit)
    expect(checkPublicLimit(belowLimit, 18, below)).toBe("within")
    expect(checkPublicLimit(belowLimit + dai(CENT), 18, below)).toBe("over")
    const above = price(10_002n, 10_000n)
    expect(checkPublicLimit(dai(LIMIT), 18, above)).toBe("over")
    expect(publicLimitAtomic(6, above)).toBe(floorToTypeable((usdc(LIMIT) * 10_000n) / 10_002n, 6))
  })

  it("reports an unavailable valuation instead of passing or failing", () => {
    expect(checkPublicLimit(dai("1"), 18, undefined)).toBe("valuation-unavailable")
    expect(checkPublicLimit(dai("1"), 18, price(0n))).toBe("valuation-unavailable")
    expect(checkPublicLimit(dai("1"), 18, price(1n, 0n))).toBe("valuation-unavailable")
    expect(publicLimitAtomic(18, undefined)).toBeUndefined()
  })
})

describe("depositTokenValuation", () => {
  const MAINNET_DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
  const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
  const TEST_TOKEN = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
  const accepted = [MAINNET_DAI, MAINNET_USDC]

  it("values every accepted deposit token at the stated $1 rate, matched by address", () => {
    for (const token of [MAINNET_DAI, MAINNET_USDC.toLowerCase()]) {
      expect(depositTokenValuation({ accepted, token })).toBe(NOMINAL_USD_VALUATION)
    }
    expect(NOMINAL_USD_VALUATION.source).toBe("nominal-1-usd-per-token")
  })

  it("does not value a token the table does not accept, whatever it calls itself", () => {
    expect(depositTokenValuation({ accepted, token: TEST_TOKEN })).toBeUndefined()
    expect(depositTokenValuation({ accepted, token: "USDC" })).toBeUndefined()
  })
})

describe("protocol ceiling", () => {
  it("admits the portal's cap and refuses one atomic unit or one typeable unit above", () => {
    expect(checkProtocolCeiling(TX_AMOUNT_CAP, TX_AMOUNT_CAP)).toBe("within")
    expect(checkProtocolCeiling(TX_AMOUNT_CAP + 1n, TX_AMOUNT_CAP)).toBe("over")
    expect(checkProtocolCeiling(dai("5166.01"), TX_AMOUNT_CAP)).toBe("over")
  })

  it("does not guess a credit the route only learns after sending", () => {
    expect(checkProtocolCeiling(undefined, TX_AMOUNT_CAP)).toBe("credit-unknown")
  })

  it("is undecided before the portal's cap is read", () => {
    expect(checkProtocolCeiling(dai("1"), undefined)).toBe("credit-unknown")
  })
})

describe("depositLimits", () => {
  const fee = dai("0.35")

  it("counts the gross send, fee included, against the published limit", () => {
    const at = depositLimits({
      receiveAtomic: dai(LIMIT) - fee,
      feeAtomic: fee,
      decimals: 18,
      valuation: PAR,
      settlementCreditAtomic: dai(LIMIT) - fee,
      txAmountCap: TX_AMOUNT_CAP,
    })
    expect(at).toEqual({
      sendAtomic: dai(LIMIT),
      publicLimit: "within",
      protocolCeiling: "within",
      maxReceiveAtomic: dai(LIMIT) - fee,
    })
    const over = depositLimits({
      receiveAtomic: dai(LIMIT) - fee + dai(CENT),
      feeAtomic: fee,
      decimals: 18,
      valuation: PAR,
      settlementCreditAtomic: dai(LIMIT) - fee + dai(CENT),
      txAmountCap: TX_AMOUNT_CAP,
    })
    expect(over.publicLimit).toBe("over")
    expect(over.protocolCeiling).toBe("within")
  })

  it("checks the net credit against the protocol ceiling separately", () => {
    // A valuation under a dollar lifts the published limit above the ceiling.
    const cheap = price(4n, 10n)
    const at = depositLimits({
      receiveAtomic: TX_AMOUNT_CAP,
      feeAtomic: fee,
      decimals: 18,
      valuation: cheap,
      settlementCreditAtomic: TX_AMOUNT_CAP,
      txAmountCap: TX_AMOUNT_CAP,
    })
    expect(at.publicLimit).toBe("within")
    expect(at.protocolCeiling).toBe("within")
    expect(at.maxReceiveAtomic).toBe(TX_AMOUNT_CAP)
    const over = depositLimits({
      receiveAtomic: dai("5166.01"),
      feeAtomic: fee,
      decimals: 18,
      valuation: cheap,
      settlementCreditAtomic: dai("5166.01"),
      txAmountCap: TX_AMOUNT_CAP,
    })
    expect(over.publicLimit).toBe("within")
    expect(over.protocolCeiling).toBe("over")
  })

  it("leaves the ceiling undecided and the maximum uncapped before the cap is read", () => {
    const cheap = price(95n, 100n)
    const limits = depositLimits({
      receiveAtomic: dai("5166.01"),
      feeAtomic: fee,
      decimals: 18,
      valuation: cheap,
      settlementCreditAtomic: dai("5166.01"),
      txAmountCap: undefined,
    })
    expect(limits.protocolCeiling).toBe("credit-unknown")
    expect(limits.maxReceiveAtomic).toBe(floorToTypeable(publicLimitAtomic(18, cheap)! - fee, 18))
  })

  it("leaves the credit unknown on a swap route and prices the send in the sent token", () => {
    const limits = depositLimits({
      receiveAtomic: usdc(LIMIT) - usdc("0.35"),
      feeAtomic: usdc("0.35"),
      decimals: 6,
      valuation: PAR,
      settlementCreditAtomic: undefined,
      txAmountCap: TX_AMOUNT_CAP,
    })
    expect(limits).toEqual({
      sendAtomic: usdc(LIMIT),
      publicLimit: "within",
      protocolCeiling: "credit-unknown",
      maxReceiveAtomic: usdc(LIMIT) - usdc("0.35"),
    })
  })

  it("has no maximum without a valuation", () => {
    const limits = depositLimits({
      receiveAtomic: dai("10"),
      feeAtomic: fee,
      decimals: 18,
      valuation: undefined,
      settlementCreditAtomic: dai("10"),
      txAmountCap: TX_AMOUNT_CAP,
    })
    expect(limits.publicLimit).toBe("valuation-unavailable")
    expect(limits.protocolCeiling).toBe("within")
    expect(limits.maxReceiveAtomic).toBeUndefined()
  })
})

describe("withdrawal limits", () => {
  const capped = { txAmountCap: TX_AMOUNT_CAP }

  it("a balance twice the limit gives a MAX of the published limit, not the balance", () => {
    expect(
      withdrawalMax({ ...capped, spendableAtomic: dai(LIMIT) * 2n, decimals: 18, valuation: PAR }),
    ).toEqual({
      status: "available",
      atomic: dai(LIMIT),
      bound: "public-limit",
    })
  })

  it("never exceeds the protocol ceiling, whatever the valuation allows", () => {
    expect(
      withdrawalMax({
        ...capped,
        spendableAtomic: dai("10000"),
        decimals: 18,
        valuation: price(4n, 10n),
      }),
    ).toEqual({ status: "available", atomic: TX_AMOUNT_CAP, bound: "protocol-ceiling" })
  })

  it("is bound by the balance and the published limit alone before the cap is read", () => {
    expect(
      withdrawalMax({
        spendableAtomic: dai(LIMIT) * 2n,
        decimals: 18,
        valuation: price(9n, 10n),
        txAmountCap: undefined,
      }),
    ).toEqual({
      status: "available",
      atomic: floorToTypeable((dai(LIMIT) * 10n) / 9n, 18),
      bound: "public-limit",
    })
  })

  it("rounds a smaller balance down to what can be typed", () => {
    expect(
      withdrawalMax({ ...capped, spendableAtomic: dai("1234.5678"), decimals: 18, valuation: PAR }),
    ).toEqual({ status: "available", atomic: dai("1234.56"), bound: "balance" })
  })

  it("has no MAX without a valuation", () => {
    expect(
      withdrawalMax({ ...capped, spendableAtomic: dai("10"), decimals: 18, valuation: undefined }),
    ).toEqual({ status: "valuation-unavailable" })
  })

  it("checks the gross debit against both limits separately", () => {
    const check = (display: string, valuation?: UsdValuation) =>
      withdrawalLimits({ ...capped, debitAtomic: dai(display), decimals: 18, valuation })
    expect(check(LIMIT, PAR)).toEqual({ publicLimit: "within", protocolCeiling: "within" })
    expect(check(`${LIMIT}.01`, PAR)).toEqual({ publicLimit: "over", protocolCeiling: "within" })
    expect(check("5166.01", PAR)).toEqual({ publicLimit: "over", protocolCeiling: "over" })
    expect(check("5166.01", price(4n, 10n))).toEqual({
      publicLimit: "within",
      protocolCeiling: "over",
    })
    expect(check("5")).toEqual({ publicLimit: "valuation-unavailable", protocolCeiling: "within" })
    expect(
      withdrawalLimits({
        debitAtomic: dai("5"),
        decimals: 18,
        valuation: PAR,
        txAmountCap: undefined,
      }),
    ).toEqual({ publicLimit: "within", protocolCeiling: "credit-unknown" })
  })
})

describe("withdrawalMaxNet", () => {
  const max = (spendable: string, fee: string, valuation: UsdValuation | null = PAR) =>
    withdrawalMaxNet({
      spendableAtomic: dai(spendable),
      feeAtomic: dai(fee),
      decimals: 18,
      valuation: valuation ?? undefined,
      txAmountCap: TX_AMOUNT_CAP,
    })

  it("leaves room for a fee burned on top, so the debit is exactly the published limit", () => {
    expect(max(String(2 * PUBLIC_TX_LIMIT_USD), "0.35")).toEqual({
      status: "available",
      atomic: dai(LIMIT) - dai("0.35"),
      bound: "public-limit",
    })
  })

  it("is bound by the balance when the balance is smaller, rounded down to what can be typed", () => {
    expect(max("100.009", "0.35")).toEqual({
      status: "available",
      atomic: dai("99.65"),
      bound: "balance",
    })
    expect(max("100", "0.355")).toMatchObject({ atomic: dai("99.64") })
  })

  it("never exceeds the protocol ceiling, whatever the valuation allows", () => {
    expect(max("10000", "1", price(4n, 10n))).toEqual({
      status: "available",
      atomic: floorToTypeable(TX_AMOUNT_CAP - dai("1"), 18),
      bound: "protocol-ceiling",
    })
  })

  it("is zero when the fee fills the bound, and matches withdrawalMax with no fee", () => {
    expect(max("0.3", "0.35")).toMatchObject({ atomic: 0n, bound: "balance" })
    expect(max("-5", "0.35")).toMatchObject({ atomic: 0n, bound: "balance" })
    expect(max("1234.5678", "0")).toEqual(
      withdrawalMax({
        spendableAtomic: dai("1234.5678"),
        decimals: 18,
        valuation: PAR,
        txAmountCap: TX_AMOUNT_CAP,
      }),
    )
  })

  it("has no MAX without a valuation", () => {
    expect(max("10", "1", null)).toEqual({ status: "valuation-unavailable" })
  })
})
