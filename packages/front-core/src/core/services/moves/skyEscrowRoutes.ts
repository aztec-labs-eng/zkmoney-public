// The `skyEscrow` rail: a move's burn pays a counterfactual Sky escrow DAI, and Main's relayer runs
// the escrow into the destination portal: the sUSDS one moving in (stake), the DAI one moving out
// (unstake).
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { OxideBridge } from "@obsidion/core/oxide"
import {
  buildSkyEscrowMove,
  quoteSkyEscrowTip,
  quoteSkyReleaseTip,
  readExecutorPortal,
  readExecutorSubsidy,
  readSkyEscrowOutcome,
  readWithdrawalExecutor,
  recoverSkyEscrowBurns,
  SkyTipExceedsFundingError,
} from "@obsidion/sdk"
import type {
  SkyEscrowMoveArgs,
  SwapRecovery,
  WithdrawalExecutor,
  WithdrawEventSource,
} from "@obsidion/sdk"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { erc20Abi, erc4626Abi, getAddress, isAddressEqual, maxUint256 } from "viem"
import type { Address, Hex, PublicClient } from "viem"
import { WalletError } from "../../../engine/errors"
import type { MoveDirection, MoveQuote } from "../../../engine/moveTransition"
import { signEscrowRecovery } from "../../../oxide/swapEscrowRecovery"
import { escrowRecoverCall, escrowRunCall, type SkyLeg } from "../bridge/escrowLeg"
import { skyEscrow, skyLeg, skyRoute } from "../bridge/skyEscrowLeg"
import { l1MoveReads, movePortals } from "./moveReads"
import { readSkyFactoryPortals } from "./skyFactoryPortals"
import type { MoveBurn, MoveRoute, MoveRoutes, RouteHolding } from "./types"

/**
 * Sky savings: moves run through escrows of `factory`; a move out's burn pays `withdrawalExecutor`.
 */
export type SkyEscrowHolding = RouteHolding & {
  rail: "skyEscrow"
  escrow: { factory: string; withdrawalExecutor: string }
}

type SkyBroadcaster = SkyEscrowMoveArgs["broadcaster"]

/** The executor a direction's burn pays, and the subsidy its release claims. */
interface SourceExecutor {
  address: Address
  fee: bigint
  beneficiary?: Address
  subsidy: Address
}

export interface SkyEscrowRoute extends MoveRoute {
  chainId: number
  factory: Address
  /** Main's: Main's relayer runs every Sky escrow. */
  operationExecutor: Address
  broadcaster: SkyBroadcaster
  /** Main's plain executor moving in, the Sky withdrawal executor moving out. */
  executors: Record<MoveDirection, SourceExecutor>
}

/** The escrow's two DAI tips, carried from the quote to the build. */
export interface SkyEscrowQuote extends MoveQuote {
  releaseTip: bigint
  escrowTip: bigint
}

/** The L1 reads the port makes. */
export type SkyEscrowL1 = Pick<
  PublicClient,
  | "getChainId"
  | "getBlockNumber"
  | "getBlock"
  | "getCode"
  | "readContract"
  | "getContractEvents"
  | "call"
  | "simulateBlocks"
  | "estimateMaxPriorityFeePerGas"
>

export interface SkyEscrowRoutesDeps {
  l1: SkyEscrowL1
  /** The wallet's binding of the Broadcaster at `address`. */
  broadcaster(address: string): Promise<SkyBroadcaster>
  /** A recovery's 32 random nonce bytes. */
  nonce?: () => Uint8Array
}

function tupleAddress(
  bridge: OxideBridge,
  field: "plainWithdrawalExecutor" | "operationExecutor" | "l2Broadcaster",
): string {
  const value = bridge.tuple[field]
  if (!value) throw new WalletError("config.invalid", `${bridge.portal} names no ${field}`)
  return value
}

const tipsExceedAmount = (amount: bigint, tips: bigint) =>
  new WalletError("move.tipsExceedAmount", `${tips} of ${amount}`, {
    data: { tips: tips.toString() },
  })

