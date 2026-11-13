/** A bridge-out's escrow and record agree with the quote the user reviewed. */
import { describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { BridgeOutBroadcaster } from "@obsidion/sdk"
import { getAddress } from "viem"
import { bridgeLeg } from "../../../src/features/withdraw/bridgeOut"
import type { BridgeOutPriced } from "../../../src/features/withdraw/bridgeOutQuote"
import { DEMO_OXIDE_TUPLE } from "../../../src/dev/demoFixtures"

const address = (byte: string) => getAddress(`0x${byte.repeat(20)}`)
/** Builds every broadcast call as an empty interaction. */
const broadcaster = { methods: new Proxy({}, { get: () => () => ({}) }) } as BridgeOutBroadcaster
const tuple = {
  ...DEMO_OXIDE_TUPLE,
  l2Broadcaster: AztecAddress.fromBigIntUnsafe(11n).toString(),
}

const quote: BridgeOutPriced = {
  acrossFee: 500_000n,
  minReceived: 97_000_000n,
  tip: { relayerTip: 2n * 10n ** 18n } as BridgeOutPriced["tip"],
  withdrawalFee: 3n * 10n ** 17n,
  proverTip: 0n,
}

describe("bridgeLeg", () => {
  it("builds the escrow and the record on the fee the quote was priced on", () => {
    const leg = bridgeLeg(tuple, {
      chain: { chainId: 8453, name: "Base" } as never,
      token: "USDC",
      quote,
      from: AztecAddress.fromBigIntUnsafe(20n),
      amount: 100n * 10n ** 18n,
      recipient: address("b0"),
      recoverer: { account: address("5a"), secret: "0x09" },
      broadcaster,
      factory: address("fa"),
      executor: address("e0"),
    })
    expect(leg.escrow.withdrawalFee).toBe(quote.withdrawalFee)
    expect(leg.record.withdrawalFee).toBe(quote.withdrawalFee.toString())
    expect(leg.record.bridgeOut?.minReceived).toBe(quote.minReceived.toString())
  })
})
