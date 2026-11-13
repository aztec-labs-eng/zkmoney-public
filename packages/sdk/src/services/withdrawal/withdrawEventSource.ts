/**
 * Chain-native source of the wallet's own withdrawals: the recovery events the oxide token delivers to the account,
 * one group per burn, each verified against its tx, with any escrow's args decoded off its memo.
 * `ObsidionWallet.getPrivateEvents` syncs PXE first, so a fresh device sees its whole history once the sync reaches
 * it. Consumed by front-core's `rebuildWithdrawals`.
 */

import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import { createLogger } from "@aztec-labs/foundation/log"
import { recoverWithdrawals } from "@oxide/oxide-client/withdrawal_recovery.js"
import type { WithdrawalRecoveryResult } from "@oxide/oxide-client/withdrawal_recovery.js"
import { computeWithdrawalId } from "@oxide/oxide-lib/hash.js"
import { decodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import type { PortalDomain } from "@oxide/oxide-lib/types.js"
import { getAddress, isAddressEqual, type Address, type Hex } from "viem"
import { OxideTokenContract } from "@obsidion/contracts"
import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import type { WithdrawalExecutor } from "../../oxide/withdrawal/withdrawalExecutor.js"
import {
  decodeWithdrawalMemo,
  memoDerivesEscrow,
  type BridgeWithdrawalMemo,
  type SkyWithdrawalMemo,
  type SwapWithdrawalMemo,
  type WithdrawalMemo,
} from "./withdrawalMemo.js"

const log = createLogger("wallet-sdk:withdraw-events")

/** One recovered withdrawal of the scanned account, through one of its portal's withdrawal executors. */
export interface ScannedWithdrawEvent {
  txHash: string
  blockNumber: number
  /** What the portal keys the withdrawal's release on. */
  withdrawalId: Hex
  /** The executor the burn pays. */
  executor: Address
  /** What that executor takes from the withdrawal. */
  withdrawalFee: bigint
  /** The L1 address the executor pays: the recipient, or the escrow of a swap, a Sky move or a bridge-out. */
  l1Recipient: Address
  /** Raw base-unit amount the burn removed. */
  amount: bigint
  proverTip: bigint
  relayerTip: bigint
  /** The swap the burn funds. Present only when the memo's escrow args derive `l1Recipient`. */
  swap?: SwapWithdrawalMemo
  /** The Sky savings move the burn funds, on the same condition. */
  sky?: SkyWithdrawalMemo
  /** The bridge-out the burn funds, on the same condition. */
  bridge?: BridgeWithdrawalMemo
}

/**
 * A scan's withdrawals, and the L2 txs of those it could not read: the node has not indexed the tx,
 * or the executor's terms did not read. A later scan reads them.
 */
export interface WithdrawScan {
  withdrawals: ScannedWithdrawEvent[]
  unread: string[]
}

export interface WithdrawEventSource {
  headBlock(): Promise<number>
  /** Withdrawals in `[fromBlock, toBlockExclusive)` scoped to the account. */
  listWithdrawals(fromBlock: number, toBlockExclusive: number): Promise<ScannedWithdrawEvent[]>
  /** `listWithdrawals`, with the burns a later scan reads once the node indexes their tx. */
  scanWithdrawals(fromBlock: number, toBlockExclusive: number): Promise<WithdrawScan>
  /** Block timestamp (ms); `undefined` when the block cannot be read. */
  blockTimestampMs(blockNumber: number): Promise<number | undefined>
}

/** `memo` when its escrow's args derive `escrow` from its factory, else no escrow. */
export function memoForEscrow(memo: WithdrawalMemo, escrow: Address): WithdrawalMemo {
  const { swap, sky, bridge } = memo
  const named = swap ? { swap } : sky ? { sky } : bridge ? { bridge } : undefined
  return named && memoDerivesEscrow(named, escrow) ? named : {}
}

/**
 * The failed burns a later scan reads: those whose tx the node has not indexed. One it has indexed
 * will never verify, so it is logged.
 */
export async function unindexedFailures(
  failures: WithdrawalRecoveryResult["failures"],
  node: Pick<ObsidionWallet["node"], "getTxEffect">,
): Promise<string[]> {
  const unread: string[] = []
  for (const { txHash, reason } of failures)
    if (!(await node.getTxEffect(txHash))) unread.push(txHash.toString())
    else log.warn(`burn ${txHash.toString()} does not verify: ${reason}`)
  return unread
}

/**
 * The scan of what `recoverWithdrawals` returned: each burn through an executor of `portal`, and the
 * txs a later scan reads.
 */
export async function readRecoveredWithdrawals(
  recovered: Awaited<ReturnType<typeof recoverWithdrawals>>,
  deps: {
    node: Pick<ObsidionWallet["node"], "getTxEffect" | "getTxReceipt">
    portal: Address
    readExecutor(address: Address): Promise<WithdrawalExecutor>
    /**
     * Told of each burn the moves engine may own: one whose memo names a vault move, which the scan
     * leaves out, and one the scan could not read. It changes nothing the scan returns.
     */
    onSighted?: (txHash: string) => void
  },
): Promise<WithdrawScan> {
  const { node, portal } = deps
  const unread = await unindexedFailures(recovered.failures, node)
  const executors = new Map<Address, Promise<WithdrawalExecutor | "unread">>()
  const scanned: ScannedWithdrawEvent[] = []
  for (const { txHash, messageHash, finalizationData, memo } of recovered.withdrawals) {
    const decoded = decodeWithdrawalMemo(memo)
    // A vault move's burn pays an executor with no plain terms; the moves engine reads it.
    if (decoded.vaultMove) {
      deps.onSighted?.(txHash.toString())
      continue
    }
    const address = getAddress(finalizationData.executor.toString())
    let read = executors.get(address)
    if (!read) {
      read = deps.readExecutor(address).catch((error: unknown) => {
        log.warn(`executor ${address} unread: ${String(error)}`)
        return "unread" as const
      })
      executors.set(address, read)
    }
    const executor = await read
    if (executor === "unread") {
      unread.push(txHash.toString())
      continue
    }
    if (!isAddressEqual(executor.portal, portal)) continue
    const { blockNumber } = await node.getTxReceipt(txHash)
    if (blockNumber === undefined) {
      unread.push(txHash.toString())
      continue
    }
    const { recipient, relayerTip } = decodePlainWithdrawalPayload(finalizationData.userPayload)
    const l1Recipient = getAddress(recipient.toString())
    scanned.push({
      txHash: txHash.toString(),
      blockNumber: Number(blockNumber),
      withdrawalId: computeWithdrawalId(txHash, messageHash).toString() as Hex,
      executor: executor.address,
      withdrawalFee: executor.fee,
      l1Recipient,
      amount: finalizationData.amount,
      proverTip: finalizationData.proverTip,
      relayerTip,
      ...memoForEscrow(decoded, l1Recipient),
    })
  }
  for (const txHash of unread) deps.onSighted?.(txHash)
  return { withdrawals: scanned, unread }
}

export function createWithdrawEventSource(deps: {
  wallet: ObsidionWallet
  portal: PortalDomain
  accountAddress: string
  /** The terms of an executor a burn names. A burn through an executor of another portal is skipped. */
  readExecutor(address: Address): Promise<WithdrawalExecutor>
  onSighted?: (txHash: string) => void
}): WithdrawEventSource {
  const owner = AztecAddress.fromStringUnsafe(deps.accountAddress)
  const node = deps.wallet.node
  const portal = getAddress(deps.portal.l1Portal.toString())
  const scanWithdrawals = async (
    fromBlock: number,
    toBlockExclusive: number,
  ): Promise<WithdrawScan> =>
    readRecoveredWithdrawals(
      await recoverWithdrawals({
        wallet: deps.wallet,
        chain: node,
        portal: deps.portal,
        owner,
        recoveryEventMetadata: OxideTokenContract.events.WithdrawalRecoveryChunk,
        filter: { fromBlock: BlockNumber(fromBlock), toBlock: BlockNumber(toBlockExclusive) },
      }),
      { node, portal, readExecutor: deps.readExecutor, onSighted: deps.onSighted },
    )
  return {
    headBlock: async () => Number(await node.getBlockNumber()),
    scanWithdrawals,
    listWithdrawals: async (fromBlock, toBlockExclusive) =>
      (await scanWithdrawals(fromBlock, toBlockExclusive)).withdrawals,
    async blockTimestampMs(blockNumber) {
      try {
        const block = await node.getBlockData(BlockNumber(blockNumber))
        const ts = block?.header.globalVariables.timestamp
        return ts === undefined ? undefined : Number(ts) * 1000
      } catch {
        return undefined
      }
    },
  }
}
