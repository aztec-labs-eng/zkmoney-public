import { describe, expect, it } from "vitest"
import { predictSkyEscrowAddressLocally, SkyRoute } from "@oxide/experiments/sky/sky_savings.js"
import {
  acrossBridgeEscrowArgs,
  predictAcrossBridgeEscrowAddressLocally,
  predictSwapEscrow,
} from "@obsidion/sdk"
import { decodeFunctionData, multicall3Abi, type Address, type Hex } from "viem"
import { AcrossBridgeEscrowFactoryAbi } from "@oxide/l1-contracts/across_bridge_on_withdraw.js"
import {
  escrowHeldToken,
  escrowLeg,
  escrowRecoverCall,
} from "../../../src/core/services/bridge/escrowLeg"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"

const FACTORY = `0x${"fa".repeat(20)}` as Address
const RECIPIENT = `0x${"b0".repeat(20)}` as Address
const NONCE = `0x${"77".repeat(32)}` as Hex
const COMMITMENT = `0x${"5a".repeat(32)}` as Hex
const DAI = `0x${"da".repeat(20)}` as Address

const record = (fields: Partial<WithdrawalRecord>): WithdrawalRecord => ({
  localId: "w1",
  recipient: RECIPIENT,
  recipientProvenance: "saved-recipient",
  amount: "100",
  tokenSymbol: "DAI",
  tokenDecimals: 18,
  phase: "recoverable",
  startTime: 0,
  ...fields,
})

const LEGACY_ARGS = {
  route: 2,
  recipient: RECIPIENT,
  recoveryCommitment: COMMITMENT,
  relayerTip: 5n * 10n ** 18n,
  nonce: NONCE,
}
const SWAP = record({
  swapOutput: "ETH",
  swapEscrow: predictSwapEscrow(FACTORY, { layout: "legacy", args: LEGACY_ARGS }),
  swapEscrowFactory: FACTORY,
  swapNonce: NONCE,
  swapRecoveryCommitment: COMMITMENT,
  swapRelayerTip: "5000000000000000000",
})
const V2_ARGS = { ...LEGACY_ARGS, route: 0, daiForGas: 5n * 10n ** 18n, minEthForGas: 7n }
const SWAP_V2 = record({
  ...SWAP,
  swapOutput: "USDC",
  swapEscrowLayout: "v2",
  swapDaiForGas: "5000000000000000000",
  swapMinEthForGas: "7",
  swapEscrow: predictSwapEscrow(FACTORY, { layout: "v2", args: V2_ARGS }),
})

const BRIDGE_OUT = {
  provider: "across" as const,
  chainId: 8453,
  chainName: "Base",
  minReceived: "98000000",
  acrossFee: "250000",
  nonce: NONCE,
  recoveryCommitment: COMMITMENT,
  relayerTip: "2000000000000000000",
}
const ACROSS_ARGS = acrossBridgeEscrowArgs("USDC", 8453, {
  recipient: RECIPIENT,
  acrossFee: 250_000n,
  recoveryCommitment: COMMITMENT,
  relayerTip: 2n * 10n ** 18n,
  nonce: NONCE,
})!
const BRIDGE = record({
  swapOutput: "USDC",
  swapOutputDecimals: 6,
  swapEscrow: predictAcrossBridgeEscrowAddressLocally(FACTORY, ACROSS_ARGS),
  swapEscrowFactory: FACTORY,
  bridgeOut: BRIDGE_OUT,
})

const SKY_ARGS = {
  route: SkyRoute.Unstake,
  recipientCommitment: `0x${"2c".repeat(32)}` as Hex,
  recoveryCommitment: COMMITMENT,
  relayerTip: 3n,
  nonce: NONCE,
}
const SKY = record({
  phase: "done",
  recipient: predictSkyEscrowAddressLocally(FACTORY, SKY_ARGS),
  skyMove: {
    direction: "out",
    factory: FACTORY,
    recipientCommitment: SKY_ARGS.recipientCommitment,
    recoveryCommitment: COMMITMENT,
    relayerTip: "3",
    nonce: NONCE,
  },
})

