/**
 * Chain-native source of the account's `Transfer` events, both received and sent (the token
 * delivers each transfer to both parties): reads the account-scoped private events of the oxide
 * token and decodes their `meta`. `ObsidionWallet.getPrivateEvents` syncs
 * PXE first, so each scan is also the note-discovery trigger. Consumed by front-core's
 * `TransferEventScanner`.
 */

import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { BlockNumber } from "@aztec/foundation/branded-types"
import { OxideTokenContract, type Transfer as TransferEvent } from "@obsidion/contracts"
import type { ObsidionWallet } from "../obsidion/ObsidionWallet.js"
import type { PrivateEvent } from "@aztec/aztec.js/wallet"
import { decodeTransferMeta, type PaylinkCreatedMeta } from "./transferMeta.js"

/** One decoded `Transfer` event addressed to the scanned account. */
export interface ScannedTransferEvent {
  txHash: string
  from: string
  to: string
  /** Raw base-unit amount. */
  amount: string
  blockNumber: number
  requestId?: string
  senderTag?: string
  recipientTag?: string
  memo?: string
  /** On an escrow's funding transfer: the link it escrows (see `PaylinkService.recoverPaylinkFromTransfer`). */
  paylinkCreated?: PaylinkCreatedMeta
}

export interface WalletSyncSnapshot {
  events: ScannedTransferEvent[]
  balance: bigint
  anchorBlock: number
}

export interface WalletSyncSource extends TransferEventSource {
  readSnapshot(fromBlock: number, toBlockExclusive: number): Promise<WalletSyncSnapshot>
}

export interface TransferEventSource {
  headBlock(): Promise<number>
  /** Events in `[fromBlock, toBlockExclusive)` scoped to the account. */
  listIncoming(fromBlock: number, toBlockExclusive: number): Promise<ScannedTransferEvent[]>
  /** Block timestamp (ms); `undefined` falls back to the scan time. */
  blockTimestampMs?(blockNumber: number): Promise<number | undefined>
  /**
   * PXE's synced block — the highest block whose events `listIncoming` can actually see. The
   * scanner never persists its cursor past this. 0 before the first sync; rejects on an
   * operational fault so the tick fails and backs off. Absent means head is authoritative.
   */
  anchorBlock?(): Promise<number>
}

export function createTransferEventSource(deps: {
  wallet: ObsidionWallet
  tokenAddress: string
  accountAddress: string
}): TransferEventSource {
  const contractAddress = AztecAddress.fromStringUnsafe(deps.tokenAddress)
  const scope = AztecAddress.fromStringUnsafe(deps.accountAddress)
  return {
    headBlock: async () => Number(await deps.wallet.node.getBlockNumber()),
    async listIncoming(fromBlock, toBlockExclusive) {
      const events = await deps.wallet.getPrivateEvents<TransferEvent>(
        OxideTokenContract.events.Transfer,
        {
          contractAddress,
          fromBlock: BlockNumber(fromBlock),
          toBlock: BlockNumber(toBlockExclusive),
          scopes: [scope],
        },
      )
      return events.map(decodeEvent)
    },
    async anchorBlock() {
      try {
        const header = await deps.wallet.pxe.getSyncedBlockHeader()
        return Number(header.globalVariables.blockNumber.toString())
      } catch (err) {
        // PXE throws this shape only before the first sync ("not-yet-synchronized PXE"); anything
        // else is a real store/backend fault and must fail the tick, not masquerade as anchor 0.
        if (err instanceof Error && err.message.includes("not-yet-synchronized")) return 0
        throw err
      }
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

/** Events and balance verified against the same PXE header, without changing event-only callers. */
export function createWalletSyncSource(deps: {
  wallet: ObsidionWallet
  tokenAddress: string
  accountAddress: string
  readBalance: () => Promise<bigint>
}): WalletSyncSource {
  return {
    ...createTransferEventSource(deps),
    async readSnapshot(fromBlock, toBlockExclusive) {
      const { events, projection, anchorBlock } = await deps.wallet.getPrivateEventsSnapshot<
        TransferEvent,
        bigint
      >(
        OxideTokenContract.events.Transfer,
        {
          contractAddress: AztecAddress.fromStringUnsafe(deps.tokenAddress),
          fromBlock: BlockNumber(fromBlock),
          toBlock: BlockNumber(toBlockExclusive),
          scopes: [AztecAddress.fromStringUnsafe(deps.accountAddress)],
        },
        deps.readBalance,
      )
      return {
        events: events.map(decodeEvent),
        balance: projection,
        anchorBlock,
      }
    },
  }
}

function decodeEvent({ event, metadata }: PrivateEvent<TransferEvent>): ScannedTransferEvent {
  return {
    txHash: metadata.txHash.toString(),
    from: event.from.toString(),
    to: event.to.toString(),
    amount: BigInt(event.amount).toString(),
    blockNumber: Number(metadata.l2BlockNumber),
    ...decodeTransferMeta(event.meta),
  }
}
