import { afterEach, describe, expect, it, vi } from "vitest"
import { zeroAddress } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { acrossBridgeRoute, quoteAcrossBridgeOnWithdraw } from "@obsidion/sdk"

import { belowFloorCost, bridgeFloor } from "../../../src/features/withdraw/bridgeOutQuote"

/**
 * Drift test: `belowFloorCost` parses oxide-client's refusal text, so each case raises the refusal
 * through the vendored code, never a copy of its message.
 */
describe("belowFloorCost", () => {
  const route = acrossBridgeRoute("USDT", 8453)!
  const E18 = 10n ** 18n
  const fees = (over: { minDeposit?: string; gasFee?: string } = {}) =>
    new Response(
      JSON.stringify({
        totalRelayFee: { pct: "0" },
        relayerGasFee: { pct: "0", total: over.gasFee ?? "0" },
        limits: { minDeposit: over.minDeposit ?? "0", maxDeposit: (10n ** 15n).toString() },
        outputToken: { decimals: route.acrossOutputTokenDecimals },
      }),
    )
  const refusal = (amount: bigint, response: Response, withdrawalRelayerTip = 0n) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    )
    return quoteAcrossBridgeOnWithdraw({} as never, {} as never, {
      route,
      amount,
      withdrawalFee: 0n,
      withdrawalRelayerTip,
      proverTip: 0n,
      escrowFunding: amount - withdrawalRelayerTip,
      sender: zeroAddress,
      acrossApiUrl: "https://across.test",
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
  }
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reads the escrow relayer tip oxide-client names, in DAI", async () => {
    // The withdrawal's own relayer tip takes it all: no escrow funding is left.
    expect(belowFloorCost(await refusal(10n, fees(), 10n))).toBe(0n)
  })

  it("scales Across's minimum and fee from its 6-decimal input to DAI", async () => {
    expect(belowFloorCost(await refusal(E18, fees({ minDeposit: "5000000" })))).toBe(
      5_000_000n * 10n ** 12n,
    )
    expect(belowFloorCost(await refusal(E18, fees({ gasFee: "1000000" })))).toBe(
      2_000_000n * 10n ** 12n,
    )
    const tooLow = new Response(
      JSON.stringify({ message: "Bridge amount 1000 is too low to cover bridge fees 39556" }),
      { status: 400 },
    )
    expect(belowFloorCost(await refusal(E18, tooLow))).toBe(39_556n * 10n ** 12n)
  })

  it("leaves any other failure alone", () => {
    expect(belowFloorCost(new Error("Across has no route there"))).toBeUndefined()
  })
})

describe("bridgeFloor", () => {
  it("adds the withdrawal's fee, relayer tip and prover tip to the bridge's cost", () => {
    expect(bridgeFloor({ withdrawalFee: 10n, proverTip: 5n }, 100n)).toBe(
      115n + WITHDRAW_RELAYER_TIP,
    )
  })
})
