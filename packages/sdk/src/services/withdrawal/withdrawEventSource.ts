/**
 * Chain-native source of the wallet's own withdrawals: the recovery events the oxide token delivers to the account,
 * one group per burn, each verified against its tx, with any escrow's args decoded off its memo.
 * `ObsidionWallet.getPrivateEvents` syncs PXE first, so a fresh device sees its whole history once the sync reaches
 * it. Consumed by front-core's `rebuildWithdrawals`.
 */

import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import { recoverWithdrawals } from "@oxide/oxide-client/withdrawal_recovery.js"
import { decodePlainWithdrawalPayload } from "@oxide/oxide-lib/plain_withdrawal_executor.js"
import type { PortalDomain } from "@oxide/oxide-lib/types.js"
import { getAddress, isAddressEqual, type Address } from "viem"
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

/** One recovered withdrawal of the scanned account, through one of its portal's withdrawal executors. */
export interface ScannedWithdrawEvent {
  txHash: string
  blockNumber: number
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

export interface WithdrawEventSource {
  headBlock(): Promise<number>
  /** Withdrawals in `[fromBlock, toBlockExclusive)` scoped to the account. */
  listWithdrawals(fromBlock: number, toBlockExclusive: number): Promise<ScannedWithdrawEvent[]>
  /** Block timestamp (ms); `undefined` when the block cannot be read. */
  blockTimestampMs(blockNumber: number): Promise<number | undefined>
}

/** `memo` when its escrow's args derive `escrow` from its factory, else no escrow. */
export function memoForEscrow(memo: WithdrawalMemo, escrow: Address): WithdrawalMemo {
  const { swap, sky, bridge } = memo
  const named = swap ? { swap } : sky ? { sky } : bridge ? { bridge } : undefined
  return named && memoDerivesEscrow(named, escrow) ? named : {}
}

export function createWithdrawEventSource(deps: {
  wallet: ObsidionWallet
  portal: PortalDomain
  accountAddress: string
  /**
   * The terms of an executor a burn names. A burn through an executor of another portal, or one whose
   * terms cannot be read, is skipped; a later scan finds it again.
   */
  readExecutor(address: Address): Promise<WithdrawalExecutor>
}): WithdrawEventSource {
  const owner = AztecAddress.fromStringUnsafe(deps.accountAddress)
  const node = deps.wallet.node
  const portal = getAddress(deps.portal.l1Portal.toString())
  return {
    headBlock: async () => Number(await node.getBlockNumber()),
    async listWithdrawals(fromBlock, toBlockExclusive) {
      // A burn whose recovery data does not verify is not the wallet's to show.
      const { withdrawals } = await recoverWithdrawals({
        wallet: deps.wallet,
        chain: node,
        portal: deps.portal,
        owner,
        recoveryEventMetadata: OxideTokenContract.events.WithdrawalRecoveryChunk,
        filter: { fromBlock: BlockNumber(fromBlock), toBlock: BlockNumber(toBlockExclusive) },
      })
      const executors = new Map<Address, Promise<WithdrawalExecutor | undefined>>()
      const scanned: ScannedWithdrawEvent[] = []
      for (const { txHash, finalizationData, memo } of withdrawals) {
        const address = getAddress(finalizationData.executor.toString())
        let read = executors.get(address)
        if (!read) {
          read = deps.readExecutor(address).catch(() => undefined)
          executors.set(address, read)
        }
        const executor = await read
        if (!executor || !isAddressEqual(executor.portal, portal)) continue
        const { blockNumber } = await node.getTxReceipt(txHash)
        if (blockNumber === undefined) continue
        const { recipient, relayerTip } = decodePlainWithdrawalPayload(finalizationData.userPayload)
        const l1Recipient = getAddress(recipient.toString())
        scanned.push({
          txHash: txHash.toString(),
          blockNumber: Number(blockNumber),
          executor: executor.address,
          withdrawalFee: executor.fee,
          l1Recipient,
          amount: finalizationData.amount,
          proverTip: finalizationData.proverTip,
          relayerTip,
          ...memoForEscrow(decodeWithdrawalMemo(memo), l1Recipient),
        })
      }
      return scanned
    },
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
