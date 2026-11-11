/**
 * A bridge-out's memo is what a rescan rebuilds the escrow from, so the args the wallet derives from
 * it must be the ones oxide's builder committed the escrow to.
 */
import { describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { getAddress, type Hex } from "viem"
import {
  buildAcrossBridgeOut,
  type BridgeOutBroadcaster,
} from "../../../src/oxide/escrow/acrossBridgeOnWithdraw.js"
import {
  decodeWithdrawalMemo,
  encodeWithdrawalMemo,
  memoDerivesEscrow,
} from "../../../src/services/withdrawal/withdrawalMemo.js"

const address = (byte: string) => getAddress(`0x${byte.repeat(20)}`)
/** Builds every broadcast call as an empty interaction. */
const broadcaster = { methods: new Proxy({}, { get: () => () => ({}) }) } as BridgeOutBroadcaster

const build = (token: "USDC" | "USDT", chainId: number) =>
  buildAcrossBridgeOut({
    broadcaster,
    l2Broadcaster: AztecAddress.fromBigIntUnsafe(11n).toString(),
    factory: address("fa"),
    dai: address("da"),
    portal: address("0c"),
    executor: { address: address("e0"), fee: 10n ** 17n },
    from: AztecAddress.fromBigIntUnsafe(20n),
    amount: 100n * 10n ** 18n,
    withdrawalRelayerTip: 10n ** 17n,
    proverTip: 0n,
    token,
    chainId,
    recipient: address("b0"),
    acrossFee: 500_000n,
    minReceived: 97_000_000n,
    relayerTip: 2n * 10n ** 18n,
    recovery: { account: address("5a"), salt: new Fr(9n) },
    nonce: `0x${"77".repeat(32)}` as Hex,
  })

describe("buildAcrossBridgeOut", () => {
  it.each([
    ["USDC", 8453],
    ["USDT", 56],
  ] as const)("names in its memo the %s escrow on chain %i that oxide builds", (token, chainId) => {
    const built = build(token, chainId)
    const { memo } = built.escrowOptions
    expect(memoDerivesEscrow(memo, built.escrow)).toBe(true)
    expect(decodeWithdrawalMemo(encodeWithdrawalMemo(memo))).toEqual(memo)
  })
})
