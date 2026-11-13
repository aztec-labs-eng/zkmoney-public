import { describe, expect, it } from "vitest"
import { bridgeInReturned } from "../../../src/core/services/crossChain/bridgeInAmounts"

describe("what a bridge-in that ended short names", () => {
  const origin = { symbol: "DAI", inputAmount: "5000000000000000000", inputDecimals: 18 }
  const bridged = { symbol: "USDC", amount: "4990000", decimals: 6 }
  const dai = { symbol: "DAI", amount: 5n * 10n ** 18n, decimals: 18, other: false }

  it.each([
    ["refunded", bridged, { symbol: "USDC", amount: 4_990_000n, decimals: 6, other: true }],
    ["expired", bridged, { symbol: "USDC", amount: 4_990_000n, decimals: 6, other: true }],
    // Nothing left the wallet: the origin coin stayed.
    ["failed", bridged, dai],
    ["signing", bridged, dai],
    ["refunded", undefined, dai],
  ] as const)("%s, bridged %o", (status, carried, expected) => {
    expect(bridgeInReturned({ ...origin, status, bridged: carried })).toEqual(expected)
  })
})
