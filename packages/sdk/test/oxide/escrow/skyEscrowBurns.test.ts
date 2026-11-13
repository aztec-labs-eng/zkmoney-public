import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { getAddress, type Address, type Hex } from "viem"
import { SkyRoute, predictSkyEscrowAddressLocally } from "@oxide/experiments/sky/sky_savings.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import {
  acrossBridgeEscrowArgs,
  predictAcrossBridgeEscrowAddressLocally,
} from "../../../src/oxide/escrow/acrossBridgeOnWithdraw.js"
import { recoverSkyEscrowBurns } from "../../../src/oxide/escrow/skyEscrowBurns.js"
import { planSwapOnWithdraw } from "../../../src/oxide/escrow/swapOnWithdraw.js"
import {
  memoForEscrow,
  type ScannedWithdrawEvent,
} from "../../../src/services/withdrawal/withdrawEventSource.js"
import {
  decodeWithdrawalMemo,
  encodeWithdrawalMemo,
  type BridgeWithdrawalMemo,
  type SkyWithdrawalMemo,
  type SwapWithdrawalMemo,
} from "../../../src/services/withdrawal/withdrawalMemo.js"

const FACTORY = "0x00000000000000000000000000000000000fac70" as Address
const OTHER_FACTORY = getAddress("0x00000000000000000000000000000000000fac71")

const sky = (factory: Address): SkyWithdrawalMemo => ({
  route: SkyRoute.Unstake,
  factory: getAddress(factory),
  recipientCommitment: `0x${"ab".repeat(32)}` as Hex,
  recoveryCommitment: `0x${"cd".repeat(32)}` as Hex,
  relayerTip: 7n,
  nonce: `0x${"ef".repeat(32)}` as Hex,
})

// The source keeps a memo only when its args derive `l1Recipient`, so the escrows are stubbed here.
const burn = (n: number, memo?: SkyWithdrawalMemo): ScannedWithdrawEvent => ({
  txHash: `0x${n.toString(16).padStart(64, "0")}`,
  blockNumber: n,
  withdrawalId: `0x${n.toString(16).padStart(64, "1")}`,
  executor: getAddress(`0x${"e0".repeat(20)}`),
  withdrawalFee: 0n,
  l1Recipient: getAddress(`0x${n.toString(16).padStart(40, "0")}`),
  amount: 500n,
  proverTip: 0n,
  relayerTip: 3n,
  ...(memo ? { sky: memo } : {}),
})

describe("recoverSkyEscrowBurns", () => {
  it("keeps the burns into an escrow of a factory asked, and no plain burn or other factory's", async () => {
    const ours = burn(7, sky(FACTORY))
    const asked: [number, number][] = []
    const source = {
      scanWithdrawals: async (fromBlock: number, toBlockExclusive: number) => {
        asked.push([fromBlock, toBlockExclusive])
        return { withdrawals: [ours, burn(8), burn(9, sky(OTHER_FACTORY))], unread: [] }
      },
    }
    const args = { factories: [FACTORY], fromBlock: 7, toBlockExclusive: 12 }
    expect(await recoverSkyEscrowBurns(source, args)).toEqual({ burns: [ours], unread: false })
    // The source reads the account's L2 blocks in exactly the range asked.
    expect(asked).toEqual([[7, 12]])
  })

  it("keeps a Sky burn whose memo carries an entry of an unknown type, and no swap's or bridge-out's burn", async () => {
    // The burn as the source reads it: its memo's bytes, kept when they derive its recipient.
    const scanned = (n: number, l1Recipient: Address, memo: Buffer): ScannedWithdrawEvent => ({
      ...burn(n),
      l1Recipient,
      ...memoForEscrow(decodeWithdrawalMemo(memo), l1Recipient),
    })
    const recovery = { account: getAddress(`0x${"5a".repeat(20)}`), salt: new Fr(9n) }
    const { factory, recoveryCommitment: _, ...escrow } = sky(FACTORY)
    const recoveryCommitment = deriveRecoveryCommitment(
      recovery.salt,
      EthAddress.fromString(recovery.account),
    ).toString()
    const recipient = getAddress(`0x${"b0".repeat(20)}`)
    const swap: SwapWithdrawalMemo = {
      output: "USDC",
      recipient,
      factory,
      recoveryCommitment,
      relayerTip: escrow.relayerTip,
      nonce: escrow.nonce,
      daiForGas: 0n,
      minEthForGas: 0n,
    }
    const swapEscrow = planSwapOnWithdraw({
      swapEscrowFactoryV2: factory,
      output: swap.output,
      l1Recipient: recipient,
      recovery,
      amount: 100n * 10n ** 18n,
      withdrawalFee: 0n,
      withdrawalRelayerTip: 0n,
      proverTip: 0n,
      relayerTip: swap.relayerTip,
      nonce: swap.nonce,
    }).escrow
    const bridge: BridgeWithdrawalMemo = {
      provider: "across",
      chainId: 8453,
      token: "USDT",
      recipient,
      factory,
      fee: 250_000n,
      minReceived: 98_000_000n,
      recoveryCommitment,
      relayerTip: escrow.relayerTip,
      nonce: escrow.nonce,
    }
    const bridgeEscrow = predictAcrossBridgeEscrowAddressLocally(
      factory,
      acrossBridgeEscrowArgs(bridge.token, bridge.chainId, { ...bridge, acrossFee: bridge.fee })!,
    )
    const memo = sky(FACTORY)
    const unknown = Buffer.from([0xf0, 2, 1, 2])
    const ours = scanned(
      7,
      predictSkyEscrowAddressLocally(FACTORY, memo),
      Buffer.concat([encodeWithdrawalMemo({ sky: memo }), unknown]),
    )
    const others = [
      scanned(8, swapEscrow, encodeWithdrawalMemo({ swap })),
      scanned(9, bridgeEscrow, encodeWithdrawalMemo({ bridge })),
    ]
    // Each is a burn into an escrow of a factory at the address asked for.
    expect(others.map((b) => (b.swap ?? b.bridge)?.factory)).toEqual([factory, factory])

    const source = {
      scanWithdrawals: async () => ({ withdrawals: [ours, ...others], unread: [] }),
    }
    const range = { factories: [FACTORY], fromBlock: 7, toBlockExclusive: 12 }
    expect(await recoverSkyEscrowBurns(source, range)).toEqual({
      burns: [{ ...ours, sky: memo }],
      unread: false,
    })
  })

  it("reads every factory's burns in one scan, and says when one was not indexed", async () => {
    const first = burn(7, sky(FACTORY))
    const second = burn(9, sky(OTHER_FACTORY))
    const source = {
      scanWithdrawals: async () => ({ withdrawals: [first, second], unread: ["0x01"] }),
    }
    const args = { factories: [FACTORY, OTHER_FACTORY], fromBlock: 1, toBlockExclusive: 12 }
    expect(await recoverSkyEscrowBurns(source, args)).toEqual({
      burns: [first, second],
      unread: true,
    })
  })
})
