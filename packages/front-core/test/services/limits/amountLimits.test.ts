import { describe, expect, it } from "vitest"
import { parseUnits } from "viem"
import { PUBLIC_TX_LIMIT_USD } from "@obsidion/core/constants"
import { TX_AMOUNT_CAP } from "@obsidion/sdk"
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

describe("published USD limit", () => {
  it("is 2,500 US dollars", () => {
    expect(PUBLIC_TX_LIMIT_USD).toBe(2_500)
  })

  it("admits exactly $2,500 and refuses one typeable unit or one atomic unit above", () => {
    expect(checkPublicLimit(dai("2500"), 18, PAR)).toBe("within")
    expect(checkPublicLimit(dai("2500.01"), 18, PAR)).toBe("over")
    expect(checkPublicLimit(dai("2500") + 1n, 18, PAR)).toBe("over")
    expect(checkPublicLimit(usdc("2500"), 6, PAR)).toBe("within")
    expect(checkPublicLimit(usdc("2500.01"), 6, PAR)).toBe("over")
    expect(checkPublicLimit(usdc("2500") + 1n, 6, PAR)).toBe("over")
  })

  it("converts through the valuation, never by assuming one token is one dollar", () => {
    const below = price(9998n, 10_000n)
    expect(publicLimitAtomic(18, below)).toBe(dai("2500.5"))
    expect(checkPublicLimit(dai("2500.5"), 18, below)).toBe("within")
    expect(checkPublicLimit(dai("2500.51"), 18, below)).toBe("over")
    const above = price(10_002n, 10_000n)
    expect(checkPublicLimit(dai("2500"), 18, above)).toBe("over")
    expect(publicLimitAtomic(6, above)).toBe(usdc("2499.5"))
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
  const MAINNET_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7"
  const TEST_TOKEN = "0x5FbDB2315678afecb367f032d93F642f64180aa3"

  it("values the three mainnet deposit tokens at the stated $1 rate, matched by address", () => {
    for (const token of [MAINNET_DAI, MAINNET_USDC.toLowerCase(), MAINNET_USDT]) {
      expect(depositTokenValuation({ chainId: 1, portalToken: MAINNET_DAI, token })).toBe(
        NOMINAL_USD_VALUATION,
      )
    }
    expect(NOMINAL_USD_VALUATION.source).toBe("nominal-1-usd-per-token")
  })

  it("does not value an unlisted token, whatever it calls itself", () => {
    expect(
      depositTokenValuation({ chainId: 1, portalToken: MAINNET_DAI, token: TEST_TOKEN }),
    ).toBeUndefined()
    expect(
      depositTokenValuation({ chainId: 1, portalToken: MAINNET_DAI, token: "USDC" }),
    ).toBeUndefined()
  })

  it("off mainnet values only the portal's own token", () => {
    const sepolia = { chainId: 11155111, portalToken: TEST_TOKEN }
    expect(depositTokenValuation({ ...sepolia, token: TEST_TOKEN })).toBe(NOMINAL_USD_VALUATION)
    expect(depositTokenValuation({ ...sepolia, token: MAINNET_USDC })).toBeUndefined()
  })
})

describe("protocol ceiling", () => {
  it("admits TX_AMOUNT_CAP and refuses one atomic unit or one typeable unit above", () => {
    expect(TX_AMOUNT_CAP).toBe(dai("2583"))
    expect(checkProtocolCeiling(TX_AMOUNT_CAP)).toBe("within")
    expect(checkProtocolCeiling(TX_AMOUNT_CAP + 1n)).toBe("over")
    expect(checkProtocolCeiling(dai("2583.01"))).toBe("over")
  })

  it("does not guess a credit the route only learns after sending", () => {
    expect(checkProtocolCeiling(undefined)).toBe("credit-unknown")
  })
})

describe("depositLimits", () => {
  const fee = dai("0.35")

  it("counts the gross send, fee included, against the published limit", () => {
    const at = depositLimits({
      receiveAtomic: dai("2499.65"),
      feeAtomic: fee,
      decimals: 18,
      valuation: PAR,
      settlementCreditAtomic: dai("2499.65"),
    })
    expect(at).toEqual({
      sendAtomic: dai("2500"),
      publicLimit: "within",
      protocolCeiling: "within",
      maxReceiveAtomic: dai("2499.65"),
    })
    const over = depositLimits({
      receiveAtomic: dai("2499.66"),
      feeAtomic: fee,
      decimals: 18,
      valuation: PAR,
      settlementCreditAtomic: dai("2499.66"),
    })
    expect(over.publicLimit).toBe("over")
    expect(over.protocolCeiling).toBe("within")
  })

  it("checks the net credit against the protocol ceiling separately", () => {
    // A valuation under a dollar lifts the published limit above the ceiling.
    const cheap = price(95n, 100n)
    const at = depositLimits({
      receiveAtomic: TX_AMOUNT_CAP,
      feeAtomic: fee,
      decimals: 18,
      valuation: cheap,
      settlementCreditAtomic: TX_AMOUNT_CAP,
    })
    expect(at.publicLimit).toBe("within")
    expect(at.protocolCeiling).toBe("within")
    expect(at.maxReceiveAtomic).toBe(TX_AMOUNT_CAP)
    const over = depositLimits({
      receiveAtomic: dai("2583.01"),
      feeAtomic: fee,
      decimals: 18,
      valuation: cheap,
      settlementCreditAtomic: dai("2583.01"),
    })
    expect(over.publicLimit).toBe("within")
    expect(over.protocolCeiling).toBe("over")
  })

  it("leaves the credit unknown on a swap route and prices the send in the sent token", () => {
    const limits = depositLimits({
      receiveAtomic: usdc("2499.65"),
      feeAtomic: usdc("0.35"),
      decimals: 6,
      valuation: PAR,
      settlementCreditAtomic: undefined,
    })
    expect(limits).toEqual({
      sendAtomic: usdc("2500"),
      publicLimit: "within",
      protocolCeiling: "credit-unknown",
      maxReceiveAtomic: usdc("2499.65"),
    })
  })

  it("has no maximum without a valuation", () => {
    const limits = depositLimits({
      receiveAtomic: dai("10"),
      feeAtomic: fee,
      decimals: 18,
      valuation: undefined,
      settlementCreditAtomic: dai("10"),
    })
    expect(limits.publicLimit).toBe("valuation-unavailable")
    expect(limits.protocolCeiling).toBe("within")
    expect(limits.maxReceiveAtomic).toBeUndefined()
  })
})

describe("withdrawal limits", () => {
  it("a 5,000 balance gives a MAX of the published limit, not the balance", () => {
    expect(withdrawalMax({ spendableAtomic: dai("5000"), decimals: 18, valuation: PAR })).toEqual({
      status: "available",
      atomic: dai("2500"),
      bound: "public-limit",
    })
  })

  it("never exceeds the protocol ceiling, whatever the valuation allows", () => {
    expect(
      withdrawalMax({ spendableAtomic: dai("5000"), decimals: 18, valuation: price(9n, 10n) }),
    ).toEqual({ status: "available", atomic: TX_AMOUNT_CAP, bound: "protocol-ceiling" })
  })

  it("rounds a smaller balance down to what can be typed", () => {
    expect(
      withdrawalMax({ spendableAtomic: dai("1234.5678"), decimals: 18, valuation: PAR }),
    ).toEqual({ status: "available", atomic: dai("1234.56"), bound: "balance" })
  })

  it("has no MAX without a valuation", () => {
    expect(
      withdrawalMax({ spendableAtomic: dai("10"), decimals: 18, valuation: undefined }),
    ).toEqual({ status: "valuation-unavailable" })
  })

  it("checks the gross debit against both limits separately", () => {
    const check = (display: string, valuation?: UsdValuation) =>
      withdrawalLimits({ debitAtomic: dai(display), decimals: 18, valuation })
    expect(check("2500", PAR)).toEqual({ publicLimit: "within", protocolCeiling: "within" })
    expect(check("2500.01", PAR)).toEqual({ publicLimit: "over", protocolCeiling: "within" })
    expect(check("2583.01", PAR)).toEqual({ publicLimit: "over", protocolCeiling: "over" })
    expect(check("2583.01", price(9n, 10n))).toEqual({
      publicLimit: "within",
      protocolCeiling: "over",
    })
    expect(check("5")).toEqual({ publicLimit: "valuation-unavailable", protocolCeiling: "within" })
  })
})

describe("withdrawalMaxNet", () => {
  const max = (spendable: string, fee: string, valuation: UsdValuation | null = PAR) =>
    withdrawalMaxNet({
      spendableAtomic: dai(spendable),
      feeAtomic: dai(fee),
      decimals: 18,
      valuation: valuation ?? undefined,
    })

  it("leaves room for a fee burned on top, so the debit is exactly the published limit", () => {
    expect(max("10000", "0.35")).toEqual({
      status: "available",
      atomic: dai("2499.65"),
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
    expect(max("10000", "1", price(9n, 10n))).toEqual({
      status: "available",
      atomic: floorToTypeable(TX_AMOUNT_CAP - dai("1"), 18),
      bound: "protocol-ceiling",
    })
  })

  it("is zero when the fee fills the bound, and matches withdrawalMax with no fee", () => {
    expect(max("0.3", "0.35")).toMatchObject({ atomic: 0n, bound: "balance" })
    expect(max("-5", "0.35")).toMatchObject({ atomic: 0n, bound: "balance" })
    expect(max("1234.5678", "0")).toEqual(
      withdrawalMax({ spendableAtomic: dai("1234.5678"), decimals: 18, valuation: PAR }),
    )
  })

  it("has no MAX without a valuation", () => {
    expect(max("10", "1", null)).toEqual({ status: "valuation-unavailable" })
  })
})
