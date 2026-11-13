// The `executor` rail: a vault move's burn pays the deployment's `MultiStepExecutor`, which runs the
// route in the burn's release, through the vault into the destination portal.
import type { ExecutorHolding, MultiStepExecutor } from "@obsidion/core/oxide"
import {
  buildMove,
  buildMultiStepRecoverCall,
  encodeWithdrawalMemo,
  HOLDING_ADAPTERS,
  quoteMove,
  readHoldingRoute,
  readMultiStepRecovery,
  readPortalDeposits,
  readTermsLimits,
} from "@obsidion/sdk"
import type { EthUsdSource, HoldingRoute, VaultMoveBurn } from "@obsidion/sdk"
import { erc4626Abi, isAddressEqual, zeroHash, type Address } from "viem"
import type { PublicClient } from "viem"
import { WalletError } from "../../../engine/errors"
import { SWAP_ESCROW_RECOVERY_DEADLINE_S } from "../../../oxide/swapEscrowRecovery"
import type { MoveQuote } from "../../../engine/moveTransition"
import { l1MoveReads, movePortals } from "./moveReads"
import type { MoveBurn, MoveRoute, MoveRoutes } from "./types"

export interface ExecutorRoute extends MoveRoute {
  /** The holding's deployment, with its terms and conversion bound to the executor's adapters. */
  holding: HoldingRoute
  executor: MultiStepExecutor
}

/** The L1 reads the port makes. */
export type ExecutorL1 = Pick<
  PublicClient,
  | "getChainId"
  | "getBlockNumber"
  | "getBlock"
  | "readContract"
  | "getContractEvents"
  | "simulateBlocks"
  | "estimateMaxPriorityFeePerGas"
>

export interface ExecutorRoutesDeps {
  l1: ExecutorL1
  /** Prices the relayer's tip. */
  eth: EthUsdSource
}

/** Every vault move's memo is this long, whatever its nonce: it sizes a quote's route. */
const SIZING_MEMO = encodeWithdrawalMemo({ vaultMove: { nonce: zeroHash } })

