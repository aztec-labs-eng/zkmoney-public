/**
 * The account's vault moves, read back from the recovery events of their burns: what a device with
 * no record of a move rebuilds it from.
 */
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import { createLogger } from "@aztec-labs/foundation/log"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { PortalDepositAdapterAbi } from "@oxide/l1-contracts/artifacts.js"
import { decodeMultiStepPayload } from "@oxide/l1-contracts/multi_step/index.js"
import { recoverWithdrawals } from "@oxide/oxide-client/withdrawal_recovery.js"
import type {
  RecoveredWithdrawal,
  WithdrawalRecoveryResult,
} from "@oxide/oxide-client/withdrawal_recovery.js"
import { computeWithdrawalId } from "@oxide/oxide-lib/hash.js"
import type { PortalDomain } from "@oxide/oxide-lib/types.js"
import { decodeFunctionData, getAddress, isAddressEqual } from "viem"
import type { Address, Hex } from "viem"
import { OxideTokenContract } from "@obsidion/contracts"
import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import { unindexedFailures } from "../../services/withdrawal/withdrawEventSource.js"
import { decodeWithdrawalMemo } from "../../services/withdrawal/withdrawalMemo.js"

const log = createLogger("wallet-sdk:move-burns")

/** What a vault move's burn says of its move. */
export interface VaultMove {
  amount: bigint
  /** With the master secret, derives the move's claim and recovery secrets. */
  nonce: Hex
  /** The portal the route deposits into, and what that deposit commits to. */
  destination: Address
  recipientCommitment: Hex
}

/** One vault move's burn. */
export interface VaultMoveBurn extends VaultMove {
  txHash: string
  blockNumber: number
  /** What the source portal keys the withdrawal's release on. */
  withdrawalId: Hex
}

/**
 * The move a burn made: one that pays one of `executors`, whose memo names a vault move and whose
 * route ends in a portal deposit. Undefined for any other burn.
 */
export function readVaultMove(
  recovered: Pick<RecoveredWithdrawal, "finalizationData" | "memo">,
  executors: readonly Address[],
): VaultMove | undefined {
  const { executor, amount, userPayload } = recovered.finalizationData
  const paid = getAddress(executor.toString())
  if (!executors.some((e) => isAddressEqual(e, paid))) return undefined
  const nonce = decodeWithdrawalMemo(recovered.memo).vaultMove?.nonce
  if (!nonce) return undefined
  try {
    const last = decodeMultiStepPayload(userPayload).steps.at(-1)
    if (!last) throw new Error("the route has no steps")
    const call = decodeFunctionData({ abi: PortalDepositAdapterAbi, data: last.data })
    if (call.functionName !== "portalDeposit")
      throw new Error(`the route ends in ${call.functionName}`)
    const [portal, , recipientCommitment] = call.args
    return { amount, nonce, destination: getAddress(portal), recipientCommitment }
  } catch (error) {
    log.warn(`vault move burn to ${paid} has no portal deposit: ${String(error)}`)
    return undefined
  }
}

/**
 * The vault moves among what `recoverWithdrawals` returned, and the txs of burns a later read
 * reads: the node has not indexed the tx, or its receipt names no block yet.
 */
export async function readVaultMoveBurns(
  recovered: WithdrawalRecoveryResult,
  deps: {
    node: Pick<ObsidionWallet["node"], "getTxEffect" | "getTxReceipt">
    executors: readonly Address[]
  },
): Promise<{ burns: VaultMoveBurn[]; unread: string[] }> {
  const unread = await unindexedFailures(recovered.failures, deps.node)
  const burns: VaultMoveBurn[] = []
  for (const withdrawal of recovered.withdrawals) {
    const move = readVaultMove(withdrawal, deps.executors)
    if (!move) continue
    const { txHash, messageHash } = withdrawal
    const { blockNumber } = await deps.node.getTxReceipt(txHash)
    if (blockNumber === undefined) {
      unread.push(txHash.toString())
      continue
    }
    burns.push({
      ...move,
      txHash: txHash.toString(),
      blockNumber: Number(blockNumber),
      withdrawalId: computeWithdrawalId(txHash, messageHash).toString() as Hex,
    })
  }
  return { burns, unread }
}

/**
 * The account's vault move burns of `portal`'s token through one of `executors`, in L2 blocks
 * `[fromBlock, toBlockExclusive)`. Reading the events syncs PXE first, so a fresh device sees every
 * burn once its sync reaches it.
 */
export async function recoverVaultMoveBurns(args: {
  wallet: ObsidionWallet
  portal: PortalDomain
  owner: AztecAddress
  executors: readonly Address[]
  fromBlock: number
  toBlockExclusive: number
}): Promise<{ burns: VaultMoveBurn[]; unread: string[] }> {
  const node = args.wallet.node
  const recovered = await recoverWithdrawals({
    wallet: args.wallet,
    chain: node,
    portal: args.portal,
    owner: args.owner,
    recoveryEventMetadata: OxideTokenContract.events.WithdrawalRecoveryChunk,
    filter: { fromBlock: BlockNumber(args.fromBlock), toBlock: BlockNumber(args.toBlockExclusive) },
  })
  return readVaultMoveBurns(recovered, { node, executors: args.executors })
}
