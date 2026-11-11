import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { PlainWithdrawalSubsidyAbi } from "@oxide/l1-contracts"
import {
  AcrossBridgeEscrowFactoryAbi,
  encodeAcrossBridgeEscrowDeploy,
  predictAcrossBridgeEscrowAddressLocally,
  type AcrossBridgeEscrowArgs,
} from "@oxide/l1-contracts/across_bridge_on_withdraw.js"
import { fetchAcrossFees } from "@oxide/oxide-client/withdraw_escrows/across_api.js"
import {
  ACROSS_EVM_DESTINATIONS,
  acrossEvmDestination,
  buildAcrossBridgeOnWithdraw,
  quoteAcrossBridge,
  type AcrossBridgeRoute,
} from "@oxide/oxide-client/withdraw_escrows/across_bridge.js"
import {
  encodeFunctionData,
  keccak256,
  numberToHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import type { WithdrawalOptions } from "../../services/withdrawal/plainWithdrawal.js"
import { quoteL1OperationTip, type RelayerTipEstimate } from "../tip/l1OperationQuote.js"
import type { SwapRecovery } from "./swapOnWithdraw.js"
import { findBalanceOfSlot, mappingSlot } from "./swapOnWithdrawSimulator.js"
import { PAR_TIP_TOKEN } from "../tip/tipQuote.js"

export {
  encodeAcrossBridgeEscrowDeploy,
  predictAcrossBridgeEscrowAddressLocally,
  type AcrossBridgeEscrowArgs,
} from "@oxide/l1-contracts/across_bridge_on_withdraw.js"
export type { AcrossBridgeRoute } from "@oxide/oxide-client/withdraw_escrows/across_bridge.js"
export { fetchAcrossDepositStatus } from "@oxide/oxide-client/withdraw_escrows/across_api.js"

/** What Across can land on another chain from a withdrawal: the escrow swaps DAI into one of these. */
export type BridgeOutToken = keyof typeof ACROSS_EVM_DESTINATIONS

/** Oxide's Across route for `token` to `chainId`; undefined where Across has none. */
export function acrossBridgeRoute(
  token: BridgeOutToken,
  chainId: number,
): AcrossBridgeRoute | undefined {
  const table = ACROSS_EVM_DESTINATIONS[token] as Record<string, { chainId: bigint }>
  const chain = Object.keys(table).find((key) => table[key]!.chainId === BigInt(chainId))
  return chain ? acrossEvmDestination(token, chain as never) : undefined
}

/** The L2 Broadcaster bindings oxide's builder takes; `registerBroadcaster` gives one for an address. */
export type BridgeOutBroadcaster = Parameters<typeof buildAcrossBridgeOnWithdraw>[0]["broadcaster"]

/** What an Across escrow commits to beyond its route. */
export interface AcrossEscrowValues {
  recipient: Address
  /** Across input-token units the escrow keeps back for Across. */
  acrossFee: bigint
  recoveryCommitment: Hex
  relayerTip: bigint
  nonce: Hex
}

/** The args of an Across escrow to `token` on `chainId`; undefined where Across has no route. */
export function acrossBridgeEscrowArgs(
  token: BridgeOutToken,
  chainId: number,
  values: AcrossEscrowValues,
): AcrossBridgeEscrowArgs | undefined {
  const route = acrossBridgeRoute(token, chainId)
  return route && routeEscrowArgs(route, values)
}

function routeEscrowArgs(
  route: AcrossBridgeRoute,
  values: AcrossEscrowValues,
): AcrossBridgeEscrowArgs {
  return {
    acrossInputToken: route.acrossInputToken.toString(),
    destinationChainId: route.destinationChainId,
    recipient: values.recipient,
    acrossOutputToken: route.acrossOutputToken.toString(),
    acrossOutputTokenDecimals: route.acrossOutputTokenDecimals,
    acrossFee: values.acrossFee,
    recoveryCommitment: values.recoveryCommitment,
    relayerTip: values.relayerTip,
    nonce: values.nonce,
  }
}

/** `factory.deploy(args)`: the clone without the run. */
export function encodeAcrossBridgeEscrowDeployOnly(args: AcrossBridgeEscrowArgs): Hex {
  return encodeFunctionData({
    abi: AcrossBridgeEscrowFactoryAbi,
    functionName: "deploy",
    args: [args],
  })
}

export interface BridgeOutBuild {
  escrow: Address
  escrowArgs: AcrossBridgeEscrowArgs
  /** What the burn's options carry, so the burn tx broadcasts the escrow's run. */
  escrowOptions: NonNullable<WithdrawalOptions["escrow"]>
}

/**
 * The burn into a counterfactual `AcrossBridgeEscrow`, which swaps the DAI on Curve and deposits it
 * to Across for `recipient` on `chainId`. The recovery salt is the caller's, so a restored wallet
 * can recover an escrow Across refunded.
 */
export function buildAcrossBridgeOut(args: {
  broadcaster: BridgeOutBroadcaster
  /** The deployment whose relayer runs the escrow. */
  l2Broadcaster: string
  factory: Address
  dai: Address
  portal: Address
  executor: { address: Address; fee: bigint }
  from: AztecAddress
  amount: bigint
  withdrawalRelayerTip: bigint
  proverTip: bigint
  token: BridgeOutToken
  chainId: number
  recipient: Address
  acrossFee: bigint
  /** Output-token units the recipient receives at the swap floor. */
  minReceived: bigint
  relayerTip: bigint
  recovery: SwapRecovery
  nonce: Hex
}): BridgeOutBuild {
  // No key signs for the zero address, so the escrow could never be recovered.
  if (BigInt(args.recovery.account) === 0n) {
    throw new Error("buildAcrossBridgeOut: the recovery account must be nonzero")
  }
  const route = acrossBridgeRoute(args.token, args.chainId)
  if (!route) throw new Error(`Across has no ${args.token} route to chain ${args.chainId}`)
  const built = buildAcrossBridgeOnWithdraw({
    broadcaster: args.broadcaster,
    dai: EthAddress.fromString(args.dai),
    from: args.from,
    plainWithdrawalExecutor: {
      address: EthAddress.fromString(args.executor.address),
      fee: args.executor.fee,
    },
    amount: args.amount,
    withdrawalRelayerTip: args.withdrawalRelayerTip,
    proverTip: args.proverTip,
    recoveryAccount: EthAddress.fromString(args.recovery.account),
    relayerTip: args.relayerTip,
    portal: EthAddress.fromString(args.portal),
    nonce: args.nonce,
    recoverySalt: args.recovery.salt,
    acrossBridgeEscrowFactory: EthAddress.fromString(args.factory),
    route,
    recipient: EthAddress.fromString(args.recipient),
    acrossFee: args.acrossFee,
  })
  if (built.operation.kind !== "withdraw") throw new Error("The bridge escrow built no withdrawal")
  return {
    escrow: built.escrow.toString() as Address,
    escrowArgs: built.escrowArgs,
    escrowOptions: {
      escrow: built.escrow,
      userPayload: built.operation.userPayload,
      l1Operation: built.l1Operation,
      broadcaster: args.l2Broadcaster,
      executor: args.executor.address,
      withdrawalFee: args.executor.fee,
      memo: {
        bridge: {
          provider: "across",
          chainId: args.chainId,
          token: args.token,
          recipient: args.recipient,
          factory: args.factory,
          fee: args.acrossFee,
          minReceived: args.minReceived,
          recoveryCommitment: built.escrowArgs.recoveryCommitment,
          relayerTip: args.relayerTip,
          nonce: args.nonce,
        },
      },
    },
  }
}

/** The run opens no commitment and pays no one; both only need to be nonzero and field-sized. */
const SIMULATION_COMMITMENT = `0x00${keccak256(
  new TextEncoder().encode("obsidion.bridge-out.simulation"),
).slice(4)}` as Hex
const SIMULATION_RECIPIENT = `0x${"0b".repeat(20)}` as Address
/** Gas depends on whether the tip transfer writes a nonzero balance, not on the amount. */
const SIMULATION_TIP = 1n

export interface BridgeOutDeployment {
  acrossBridgeEscrowFactory: Address
  operationExecutor: Address
  dai: Address
  /** A withdrawal subsidy on the same chain; its `PRICE_FEED` prices the relayer's gas. */
  withdrawalSubsidy: Address
}

export interface BridgeOutQuote {
  /** Across input-token units the escrow keeps back for Across. */
  acrossFee: bigint
  /** Output-token units the recipient receives at the swap floor. */
  minReceived: bigint
  tip: RelayerTipEstimate
}

/**
 * Prices a bridge-out: the relayer's tip for running the escrow, by simulating the run with the
 * escrow funded by storage override, then Across's fee on what the escrow deposits after that tip.
 */
export async function quoteAcrossBridgeOnWithdraw(
  client: Pick<
    PublicClient,
    "getBlock" | "estimateMaxPriorityFeePerGas" | "simulateBlocks" | "readContract"
  >,
  deployment: BridgeOutDeployment,
  args: {
    route: AcrossBridgeRoute
    amount: bigint
    withdrawalFee: bigint
    withdrawalRelayerTip: bigint
    proverTip: bigint
    /** DAI the release leaves at the escrow. */
    escrowFunding: bigint
    sender: Address
    acrossApiUrl?: string
  },
): Promise<BridgeOutQuote> {
  const funding = {
    amount: args.amount,
    withdrawalRelayerTip: args.withdrawalRelayerTip,
    proverTip: args.proverTip,
    plainWithdrawalExecutor: { address: EthAddress.ZERO, fee: args.withdrawalFee },
  }
  const across = { baseUrl: args.acrossApiUrl }
  // A tip only shrinks the deposit, so the tip-free fee is a ceiling the simulated run can afford.
  const ceiling = await fetchAcrossFees({ ...funding, relayerTip: 0n, route: args.route }, across)
  const simulated = routeEscrowArgs(args.route, {
    recipient: SIMULATION_RECIPIENT,
    acrossFee: quoteAcrossBridge({ ...funding, relayerTip: 0n, route: args.route }, ceiling)
      .acrossFee,
    recoveryCommitment: SIMULATION_COMMITMENT,
    relayerTip: SIMULATION_TIP,
    nonce: SIMULATION_COMMITMENT,
  })
  const escrow = predictAcrossBridgeEscrowAddressLocally(
    deployment.acrossBridgeEscrowFactory,
    simulated,
  )
  const [balanceOfSlot, ethUsdFeed] = await Promise.all([
    findBalanceOfSlot(client, deployment.dai),
    client.readContract({
      address: deployment.withdrawalSubsidy,
      abi: PlainWithdrawalSubsidyAbi,
      functionName: "PRICE_FEED",
    }),
  ])
  const tip = await quoteL1OperationTip(client, {
    executor: deployment.operationExecutor,
    sender: args.sender,
    eth: { feed: ethUsdFeed },
    token: PAR_TIP_TOKEN,
    payout: SIMULATION_TIP,
    operation: {
      target: deployment.acrossBridgeEscrowFactory,
      calldata: encodeAcrossBridgeEscrowDeploy(simulated),
      payoutToken: deployment.dai,
    },
    stateOverrides: [
      {
        address: deployment.dai,
        stateDiff: [
          {
            slot: mappingSlot(escrow, balanceOfSlot),
            value: numberToHex(args.escrowFunding, { size: 32 }),
          },
        ],
      },
    ],
  })
  const priced = { ...funding, relayerTip: tip.relayerTip, route: args.route }
  const { acrossFee, minReceived } = quoteAcrossBridge(
    priced,
    await fetchAcrossFees(priced, across),
  )
  return { acrossFee, minReceived, tip }
}
