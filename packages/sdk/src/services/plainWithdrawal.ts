import { AztecAddress } from "@aztec/aztec.js/addresses"
import type { ContractFunctionInteraction } from "@aztec/aztec.js/contracts"
import type { Fr } from "@aztec/aztec.js/fields"
import { EthAddress } from "@aztec/foundation/eth-address"
import { encodeWithdrawalBroadcast } from "@oxide/l1-contracts"
import { predictSkyEscrowAddressLocally } from "@oxide/experiments/sky/sky_savings.js"
import {
  broadcastL1Operation,
  broadcastL1OperationPair,
} from "@oxide/oxide-client/broadcaster_calls.js"
import {
  assertSwapEscrowDeployable,
  buildSwapOnWithdraw,
} from "@oxide/oxide-client/withdraw_escrows/swap.js"
import {
  L1OperationCondition,
  type BroadcastL1Operation,
} from "@oxide/oxide-lib/l1_operation_calldata.js"
import { encodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal.js"
import {
  BroadcasterContract,
  ContractService,
  ensureContractRegisteredInPXE,
  getBroadcasterArtifact,
} from "@obsidion/contracts"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { getAddress, type PublicClient } from "viem"
import type { ObsidionWallet } from "../obsidion/ObsidionWallet.js"
import type {
  PlainWithdrawalContext,
  PortalWithdrawalState,
  WithdrawOperation,
} from "../oxide/plainWithdrawal.js"
import { swapOutputForRoute, type SwapOnWithdrawPlan } from "../oxide/swapOnWithdraw.js"
import { buildWithdrawMeta, type SkyWithdrawMeta } from "./withdrawMeta.js"

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
  /** The portal state at the burn; the relayer-tip check reads it. */
  portal: PortalWithdrawalState
  /**
   * Swap-on-withdraw: the burn pays this escrow, and the escrow's swap broadcast rides the burn tx.
   * `l1` reads the factory, which must confirm the escrow before the burn is planned.
   */
  swap?: Pick<SwapOnWithdrawPlan, "escrowArgs" | "recovery"> & {
    l1: Pick<PublicClient, "readContract">
  }
  /**
   * An escrow oxide-client built (Sky savings): the burn pays `escrow` under its `userPayload`,
   * and the escrow's `l1Operation` rides the burn tx. `broadcaster` is the L2 broadcaster of the
   * deployment whose relayer runs it; absent, the run pairs with the release on the source's.
   * `sky` is what the escrow address commits to, kept in the burn's meta for a rescan.
   */
  escrow?: {
    escrow: EthAddress
    userPayload: Buffer
    l1Operation: BroadcastL1Operation
    broadcaster?: string
    sky?: SkyWithdrawMeta
  }
}

/** Where a burn settles and what rides its tx; the burn itself is a direct withdraw or a nested one. */
export interface PlannedPayout {
  plainWithdrawal: PlainWithdrawalContext
  /** The user payload the burn commits to: the recipient it pays and the relayer tip. */
  userPayload: Buffer
  /** Withdraw meta naming the payee (and the swap on a swap-on-withdraw). */
  meta: Fr[]
  /** The L1 operations that release the burn (and run its escrow), broadcast in the burn tx. */
  broadcasts: ContractFunctionInteraction[]
}

export interface PlannedWithdrawal extends Omit<PlannedPayout, "userPayload" | "meta"> {
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
 * withdrawal executor, and the same tx broadcasts the L1 operation that releases it. A swap or
 * escrow withdrawal pays the escrow `recipient` names and broadcasts the escrow's run too.
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
  const executor = EthAddress.fromString(tuple.plainWithdrawalExecutor)
  const dai = EthAddress.fromString(tuple.token)
  const broadcaster = await registerBroadcaster(wallet, service, tuple.l2Broadcaster)

