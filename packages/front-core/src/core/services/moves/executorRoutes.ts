// The `executor` rail: a vault move's burn pays the deployment's `MultiStepExecutor`, which runs the
// route in the burn's release, through the vault into the destination portal.
import type { ExecutorHolding, MultiStepExecutor } from "@obsidion/core/oxide"
import {
  buildMove,
  buildMultiStepRecoverCall,
  buildVaultSwap,
  encodeWithdrawalMemo,
  HOLDING_ADAPTERS,
  quoteMove,
  quoteVaultSwap,
  readHoldingRoute,
  readMultiStepRecovery,
  readPortalDeposits,
} from "@obsidion/sdk"
import type { EthUsdSource, HoldingRoute, VaultMoveBurn } from "@obsidion/sdk"
import { erc4626Abi, isAddressEqual, zeroHash, type Address, type Hex } from "viem"
import type { PublicClient } from "viem"
import { WalletError } from "../../../engine/errors"
import { SWAP_ESCROW_RECOVERY_DEADLINE_S } from "../../../oxide/swapEscrowRecovery"
import type { MoveQuote } from "../../../engine/moveTransition"
import { l1MoveReads, movePortals } from "./moveReads"
import type { BlockRange, MoveBurn, MoveOutcome, MoveRoute, MoveRoutes } from "./types"

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

/**
 * What became of a burn's released funds through the executor. The route runs in the release and
 * ends in the deposit into `deposit.portal`, so the deposit shows the run, and what the vault took
 * in or paid out is `vault.token`'s last `vault.event` before the deposit, in the same tx. A recovery
 * spends the same withdrawal and returns `recovered`, so a burn shows one or the other.
 */
async function releasedFunds(
  l1: ExecutorL1,
  {
    executor,
    withdrawalId,
    deposit,
    vault,
    recovered,
  }: {
    executor: Address
    withdrawalId: Hex
    deposit: { portal: Address; recipientCommitment: Hex }
    vault: { token: Address; event: "Deposit" | "Withdraw" }
    recovered: Address
  },
  range: BlockRange,
  signal?: AbortSignal,
): Promise<MoveOutcome | undefined> {
  signal?.throwIfAborted()
  const [found] = await readPortalDeposits(
    l1,
    [deposit.portal],
    [deposit.recipientCommitment],
    range.from,
    range.to,
  )
  signal?.throwIfAborted()
  if (!found) {
    const recovery = await readMultiStepRecovery(l1, { executor, withdrawalId, ...range })
    if (!recovery) return undefined
    const { txHash, recipient: to, blockNumber } = recovery
    return { kind: "recovered", txHash, to, token: recovered, blockNumber }
  }
  const logs = await l1.getContractEvents({
    address: vault.token,
    abi: erc4626Abi,
    eventName: vault.event,
    fromBlock: found.blockNumber,
    toBlock: found.blockNumber,
  })
  signal?.throwIfAborted()
  const ran = logs
    .filter((log) => log.transactionHash === found.txHash && log.logIndex < found.logIndex)
    .at(-1)
  if (ran?.args.assets === undefined) {
    throw new WalletError("move.routeUnread", `no vault event in ${found.txHash}`)
  }
  return { kind: "ran", assets: ran.args.assets }
}

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

    outcome: (route, move, range, signal) => {
      const into = move.direction === "in"
      const funds = {
        executor: route.executor.address as Address,
        withdrawalId: move.withdrawalId,
        deposit: {
          portal: movePortals(route, move.direction).destination,
          recipientCommitment: move.recipientCommitment,
        },
        vault: { token: route.held.token, event: into ? "Deposit" : "Withdraw" },
        recovered: into ? route.base.token : route.held.token,
      } as const
      return releasedFunds(l1, funds, range, signal)
    },

    owns: (route, burn): burn is MoveBurn<"executor"> =>
      burn.rail === "executor" &&
      [route.base.portal, route.held.portal].some((portal) =>
        isAddressEqual(portal, burn.destination),
      ),

    vaultSwap: {
      quote: async (from, to, amount) => {
        const quote = await quoteVaultSwap(l1, from.holding, to.holding, {
          amount,
          eth: deps.eth,
          recoveryMemo: SIZING_MEMO,
        })
        return {
          routed: quote.routed,
          relayerTip: quote.relayerTip,
          conversionOut: quote.assetOut,
          conversionMinOut: quote.assetMinOut,
          expectedOut: quote.expectedOut,
          minOut: quote.minOut,
          withdrawalFee: 0n,
          out: { minOut: quote.redeemMinOut, conversionMinOut: quote.baseMinOut },
        }
      },

      build: (from, to, args, quote) => {
        if (!quote.out) throw new WalletError("invariant", "a swap's quote has no floors out")
        const { operation } = buildVaultSwap(from.holding, to.holding, {
          redeemMinOut: quote.out.minOut,
          baseMinOut: quote.out.conversionMinOut,
          assetMinOut: quote.conversionMinOut,
          minOut: quote.minOut,
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
          destination: to.held.portal,
          target: from.holding.deployment.executor,
          withdrawal: { multiStep: { operation, executor: from.executor } },
          releaseTip: quote.relayerTip,
        }
      },

      outcome: (from, to, move, range, signal) => {
        const funds = {
          executor: from.executor.address as Address,
          withdrawalId: move.withdrawalId,
          deposit: { portal: to.held.portal, recipientCommitment: move.recipientCommitment },
          vault: { token: to.held.token, event: "Deposit" },
          recovered: from.held.token,
        } as const
        return releasedFunds(l1, funds, range, signal)
      },

      owns: (from, to, burn): burn is MoveBurn<"executor"> =>
        burn.rail === "executor" &&
        !isAddressEqual(from.held.portal, to.held.portal) &&
        isAddressEqual(burn.destination, to.held.portal),
    },

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
