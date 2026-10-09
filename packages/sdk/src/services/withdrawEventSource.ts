/**
 * Chain-native source of the wallet's own `Withdraw` events: the account-scoped private events of
 * the oxide token, one per burn the account made, with any escrow's args decoded off `meta`.
 * `ObsidionWallet.getPrivateEvents` syncs PXE first, so a fresh device sees its whole history once
 * the sync reaches it. Consumed by front-core's `rebuildWithdrawals`.
 */

import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { BlockNumber } from "@aztec/foundation/branded-types"
import { predictSkyEscrowAddressLocally } from "@oxide/experiments/sky/sky_savings.js"
import type { Address } from "viem"
import { OxideTokenContract, type Withdraw as WithdrawEvent } from "@obsidion/contracts"
import type { ObsidionWallet } from "../obsidion/ObsidionWallet.js"
import {
  predictSwapEscrow,
  swapRouteForOutput,
  type SwapEscrowCommitment,
  type SwapEscrowLayout,
} from "../oxide/swapOnWithdraw.js"
import {
  decodeWithdrawMeta,
  type SkyWithdrawMeta,
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
  swap?: ScannedSwap
  /** The Sky savings move the burn funds, on the same condition. */
  sky?: SkyWithdrawMeta
  /** The fresh-address withdrawal the burn belongs to, as its meta labels it. */
  group?: WithdrawGroupMeta
}

/** A swap meta whose args derive the escrow the burn paid, in the factory layout that derives it. */
export interface ScannedSwap extends SwapWithdrawMeta {
  layout: SwapEscrowLayout
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
 * wallet asserted at burn time, and only args the burn actually paid into are worth acting on. A
 * burn to a factory without `daiForGas` derives its escrow from the legacy layout.
 */
export function swapMetaForEscrow(
  swap: SwapWithdrawMeta | undefined,
  escrow: Address,
): ScannedSwap | undefined {
  if (!swap) return undefined
  const args = {
    route: swapRouteForOutput(swap.output),
    recipient: swap.recipient,
    recoveryCommitment: swap.recoveryCommitment,
    relayerTip: swap.relayerTip,
    nonce: swap.nonce,
  }
  const layouts: SwapEscrowCommitment[] = [
    { layout: "v2", args: { ...args, daiForGas: swap.daiForGas, minEthForGas: swap.minEthForGas } },
  ]
  if (swap.daiForGas === 0n && swap.minEthForGas === 0n) layouts.push({ layout: "legacy", args })
  const match = layouts.find(
    (commitment) =>
      predictSwapEscrow(swap.factory, commitment).toLowerCase() === escrow.toLowerCase(),
  )
  return match ? { ...swap, layout: match.layout } : undefined
}

/** `sky` when its args derive `escrow` from its factory, else undefined, as for a swap. */
export function skyMetaForEscrow(
  sky: SkyWithdrawMeta | undefined,
  escrow: Address,
): SkyWithdrawMeta | undefined {
  if (!sky) return undefined
  const predicted = predictSkyEscrowAddressLocally(sky.factory, sky)
  return predicted.toLowerCase() === escrow.toLowerCase() ? sky : undefined
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
          sky: meta.recipient ? skyMetaForEscrow(meta.sky, meta.recipient) : undefined,
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