  const release: BroadcastL1Operation = {
    target: EthAddress.fromString(tuple.portal),
    payoutToken: dai,
    calldata: Buffer.from(encodeWithdrawalBroadcast().slice(2), "hex"),
    condition: L1OperationCondition.messageInOutbox(),
  }
  const plainWithdrawal = { executor, ...options.portal }

  if (options.escrow) {
    const { escrow, userPayload, l1Operation: run, broadcaster: runner, sky } = options.escrow
    if (!escrow.equals(burn.recipient)) {
      throw new Error("The escrow differs from the withdrawal destination")
    }
    if (
      sky &&
      !EthAddress.fromString(predictSkyEscrowAddressLocally(sky.factory, sky)).equals(escrow)
    ) {
      throw new Error("The Sky escrow args do not derive the withdrawal destination")
    }
    const paired = !runner || runner.toLowerCase() === tuple.l2Broadcaster.toLowerCase()
    return {
      plainWithdrawal,
      userPayload,
      meta: buildWithdrawMeta({
        recipient: getAddress(escrow.toString()),
        sky,
      }),
      broadcasts: paired
        ? [broadcastL1OperationPair(broadcaster, [release, run])]
        : [
            broadcastL1Operation(broadcaster, release),
            broadcastL1Operation(await registerBroadcaster(wallet, service, runner), run),
          ],
    }
  }

  if (!options.swap) {
    return {
      plainWithdrawal,
      userPayload: plainUserPayload(burn.recipient),
      meta: buildWithdrawMeta({ recipient: getAddress(burn.recipient.toString()) }),
      broadcasts: [broadcastL1Operation(broadcaster, release)],
    }
  }

  const { escrowArgs: swap, recovery, l1 } = options.swap
  if (!tuple.swapEscrowFactoryV2) throw new Error("The source deployment has no swap factory")
  const output = swapOutputForRoute(swap.route)
  if (!output) throw new Error(`Unknown swap route ${swap.route}`)
  const built = buildSwapOnWithdraw({
    broadcaster,
    swapEscrowFactoryV2: EthAddress.fromString(tuple.swapEscrowFactoryV2),
    dai,
    from: burn.from,
    plainWithdrawalExecutor: executor,
    amount: burn.amount,
    withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
    proverTip: burn.proverTip ?? 0n,
    fpcFundingCut: options.portal.fpcFundingCut,
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
  await assertSwapEscrowDeployable(l1, built)
  return {
    plainWithdrawal,
    userPayload: built.operation.userPayload,
    meta: buildWithdrawMeta({
      recipient: getAddress(built.escrow.toString()),
      swap: {
        output,
        recipient: getAddress(swap.recipient),
        factory: getAddress(tuple.swapEscrowFactoryV2),
        recoveryCommitment: swap.recoveryCommitment,
        relayerTip: swap.relayerTip,
        nonce: swap.nonce,
        daiForGas: swap.daiForGas,
        minEthForGas: swap.minEthForGas,
      },
    }),
    broadcasts: [broadcastL1OperationPair(broadcaster, [release, built.l1Operation])],
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
  const { plainWithdrawal, userPayload, meta, broadcasts } = await planPayout(
    wallet,
    service,
    token,
    burn,
    options,
  )
  return {
    operation: {
      kind: "withdraw",
      from: burn.from,
      executor: plainWithdrawal.executor,
      userPayload,
      amount: burn.amount,
      proverTip: burn.proverTip ?? 0n,
      meta,
      authwitNonce: burn.authwitNonce,
    },
    plainWithdrawal,
    broadcasts,
  }
}

async function currentDeployment(service: ContractService): Promise<WithdrawalDeployment> {
  const client = service.getOxideClient()
  if (!client) throw new Error("A withdrawal requires its source deployment tuple")
  await client.initialize()
  const tuple = client.getCurrentTuple()
  if (!tuple) throw new Error("The withdrawal deployment is unavailable")
  return tuple
}

async function registerBroadcaster(
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
