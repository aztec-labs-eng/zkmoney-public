import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { broadcastL1Operation } from "@oxide/oxide-client/broadcaster_calls.js"
import { readPlainWithdrawalFee } from "@oxide/oxide-client/executors/plain_withdrawal_executor.js"
import {
  assertSwapEscrowDeployable,
  buildSwapOnWithdraw,
} from "@oxide/oxide-client/withdraw_escrows/swap.js"
import type { FinalizationRequestBroadcastParams } from "@oxide/oxide-client/withdrawal_finalization_request.js"
import type { BroadcastL1Operation } from "@oxide/oxide-lib/l1_operation_calldata.js"
import { encodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import { decodeMultiStepPayload } from "@oxide/l1-contracts/multi_step/index.js"
import {
  BroadcasterContract,
  type ContractService,
  ensureContractRegisteredInPXE,
  getBroadcasterArtifact,
} from "@obsidion/contracts"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { WalletError } from "@obsidion/core/errors"
import type { MultiStepExecutor } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address, PublicClient } from "viem"
import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import type {
  PlainWithdrawalContext,
  WithdrawOperation,
} from "../../oxide/withdrawal/plainWithdrawal.js"
import { swapOutputForRoute, type SwapOnWithdrawPlan } from "../../oxide/escrow/swapOnWithdraw.js"
import { assertRouteOnExecutor } from "../../oxide/holdings/holdingDeployment.js"
import { encodeWithdrawalMemo, memoDerivesEscrow, type EscrowMemo } from "./withdrawalMemo.js"

export type WithdrawalDeployment = Pick<
  OxideEnvTuple,
  | "portal"
  | "token"
  | "l2Token"
  | "plainWithdrawalExecutor"
  | "l2Broadcaster"
  | "swapEscrowFactoryV2"
>

export interface WithdrawalOptions {
  /** The source deployment. Absent: the contract service's current tuple. */
  tuple?: WithdrawalDeployment
  /** Reads the executor's fee, and a swap factory, which must confirm the escrow before the burn is planned. */
  l1: Pick<PublicClient, "readContract">
  /** Swap-on-withdraw: the burn pays this escrow, and the escrow's swap broadcast rides the burn tx. */
  swap?: Pick<SwapOnWithdrawPlan, "escrowArgs" | "recovery">
  /**
   * An escrow oxide-client built (a Sky savings move or a bridge-out): the burn pays `escrow` under
   * its `userPayload`, and the escrow's `l1Operation` rides the burn tx. `broadcaster` is the L2
   * broadcaster of the deployment whose relayer runs it; absent, the source's. `memo` is what the
   * escrow address commits to, checked against `escrow` and carried in the burn's recovery memo.
   * `executor` is the executor the burn pays; absent, the source's plain one. `withdrawalFee` is
   * what that executor takes, as the escrow was priced with: a Sky withdrawal executor takes none.
   */
  escrow?: {
    escrow: EthAddress
    userPayload: Buffer
    l1Operation: BroadcastL1Operation
    broadcaster?: string
    memo: Exclude<EscrowMemo, { swap: unknown }>
    executor?: Address
    withdrawalFee: bigint
  }
  /**
   * A vault move `buildMove` built: the burn pays `operation`'s executor, the deployment's
   * `MultiStepExecutor`, which the burn's recipient names, under a route through `executor`'s
   * adapters. Its memo names the move. Nothing rides the burn tx.
   */
  multiStep?: { operation: WithdrawOperation; executor: MultiStepExecutor }
}

/** Where a burn settles and what rides its tx; the burn itself is a direct withdraw or a nested one. */
export interface PlannedPayout {
  /** The executor the burn pays. */
  executor: EthAddress
  /** The executor whose plain payload the batch checks, and its fee. */
  plainWithdrawal: PlainWithdrawalContext
  /** The user payload the burn commits to: the recipient it pays and the relayer tip. */
  userPayload: Buffer
  /** Where the burn tx broadcasts the finalization request, so a relayer can release the burn. */
  finalizationRequest: FinalizationRequestBroadcastParams
  /** The burn's recovery memo: its escrow's args or its vault move, so a rescan rebuilds it. */
  memo: Buffer
  /** The L1 operations that run the burn's escrow, broadcast in the burn tx. */
  broadcasts: ContractFunctionInteraction[]
}

export interface PlannedWithdrawal
  extends Omit<PlannedPayout, "executor" | "userPayload" | "finalizationRequest" | "memo"> {
  operation: WithdrawOperation
}