/** An L1 failure while a route is read or quoted, under a code; a `WalletError` keeps its own. */
function routeUnread(error: unknown): never {
  if (error instanceof WalletError) throw error
  const detail = error instanceof Error ? error.message : String(error)
  throw new WalletError("move.routeUnread", detail, { cause: error })
}

/** The Sky escrow rail's port over `deps.l1`. */
export function skyEscrowRoutes(
  deps: SkyEscrowRoutesDeps,
): MoveRoutes<SkyEscrowHolding, SkyEscrowRoute, SkyEscrowQuote> {
  const { l1 } = deps
  const vault = (
    route: MoveRoute,
    functionName: "convertToAssets" | "convertToShares",
    amount: bigint,
  ) => l1.readContract({ address: route.held.token, abi: erc4626Abi, functionName, args: [amount] })

  const sourceExecutor = async (
    address: Address,
    kind: WithdrawalExecutor["kind"],
  ): Promise<SourceExecutor & { portal: Address }> => {
    const [executor, subsidy] = await Promise.all([
      readWithdrawalExecutor(l1, address, kind),
      readExecutorSubsidy(l1, address),
    ])
    const { fee, portal, beneficiary } = executor
    return { address, fee, portal, subsidy, ...(beneficiary ? { beneficiary } : {}) }
  }

  async function readRoute(holding: SkyEscrowHolding): Promise<SkyEscrowRoute> {
    const { base, held } = holding
    const factory = getAddress(holding.escrow.factory)
    const mainExecutor = getAddress(tupleAddress(base, "plainWithdrawalExecutor"))
    const operationExecutor = getAddress(tupleAddress(base, "operationExecutor"))
    const l2Broadcaster = tupleAddress(base, "l2Broadcaster")
    const [chainId, factoryPortals, main, sky, broadcaster] = await Promise.all([
      l1.getChainId(),
      readSkyFactoryPortals(l1, factory),
      sourceExecutor(mainExecutor, "plain"),
      sourceExecutor(getAddress(holding.escrow.withdrawalExecutor), "sky"),
      deps.broadcaster(l2Broadcaster),
    ])
    const route = {
      base: { portal: getAddress(base.portal), token: getAddress(base.underlying) },
      held: { portal: getAddress(held.portal), token: getAddress(held.underlying) },
    }
    const served = [
      [factoryPortals.daiPortal, route.base.portal],
      [factoryPortals.sUsdsPortal, route.held.portal],
      [main.portal, route.base.portal],
      [sky.portal, route.held.portal],
    ] as const
    if (served.some(([portal, bridge]) => !isAddressEqual(portal, bridge)))
      throw new WalletError("move.routeMismatch", holding.id)
    return {
      ...route,
      chainId,
      factory,
      operationExecutor,
      broadcaster,
      executors: { in: main, out: sky },
    }
  }

  // Both tips are DAI. The release pays the relayer its tip at the escrow; the escrow's run pays
  // its own tip from what reached it.
  async function quote(
    route: SkyEscrowRoute,
    direction: MoveDirection,
    amount: bigint,
  ): Promise<SkyEscrowQuote> {
    const executor = route.executors[direction]
    const [value, release] = await Promise.all([
      direction === "in" ? amount : vault(route, "convertToAssets", amount),
      quoteSkyReleaseTip(l1, executor.subsidy, skyRoute(direction)),
    ])
    const releaseTip = release.relayerTip
    const burned = async (dai: bigint) =>
      direction === "in" ? dai : vault(route, "convertToShares", dai)
    const escrowFunding = value - executor.fee - releaseTip
    if (escrowFunding <= 0n) throw tipsExceedAmount(amount, await burned(executor.fee + releaseTip))
    const escrowTip = await quoteSkyEscrowTip(
      l1,
      {
        skyEscrowFactory: route.factory,
        operationExecutor: route.operationExecutor,
        dai: route.base.token,
        withdrawalSubsidy: executor.subsidy,
      },
      { route: skyRoute(direction), escrowFunding, sender: route.factory },
    ).then(
      (tip) => tip.relayerTip,
      async (error: unknown) => {
        if (!(error instanceof SkyTipExceedsFundingError)) throw error
        const tips = executor.fee + releaseTip + error.tip.relayerTip
        throw tipsExceedAmount(amount, await burned(tips))
      },
    )
    const net = escrowFunding - escrowTip
    const fee = {
      withdrawalFee: executor.fee,
      ...(executor.beneficiary ? { feeBeneficiary: executor.beneficiary } : {}),
    }
    const terms = { ...fee, releaseTip, escrowTip, conversionMinOut: 0n, minOut: 0n }
    // The escrow holds no floor. Moving in, DAI converts to USDS one to one before the deposit.
    // Moving out, the burn redeems for `value` at the quoted rate, and the tips come off that
    // DAI, so they read in shares as the rest.
    if (direction === "in") {
      const shares = await vault(route, "convertToShares", net)
      const figures = { routed: net, conversionOut: net, expectedOut: shares }
      return { ...terms, ...figures, relayerTip: releaseTip + escrowTip }
    }
    const routed = await vault(route, "convertToShares", net)
    const figures = { routed, conversionOut: net, expectedOut: value }
    return { ...terms, ...figures, relayerTip: amount - routed }
  }

  return {
    ...l1MoveReads(l1),
    rail: "skyEscrow",

    read: (holding) => readRoute(holding).catch(routeUnread),

    quote: (route, direction, amount) => quote(route, direction, amount).catch(routeUnread),

    build: (route, args, quote) => {
      const executor = route.executors[args.direction]
      const move = buildSkyEscrowMove({
        broadcaster: route.broadcaster,
        factory: route.factory,
        dai: route.base.token,
        from: args.from,
        portal: movePortals(route, args.direction).source,
        executor: { address: executor.address, fee: executor.fee },
        amount: args.amount,
        route: skyRoute(args.direction),
        recipientCommitment: args.recipientCommitment,
        recovery: args.recovery,
        nonce: args.nonce,
        escrowTip: quote.escrowTip,
        releaseTip: quote.releaseTip,
      })
      return {
        rail: "skyEscrow",
        escrow: { factory: route.factory, address: move.escrow, tip: quote.escrowTip },
        target: move.escrow,
        withdrawal: { escrow: move.options },
        releaseTip: quote.releaseTip,
      }
    },

    // Only a recovery of the DAI `recover` takes back is the move's.
    outcome: async (route, move, range, signal) => {
      signal?.throwIfAborted()
      const found = await readSkyEscrowOutcome(l1, {
        escrow: move.escrow.address,
        fromBlock: range.from,
        toBlock: range.to,
      })
      signal?.throwIfAborted()
      if (found?.kind !== "recovered") return found
      const back = found.recoveries.find((r) => isAddressEqual(r.token, route.base.token))
      return (
        back && {
          kind: "recovered",
          txHash: back.txHash,
          to: back.to,
          token: back.token,
          blockNumber: back.blockNumber,
        }
      )
    },

    owns: (route, burn): burn is MoveBurn<"skyEscrow"> =>
      burn.rail === "skyEscrow" && isAddressEqual(burn.escrow.factory, route.factory),

    // Before its run, either route's escrow holds DAI: the Sky executor pays an unstake's release
    // in DAI. One that holds none, unpaid yet or emptied, is refused before the account signs.
    recover: async (route, move, keys, to) => {
      const { address: escrow } = move.escrow
      const recovery = { salt: keys.salt, account: keys.account }
      const leg = moveLeg(move, keys)
      const token = route.base.token
      const reader = {
        tokenBalance: (erc20: Address, holder: Address) =>
          l1.readContract({
            address: erc20,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [holder],
          }),
        isDeployed: async (address: Address) => {
          const code = await l1.getCode({ address })
          return code !== undefined && code !== "0x"
        },
      }
      const [balance, deployed] = await Promise.all([
        reader.tokenBalance(token, escrow),
        reader.isDeployed(escrow),
      ])
      if (balance === 0n) throw new WalletError("move.escrowEmpty", move.id)
      const signed = await signEscrowRecovery(
        {
          reader,
          recovery,
          signAccount: (_account, digest) => keys.sign(digest),
          target: to,
          chainId: route.chainId,
          makeNonce: deps.nonce,
          chainNow: async () => (await l1.getBlock({ blockTag: "latest" })).timestamp,
        },
        escrow,
        leg.recoveryCommitment,
        token,
        { owner: "move" },
      )
      return escrowRecoverCall(leg, {
        deployed,
        recovery,
        target: to,
        token,
        ...signed,
      })
    },

    run: async (route, move, keys) => {
      const leg = moveLeg(move, keys)
      const held = await l1.readContract({
        address: route.base.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [move.escrow.address],
      })
      if (held === 0n) throw new WalletError("move.escrowRan", move.id)
      return escrowRunCall(leg)
    },

    // sUSDS caps neither deposits nor redeems.
    limits: async () => ({ maxDeposit: maxUint256, maxRedeem: maxUint256 }),

    assetsOf: (route, amount) => vault(route, "convertToAssets", amount),
  }
}

