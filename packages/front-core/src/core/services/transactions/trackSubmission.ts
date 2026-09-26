import {
  provingProgress,
  ProvingStage,
  type ProvingProgressEvent,
} from "@obsidion/proving-progress"
import { TxHash, TxStatus } from "@aztec/stdlib/tx"
import type { AztecNode } from "@aztec/stdlib/interfaces/client"
import type { Hex } from "viem"
import { isRevertedInclusion, type ReorgTxReceiptLike } from "../chain/receiptTypes"

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

export interface SubmissionTracker {
  /** The hash emitted at the submit boundary; undefined until then. */
  readonly txHash: Hex | undefined
  /**
   * The hash while the transaction may still land, else null: nothing was submitted, or a receipt
   * says dropped or reverted. Never rejects — an unreachable node keeps the hash, because
   * ambiguity resolves in favour of the transaction existing.
   */
  survived(node: Pick<AztecNode, "getTxReceipt">): Promise<Hex | null>
  /** Whether `onSubmitted` stored the hash; false before the boundary or after a failed write. */
  saved(): Promise<boolean>
  /** Detach the listener and settle any in-flight `onSubmitted` write. */
  stop(): Promise<void>
}

/**
 * Watches one operation across the submit boundary. The wallet emits `ProvingStage.Mining` with
 * the real hash just before `aztecNode.sendTx`, so a rejection after it says nothing about whether
 * the transaction reached the node; only a receipt does. `onSubmitted` runs once at the boundary
 * to stamp the hash onto the caller's row; its rejection is swallowed, since a storage failure
 * must not fail a transaction that may be on chain. A save that lands is announced as
 * `tx-hash-saved`: this is the one place a flow's record becomes safe to reload over. An operation
 * that owns several records announces from one tracker whose `onSubmitted` awaits them all; the
 * others pass `announce: false`.
 */
export function trackSubmission(
  operationId: string,
  onSubmitted?: (txHash: Hex) => unknown,
  opts: { announce?: boolean } = {},
): SubmissionTracker {
  let txHash: Hex | undefined
  let write: Promise<boolean> = Promise.resolve(false)

  const onMining = (event: ProvingProgressEvent) => {
    if (event.operationId !== operationId || event.stage !== ProvingStage.Mining || !event.txHash)
      return
    if (txHash) return
    const hash = event.txHash as Hex
    txHash = hash
    if (!onSubmitted) return
    write = (async () => onSubmitted(hash))().then(
      () => {
        if (opts.announce !== false) provingProgress.emitTxHashSaved(operationId, hash)
        return true
      },
      () => false,
    )
  }
  provingProgress.on("stage-start", onMining)

  return {
    get txHash() {
      return txHash
    },
    async survived(node) {
      await write
      if (!txHash) return null
      try {
        if (isFailedSubmission(await node.getTxReceipt(TxHash.fromString(txHash)))) return null
      } catch {
        // No receipt is not evidence of failure.
      }
      return txHash
    },
    saved() {
      return write
    },
    async stop() {
      provingProgress.off("stage-start", onMining)
      await write
    },
  }
}