/** The user payload a wallet burn to `recipient` commits to; it offers `WITHDRAW_RELAYER_TIP`. */
export function plainUserPayload(recipient: EthAddress): Buffer {
  return encodePlainWithdrawalPayload({ recipient, relayerTip: WITHDRAW_RELAYER_TIP })
}

/** What a burn moves: `proverTip` defaults to zero. */
export interface PlannedBurn {
  from: AztecAddress
  recipient: EthAddress
  amount: bigint
  proverTip?: bigint
}

/**
 * Plan a burn of `amount` from `from` to `recipient`. The burn settles into the deployment's plain
 * withdrawal executor, and the same tx broadcasts its finalization request. A swap or escrow
 * withdrawal pays the escrow `recipient` names and broadcasts the escrow's run too. A vault move
 * pays the `MultiStepExecutor` `recipient` names, and is refused beside an escrow or a swap.
 */
export async function planPayout(
  wallet: ObsidionWallet,
  service: ContractService,
  token: AztecAddress,
  burn: PlannedBurn,
  options: WithdrawalOptions,
): Promise<PlannedPayout> {
  const tuple = options.tuple ?? (await currentDeployment(service))
  if (tuple.l2Token.toLowerCase() !== token.toString().toLowerCase()) {
    throw new Error("The withdrawal token differs from its source deployment")
  }
  if (!tuple.plainWithdrawalExecutor || !tuple.l2Broadcaster) {
    throw new Error("The withdrawal deployment has no plain withdrawal executor or broadcaster")
  }
  if (options.multiStep) assertVaultMove(burn, options, options.multiStep)
  const executor = EthAddress.fromString(options.escrow?.executor ?? tuple.plainWithdrawalExecutor)
  const dai = EthAddress.fromString(tuple.token)
  const [broadcaster, fee] = await Promise.all([
    registerBroadcaster(wallet, service, tuple.l2Broadcaster),
    options.escrow?.withdrawalFee ?? readPlainWithdrawalFee(options.l1, executor),
  ])

  const portal = EthAddress.fromString(tuple.portal)
  const finalizationRequest = { broadcaster, portal, payoutToken: dai }
  const plainWithdrawal = { executor, fee }

  if (options.multiStep) {
    const { operation } = options.multiStep
    return {
      executor: operation.executor,
      plainWithdrawal,
      userPayload: operation.userPayload,
      finalizationRequest,
      memo: operation.recoveryMemo ?? Buffer.alloc(0),
      broadcasts: [],
    }
  }

  if (options.escrow) {
    const { escrow, userPayload, l1Operation: run, broadcaster: runner, memo } = options.escrow
    if (!escrow.equals(burn.recipient)) {
      throw new Error("The escrow differs from the withdrawal destination")
    }
    if (!memoDerivesEscrow(memo, escrow.toString() as Address)) {
      throw new Error("The escrow args do not derive the withdrawal destination")
    }
    const runBroadcaster =
      !runner || runner.toLowerCase() === tuple.l2Broadcaster.toLowerCase()
        ? broadcaster
        : await registerBroadcaster(wallet, service, runner)
    return {
      executor,
      plainWithdrawal,
      userPayload,
      finalizationRequest,
      memo: encodeWithdrawalMemo(memo),
      broadcasts: [broadcastL1Operation(runBroadcaster, run)],
    }
  }

  if (!options.swap) {
    return {
      executor,
      plainWithdrawal,
      userPayload: plainUserPayload(burn.recipient),
      finalizationRequest,
      memo: Buffer.alloc(0),
      broadcasts: [],
    }
  }

  const { escrowArgs: swap, recovery } = options.swap
  if (!tuple.swapEscrowFactoryV2) throw new Error("The source deployment has no swap factory")
  const output = swapOutputForRoute(swap.route)
  if (!output) throw new Error(`Unknown swap route ${swap.route}`)
  const built = buildSwapOnWithdraw({
    broadcaster,
    swapEscrowFactoryV2: EthAddress.fromString(tuple.swapEscrowFactoryV2),
    dai,
    from: burn.from,
    plainWithdrawalExecutor: { address: executor, fee },
    amount: burn.amount,
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    proverTip: burn.proverTip ?? 0n,
    portal,
    route: swap.route,
    l1Recipient: EthAddress.fromString(swap.recipient),
    daiForGas: swap.daiForGas,
    minEthForGas: swap.minEthForGas,
    recoveryAccount: EthAddress.fromString(recovery.account),
    relayerTip: swap.relayerTip,
    nonce: swap.nonce,
    recoverySalt: recovery.salt,
  })
  if (!built.escrow.equals(burn.recipient)) {
    throw new Error("The swap escrow differs from the withdrawal destination")
  }
  if (built.operation.kind !== "withdraw") throw new Error("The swap built no withdrawal")
  // A factory with another `Args` layout could never deploy the escrow, and the burned DAI would be lost.
  await assertSwapEscrowDeployable(options.l1, built)
  return {
    executor,
    plainWithdrawal,
    userPayload: built.operation.userPayload,
    finalizationRequest,
    memo: encodeWithdrawalMemo({
      swap: {
        output,
        recipient: swap.recipient,
        factory: tuple.swapEscrowFactoryV2 as Address,
        recoveryCommitment: swap.recoveryCommitment,
        relayerTip: swap.relayerTip,
        nonce: swap.nonce,
        daiForGas: swap.daiForGas,
        minEthForGas: swap.minEthForGas,
      },
    }),
    broadcasts: [built.broadcast],
  }
}