describe("escrowLeg", () => {
  it.each([
    ["a legacy swap", SWAP, { kind: "swap", args: { layout: "legacy", args: LEGACY_ARGS } }],
    [
      "a v2 swap with its gas swap",
      SWAP_V2,
      { kind: "swap", args: { layout: "v2", args: V2_ARGS } },
    ],
    [
      "an Across bridge-out",
      record({ ...BRIDGE, bridgeOut: BRIDGE_OUT }),
      {
        kind: "bridge",
        provider: "across",
        args: ACROSS_ARGS,
        destination: {
          chainId: 8453,
          token: "USDC",
          recipient: RECIPIENT,
          minReceived: 98_000_000n,
        },
      },
    ],
    ["a Sky move", SKY, { kind: "sky", escrow: SKY.recipient, args: SKY_ARGS }],
  ])("rebuilds %s from its record", (_, withdrawal, leg) => {
    expect(escrowLeg(withdrawal)).toMatchObject({
      factory: FACTORY,
      nonce: NONCE,
      recoveryCommitment: COMMITMENT,
      ...leg,
    })
  })

  it.each([
    ["a direct withdrawal", record({})],
    ["a swap missing its nonce", record({ ...SWAP, swapNonce: undefined })],
    ["a swap missing its tip", record({ ...SWAP, swapRelayerTip: undefined })],
    ["a swap whose layout derives another escrow", record({ ...SWAP, swapEscrowLayout: "v2" })],
    [
      "a bridge-out whose fee derives another escrow",
      record({ ...BRIDGE, bridgeOut: { ...BRIDGE_OUT, acrossFee: "1" } }),
    ],
    [
      "a bridge-out to a chain Across has no route to",
      record({ ...BRIDGE, bridgeOut: { ...BRIDGE_OUT, chainId: 1 } }),
    ],
    ["a Sky move paid to another escrow", record({ ...SKY, recipient: RECIPIENT })],
  ])("is undefined for %s", (_, withdrawal) => {
    expect(escrowLeg(withdrawal)).toBeUndefined()
  })
})

describe("escrowRecoverCall", () => {
  const recover = {
    deployed: false,
    recovery: { account: `0x${"5a".repeat(20)}` as Address, salt: { toString: () => COMMITMENT } },
    signature: "0x1234" as Hex,
    target: RECIPIENT,
    nonce: NONCE,
    deadline: 99n,
  } as Parameters<typeof escrowRecoverCall>[1]

  it("deploys a bridge escrow that never ran with its own factory's deploy, then recovers", () => {
    const leg = escrowLeg(BRIDGE)!
    const call = escrowRecoverCall(leg, { ...recover, token: DAI })
    const [calls] = decodeFunctionData({ abi: multicall3Abi, data: call.data }).args as readonly [
      readonly { target: Address; callData: Hex }[],
    ]
    const deploy = decodeFunctionData({
      abi: AcrossBridgeEscrowFactoryAbi,
      data: calls[0]!.callData,
    })
    expect(deploy.functionName).toBe("deploy")
    // The deploy call clones exactly the escrow the recovery then calls.
    expect(predictAcrossBridgeEscrowAddressLocally(calls[0]!.target, deploy.args[0])).toBe(
      leg.escrow,
    )
    expect(calls[1]!.target).toBe(leg.escrow)
  })

  it("recovers a bridge-out's refund in the bridge's input token once its escrow ran", () => {
    const leg = escrowLeg(BRIDGE)!
    expect(escrowHeldToken(leg, BRIDGE, DAI)).toBe(DAI)
    expect(escrowHeldToken(leg, { ...BRIDGE, swapExecuteTxHash: NONCE }, DAI)).toBe(
      ACROSS_ARGS.acrossInputToken,
    )
    expect(escrowHeldToken(escrowLeg(SWAP)!, { ...SWAP, swapExecuteTxHash: NONCE }, DAI)).toBe(DAI)
  })
})
