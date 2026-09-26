// Shared receipt shape for reorg-aware code. Receipts stay structural — platform layers adapt a
// real node client to ReorgNodeLike.

import { TxExecutionResult, TxStatus } from "@aztec/stdlib/tx"

/** Tx receipt as reorg code consumes it. `status` may carry unknown future values. */
export interface ReorgTxReceiptLike {
  status: TxStatus
  blockNumber?: number
  blockHash?: string
  /**
   * Execution outcome of an included/finalized tx. "reverted" is terminal-failed regardless of
   * tier; undefined (adapter lacks the field) can never vouch a failed row back to SUCCESS.
   */
  executionResult?: TxExecutionResult
}

/** Tiers where the tx is in a block (reorg-able until finalized). */
export const INCLUDED_TIERS: ReadonlySet<TxStatus> = new Set([
  TxStatus.PROPOSED,
  TxStatus.CHECKPOINTED,
  TxStatus.PROVEN,
])

/** Included/finalized but the tx itself failed on-chain — terminal regardless of tier. */
export function isRevertedInclusion(receipt: ReorgTxReceiptLike): boolean {
  const status = receipt.status
  return (
    receipt.executionResult === TxExecutionResult.REVERTED &&
    (status === TxStatus.FINALIZED || INCLUDED_TIERS.has(status))
  )
}

/**
 * The receipt's block differs from the last-known anchor — the tx moved to a new block.
 * Hash is compared as well as number: after a reorg the sequencer typically re-includes the
 * tx at the SAME height on the new chain, which only the hash reveals.
 */
export function hasBlockMoved(
  stored: { blockNumber?: number; blockHash?: string },
  fromReceipt: { blockNumber?: number; blockHash?: string },
): boolean {
  const numberMoved =
    stored.blockNumber !== undefined &&
    fromReceipt.blockNumber !== undefined &&
    stored.blockNumber !== fromReceipt.blockNumber
  const hashMoved =
    stored.blockHash !== undefined &&
    fromReceipt.blockHash !== undefined &&
    stored.blockHash !== fromReceipt.blockHash
  return numberMoved || hashMoved
}

/** Minimal node surface for receipt lookups. */
export interface ReorgNodeLike {
  getTxReceipt(txHash: string): Promise<ReorgTxReceiptLike>
}