/** The withdrawal a contract's nested `withdraw` makes for `payout`, as its batch declares it. */
export function nestedWithdrawal(
  payout: PlannedPayout,
  burn: { from: AztecAddress; amount: bigint; proverTip: bigint },
): WithdrawOperation {
  return {
    kind: "withdraw",
    from: burn.from,
    executor: payout.executor,
    userPayload: payout.userPayload,
    amount: burn.amount,
    proverTip: burn.proverTip,
    finalizationRequestBroadcastParams: payout.finalizationRequest,
    recoveryMemo: payout.memo,
  }
}

/** {@link planPayout} as a direct `withdraw` from `from`. */
export async function planWithdrawal(
  wallet: ObsidionWallet,
  service: ContractService,
  token: AztecAddress,
  burn: PlannedBurn & { authwitNonce?: Fr },
  options: WithdrawalOptions,
): Promise<PlannedWithdrawal> {
  const { executor, plainWithdrawal, userPayload, finalizationRequest, memo, broadcasts } =
    await planPayout(wallet, service, token, burn, options)
  return {
    operation: {
      kind: "withdraw",
      from: burn.from,
      executor,
      userPayload,
      amount: burn.amount,
      proverTip: burn.proverTip ?? 0n,
      finalizationRequestBroadcastParams: finalizationRequest,
      recoveryMemo: memo,
      authwitNonce: burn.authwitNonce,
    },
    plainWithdrawal,
    broadcasts,
  }
}

/** Throws unless `move` is this burn's, alone, over a route through its executor's adapters. */
function assertVaultMove(
  burn: PlannedBurn,
  options: WithdrawalOptions,
  move: NonNullable<WithdrawalOptions["multiStep"]>,
): void {
  if (options.escrow || options.swap) {
    throw new WalletError("invariant", "a vault move's burn pays no escrow")
  }
  const { operation, executor } = move
  if (
    !operation.executor.equals(burn.recipient) ||
    !operation.from.equals(burn.from) ||
    operation.amount !== burn.amount ||
    operation.proverTip !== (burn.proverTip ?? 0n)
  ) {
    throw new WalletError("invariant", "the vault move was built for another burn")
  }
  assertRouteOnExecutor(
    {
      executor: operation.executor.toString() as Address,
      payload: decodeMultiStepPayload(operation.userPayload),
    },
    executor,
  )
}

async function currentDeployment(service: ContractService): Promise<WithdrawalDeployment> {
  const client = service.getOxideClient()
  if (!client) throw new Error("A withdrawal requires its source deployment tuple")
  await client.initialize()
  const tuple = client.getCurrentTuple()
  if (!tuple) throw new Error("The withdrawal deployment is unavailable")
  return tuple
}

/** The Broadcaster at `l2Broadcaster`, registered in the PXE, for building its calls. */
export async function registerBroadcaster(
  wallet: ObsidionWallet,
  service: ContractService,
  l2Broadcaster: string,
): Promise<BroadcasterContract> {
  const address = AztecAddress.fromStringUnsafe(l2Broadcaster)
  const artifact = await service.getArtifactForInstance(address, getBroadcasterArtifact)
  await ensureContractRegisteredInPXE(wallet.pxe, wallet.node, address, () =>
    Promise.resolve(artifact),
  )
  return BroadcasterContract.at(address, artifact, wallet)
}