/** The leg of a move's escrow; an escrow nobody ran is deployed from its args, so they must derive its address. */
function moveLeg(
  move: { id: string; direction: MoveDirection; recipientCommitment: Hex; nonce: Hex } & {
    escrow: { factory: Address; address: Address; tip: bigint }
  },
  keys: SwapRecovery,
): SkyLeg {
  const { factory, address, tip } = move.escrow
  const leg = skyLeg(factory, address, {
    route: skyRoute(move.direction),
    recipientCommitment: move.recipientCommitment,
    recoveryCommitment: deriveRecoveryCommitment(
      keys.salt,
      EthAddress.fromString(keys.account),
    ).toString() as Hex,
    relayerTip: tip,
    nonce: move.nonce,
  })
  if (!isAddressEqual(skyEscrow.predict(factory, leg.args), address))
    throw new WalletError("move.recoveryKeysMismatch", move.id)
  return leg
}

/**
 * The executor terms a portal's withdrawal source reads. An executor of a held portal reads as a
 * Sky withdrawal executor, retired ones included: it has no `FEE`, so read as plain, the source
 * would drop its moves out.
 */
export function skyEscrowExecutors(
  reads: {
    portalOf: (executor: Address) => Promise<Address>
    executor: (address: Address, kind: "sky" | "plain") => Promise<WithdrawalExecutor>
  },
  holdings: readonly Pick<SkyEscrowHolding, "held">[],
): (address: Address) => Promise<WithdrawalExecutor> {
  return async (address) => {
    const portal = await reads.portalOf(address)
    const held = holdings.some((h) => isAddressEqual(portal, h.held.portal as Address))
    return reads.executor(address, held ? "sky" : "plain")
  }
}