/** The executor rail's port over `deps.l1`. */
export function executorRoutes(
  deps: ExecutorRoutesDeps,
): MoveRoutes<ExecutorHolding, ExecutorRoute, MoveQuote> {
  const { l1 } = deps
  return {
    ...l1MoveReads(l1),
    rail: "executor",

    read: async (holding) => {
      const route = await readHoldingRoute(l1, HOLDING_ADAPTERS, holding)
      const { base, held } = route.deployment
      return {
        base,
        held: { portal: held.portal, token: held.token },
        holding: route,
        executor: holding.executor,
      }
    },

    // The executor charges no fee. The relayer's tip comes off the burn before the route runs.
    quote: async (route, direction, amount) => {
      const quote = await quoteMove(l1, route.holding, {
        direction,
        amount,
        eth: deps.eth,
        recoveryMemo: SIZING_MEMO,
      })
      return {
        routed: quote.routed,
        relayerTip: quote.relayerTip,
        conversionOut: quote.conversionOut,
        conversionMinOut: quote.conversionMinOut,
        expectedOut: quote.expectedOut,
        minOut: quote.minOut,
        withdrawalFee: 0n,
      }
    },

    build: (route, args, quote) => {
      const { operation } = buildMove(route.holding, {
        direction: args.direction,
        minOut: quote.minOut,
        conversionMinOut: quote.conversionMinOut,
        recipientCommitment: args.recipientCommitment,
        from: args.from,
        amount: args.amount,
        proverTip: 0n,
        relayerTip: quote.relayerTip,
        recovery: args.recovery,
        recoveryMemo: encodeWithdrawalMemo({ vaultMove: { nonce: args.nonce } }),
      })
      return {
        rail: "executor",
        destination: movePortals(route, args.direction).destination,
        target: route.holding.deployment.executor,
        withdrawal: { multiStep: { operation, executor: route.executor } },
        releaseTip: quote.relayerTip,
      }
    },

    // A route that cannot run reverts its release, so the withdrawal waits unspent. Recovery
    // releases it to `to` instead, signed for as a Sky escrow's recovery is.
    recover: async (route, move, keys, to, release) => {
      const executor = route.executor.address as Address
      const portals = movePortals(route, move.direction)
      const [args, chainId, block] = await Promise.all([
        release(executor, to),
        l1.getChainId(),
        l1.getBlock({ blockTag: "latest" }),
      ])
      return buildMultiStepRecoverCall({
        executor,
        portal: portals.source,
        chainId: BigInt(chainId),
        release: args,
        recoverySalt: keys.salt.toString(),
        account: keys.account,
        sign: keys.sign,
        recipient: to,
        deadline: block.timestamp + SWAP_ESCROW_RECOVERY_DEADLINE_S,
      })
    },

    // The route runs in the release and ends in the deposit, so the deposit shows the run. What the
    // vault took in or paid out is its last ERC-4626 event before the deposit, in the same tx. A
    // recovery spends the same withdrawal, so a move shows one or the other.
    outcome: async (route, move, range, signal) => {
      signal?.throwIfAborted()
      const { destination } = movePortals(route, move.direction)
      const [deposit] = await readPortalDeposits(
        l1,
        [destination],
        [move.recipientCommitment],
        range.from,
        range.to,
      )
      signal?.throwIfAborted()
      if (!deposit) {
        const recovery = await readMultiStepRecovery(l1, {
          executor: route.executor.address as Address,
          withdrawalId: move.withdrawalId,
          ...range,
        })
        if (!recovery) return undefined
        const token = move.direction === "in" ? route.base.token : route.held.token
        const { txHash, recipient: to, blockNumber } = recovery
        return { kind: "recovered", txHash, to, token, blockNumber }
      }
      const logs = await l1.getContractEvents({
        address: route.held.token,
        abi: erc4626Abi,
        eventName: move.direction === "in" ? "Deposit" : "Withdraw",
        fromBlock: deposit.blockNumber,
        toBlock: deposit.blockNumber,
      })
      signal?.throwIfAborted()
      const ran = logs
        .filter((log) => log.transactionHash === deposit.txHash && log.logIndex < deposit.logIndex)
        .at(-1)
      if (ran?.args.assets === undefined) {
        throw new WalletError("move.routeUnread", `no vault event in ${deposit.txHash}`)
      }
      return { kind: "ran", assets: ran.args.assets }
    },

    owns: (route, burn): burn is MoveBurn<"executor"> =>
      burn.rail === "executor" &&
      [route.base.portal, route.held.portal].some((portal) =>
        isAddressEqual(portal, burn.destination),
      ),

    limits: (route) => readTermsLimits(route.holding),

    assetsOf: (route, amount) => route.holding.terms.reader.convertToAssets(amount),
  }
}

/** The account's vault move burns as the engine reads them, each stamped with its L2 block's time. */
export async function executorMoveBurns(
  scan: { burns: readonly VaultMoveBurn[]; unread: readonly string[] },
  blockTimestampMs: (blockNumber: number) => Promise<number | undefined>,
): Promise<{ burns: MoveBurn<"executor">[]; unread: boolean }> {
  const burns = await Promise.all(
    scan.burns.map(async (burn): Promise<MoveBurn<"executor">> => {
      const timestampMs = await blockTimestampMs(burn.blockNumber)
      if (timestampMs === undefined)
        throw new WalletError("scan.incomplete", `L2 block ${burn.blockNumber} unread`)
      return {
        rail: "executor",
        destination: burn.destination,
        txHash: burn.txHash,
        timestampMs,
        withdrawalId: burn.withdrawalId,
        amount: burn.amount,
        nonce: burn.nonce,
        recipientCommitment: burn.recipientCommitment,
      }
    }),
  )
  return { burns, unread: scan.unread.length > 0 }
}
