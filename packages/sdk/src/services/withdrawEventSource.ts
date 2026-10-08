/**
 * Chain-native source of the wallet's own `Withdraw` events: the account-scoped private events of
 * the oxide token, one per burn the account made, with the swap escrow args decoded off `meta`.
 * `ObsidionWallet.getPrivateEvents` syncs PXE first, so a fresh device sees its whole history once
 * the sync reaches it. Consumed by front-core's `rebuildWithdrawals`.
 */

import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { BlockNumber } from "@aztec/foundation/branded-types"
import { predictSwapEscrowAddressLocally } from "@oxide/l1-contracts"
import type { Address } from "viem"
import { OxideTokenContract, type Withdraw as WithdrawEvent } from "@obsidion/contracts"
import type { ObsidionWallet } from "../obsidion/ObsidionWallet.js"
import { swapRouteForOutput } from "../oxide/swapOnWithdraw.js"
import {
  decodeWithdrawMeta,
  type SwapWithdrawMeta,
  type WithdrawGroupMeta,
} from "./withdrawMeta.js"

/** One decoded `Withdraw` event of the scanned account. */
export interface ScannedWithdrawEvent {
  txHash: string
  blockNumber: number
  /** The L1 address the burn pays: the recipient, or the escrow on a swap. Absent when the meta
   *  does not name it. */
  l1Recipient?: Address
  /** Raw base-unit amount the burn removed. */
  amount: bigint
  /** The swap the burn funds. Present only when the meta's escrow args reproduce `l1Recipient`. */
  swap?: SwapWithdrawMeta
  /** The fresh-address withdrawal the burn belongs to, as its meta labels it. */
  group?: WithdrawGroupMeta
}

export interface WithdrawEventSource {
  headBlock(): Promise<number>
  /** Events in `[fromBlock, toBlockExclusive)` scoped to the account. */
  listWithdrawals(fromBlock: number, toBlockExclusive: number): Promise<ScannedWithdrawEvent[]>
  /** Block timestamp (ms); `undefined` when the block cannot be read. */
  blockTimestampMs(blockNumber: number): Promise<number | undefined>
}

/**
 * `swap` when its args derive `escrow` from its factory, else undefined: the meta is what the
 * wallet asserted at burn time, and only args the burn actually paid into are worth acting on.
 */
export function swapMetaForEscrow(
  swap: SwapWithdrawMeta | undefined,
  escrow: Address,
): SwapWithdrawMeta | undefined {
  if (!swap) return undefined
  const predicted = predictSwapEscrowAddressLocally(swap.factory, {
    route: swapRouteForOutput(swap.output),
    recipient: swap.recipient,
    recoveryCommitment: swap.recoveryCommitment,
    relayerTip: swap.relayerTip,
    nonce: swap.nonce,
  })
  return predicted.toLowerCase() === escrow.toLowerCase() ? swap : undefined
}

export function createWithdrawEventSource(deps: {
  wallet: ObsidionWallet
  tokenAddress: string
  accountAddress: string
}): WithdrawEventSource {
  const contractAddress = AztecAddress.fromStringUnsafe(deps.tokenAddress)
  const scope = AztecAddress.fromStringUnsafe(deps.accountAddress)
  return {
    headBlock: async () => Number(await deps.wallet.node.getBlockNumber()),
    async listWithdrawals(fromBlock, toBlockExclusive) {
      const events = await deps.wallet.getPrivateEvents<WithdrawEvent>(
        OxideTokenContract.events.Withdraw,
        {
          contractAddress,
          fromBlock: BlockNumber(fromBlock),
          toBlock: BlockNumber(toBlockExclusive),
          scopes: [scope],
        },
      )
      return events.map(({ event, metadata }): ScannedWithdrawEvent => {
        const meta = decodeWithdrawMeta(event.meta)
        return {
          txHash: metadata.txHash.toString(),
          blockNumber: Number(metadata.l2BlockNumber),
          l1Recipient: meta.recipient,
          amount: BigInt(event.amount),
          swap: meta.recipient ? swapMetaForEscrow(meta.swap, meta.recipient) : undefined,
          group: meta.group,
        }
      })
    },
    async blockTimestampMs(blockNumber) {
      try {
        const block = await deps.wallet.node.getBlockData(BlockNumber(blockNumber))
        const ts = block?.header.globalVariables.timestamp
        return ts === undefined ? undefined : Number(ts) * 1000
      } catch {
        return undefined
      }
    },
  }
}
