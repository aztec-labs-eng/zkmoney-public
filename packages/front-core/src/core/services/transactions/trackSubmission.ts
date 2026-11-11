import { ProvingStage } from "@obsidion/core/types"
import { TxHash, TxStatus } from "@aztec-labs/stdlib/tx"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import type { Hex } from "viem"
import { isRevertedInclusion, type ReorgTxReceiptLike } from "../chain/receiptTypes"
import type { ProvingProgress } from "../../../engine/prover"
import type { ReadonlyStore } from "../../../engine/store"

/** Only node receipt evidence, never a computed hash or a transport error, determines failure. */
export function isFailedSubmission(
  receipt: Pick<ReorgTxReceiptLike, "status" | "executionResult">,
): boolean {
  return receipt.status === TxStatus.DROPPED || isRevertedInclusion(receipt)
}

/**
 * The transaction reached the node but its outcome is unknown. Flows throw this in place of the
 * transport error so callers report the row as pending and let the chain settle it; reporting a
 * failure here is what invites a second payment.
 */
export class TxInFlightError extends Error {
  constructor(readonly txHash: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "TxInFlightError"
  }
}

/**
 * A node refused the transaction because one it holds already spends the same notes, and it
 * refuses every retry until that one lands or expires.
 */
export class PendingTxConflictError extends Error {
  constructor(readonly txHash: Hex, message: string, cause: unknown) {
    super(message, { cause })
    this.name = "PendingTxConflictError"
  }
}

/** The pending transaction a node named when it refused one spending the same notes. */
export function conflictingPendingTx(err: unknown): Hex | undefined {
  for (let e: unknown = err; e !== undefined; e = e instanceof Error ? e.cause : undefined) {
    const hash = /Nullifier conflict with existing tx (0x[0-9a-fA-F]{64})/.exec(
      e instanceof Error ? e.message : String(e),
    )?.[1]
    if (hash) return hash.toLowerCase() as Hex
  }
  return undefined
}

export interface SubmissionTracker {
  /** The hash emitted at the submit boundary; undefined until then. */
  readonly txHash: Hex | undefined
  /**
   * The hash while the transaction may still land, else null: nothing was submitted, or a receipt
   * says dropped or reverted. Never rejects — an unreachable node keeps the hash, because
   * ambiguity resolves in favour of the transaction existing.
   */
  survived(node: Pick<AztecNode, "getTxReceipt">): Promise<Hex | null>
  /** Detach the listener. */
  stop(): void
}

/**
 * Watches one operation across the submit boundary. The wallet awaits the flow's `onTxHash`, which
 * saves the hash on the operation and the flow's own records in one write, then emits
 * `ProvingStage.Mining` with it just before `aztecNode.sendTx`. A rejection before Mining sent
 * nothing; one after it says nothing about whether the transaction reached the node, and only a
 * receipt does.
 */
export function trackSubmission(
  progress: ReadonlyStore<ProvingProgress>,
  operationId: string,
): SubmissionTracker {
  let txHash: Hex | undefined

  // Heard from now on: a stage an earlier try of the operation left is not this one's.
  const off = progress.subscribe(() => {
    const entry = progress.get().stages[operationId]
    if (txHash || entry?.stage !== ProvingStage.Mining || !entry.txHash) return
    txHash = entry.txHash as Hex
  })

  return {
    get txHash() {
      return txHash
    },
    async survived(node) {
      if (!txHash) return null
      try {
        if (isFailedSubmission(await node.getTxReceipt(TxHash.fromString(txHash)))) return null
      } catch {
        // No receipt is not evidence of failure.
      }
      return txHash
    },
    stop: off,
  }
}