/** `skyEscrowExecutors`' reads, straight from L1. */
export const l1ExecutorReads = (l1: Pick<PublicClient, "readContract">) => ({
  portalOf: (executor: Address) => readExecutorPortal(l1, executor),
  executor: (address: Address, kind: "sky" | "plain") => readWithdrawalExecutor(l1, address, kind),
})

/**
 * The account's burns through `source`'s portal into an escrow of one of `factories`, in L2 blocks
 * `[fromBlock, toBlockExclusive)`, as a replay reads them. `unread`: a burn this read could
 * not read, which a later pass reads.
 */
export async function skyEscrowMoveBurns(
  source: Pick<WithdrawEventSource, "scanWithdrawals" | "blockTimestampMs">,
  args: { factories: readonly Address[]; fromBlock: number; toBlockExclusive: number },
): Promise<{ burns: MoveBurn<"skyEscrow">[]; unread: boolean }> {
  const { burns, unread } = await recoverSkyEscrowBurns(source, args)
  const read = await Promise.all(
    burns.map(async (burn): Promise<MoveBurn<"skyEscrow">> => {
      const timestampMs = await source.blockTimestampMs(burn.blockNumber)
      if (timestampMs === undefined)
        throw new WalletError("scan.incomplete", `L2 block ${burn.blockNumber} unread`)
      const { sky } = burn
      return {
        rail: "skyEscrow",
        escrow: { factory: sky.factory, address: burn.l1Recipient, tip: sky.relayerTip },
        txHash: burn.txHash,
        timestampMs,
        withdrawalId: burn.withdrawalId,
        amount: burn.amount,
        nonce: sky.nonce,
        recipientCommitment: sky.recipientCommitment,
      }
    }),
  )
  return { burns: read, unread }
}
