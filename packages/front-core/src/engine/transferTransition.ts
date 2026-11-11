import { QueueStatus } from "@obsidion/core/constants"
import type { Transaction, TransactionStatus } from "../types/transactions"

/**
 * What changes a transfer row's status or its reorg anchors. The chain writes `confirmed`,
 * `demoted` and `anchored`; the v4 migration writes `interrupted` on an older build's own row that
 * never got its hash. `epoch` is the row's `reorgEpoch` when the writer read it; absent, it is 0,
 * where every row starts.
 */
export type TransferEvent =
  | { type: "interrupted" }
  | {
      type: "confirmed"
      at: number
      status: QueueStatus.SUCCESS | QueueStatus.FAILED
      epoch?: number
    }
  | { type: "demoted"; at: number; terminal?: "failed" }
  | { type: "anchored"; tier: Transaction["tier"]; blockNumber?: number; blockHash?: string }

/**
 * The one place a row's status and anchors change; `undefined` leaves it as it is.
 * - A cancelled row never changes.
 * - A `confirmed` from another epoch than the row's is ignored, so a write a reorg overtook never
 *   lands.
 * - A row succeeds only with a hash.
 */
export function transferTransition(
  row: Transaction,
  event: TransferEvent,
): Transaction | undefined {
  if (row.detailedStatus === QueueStatus.CANCELLED) return undefined
  const epoch = row.reorgEpoch ?? 0
  if (FENCED.has(event.type) && ((event as { epoch?: number }).epoch ?? 0) !== epoch) {
    return undefined
  }
  switch (event.type) {
    case "interrupted":
      if (row.status !== "pending" || row.txHash) return undefined
      return {
        ...row,
        status: "failed",
        detailedStatus: QueueStatus.FAILED,
        failure: { code: "tx.interrupted" },
      }
    case "confirmed":
      if (event.status === QueueStatus.SUCCESS && !row.txHash) return undefined
      return {
        ...row,
        ...ended(event.status === QueueStatus.SUCCESS ? "success" : "failed", event.at),
      }
    case "demoted":
      return event.terminal === "failed"
        ? { ...row, ...ended("failed", event.at), reorgEpoch: epoch + 1 }
        : {
            ...row,
            status: "pending",
            detailedStatus: QueueStatus.PENDING,
            endTime: undefined,
            reorgEpoch: epoch + 1,
          }
    case "anchored":
      return {
        ...row,
        tier: event.tier,
        blockNumber: event.blockNumber ?? row.blockNumber,
        blockHash: event.blockHash ?? row.blockHash,
      }
  }
}

// eslint-disable-next-line no-restricted-syntax -- debt
const FENCED = new Set<TransferEvent["type"]>(["confirmed"])

/** The fields only `transferTransition` writes. */
const OWNED = [
  "status",
  "detailedStatus",
  "progress",
  "endTime",
  "failure",
  "txHash",
  "reorgEpoch",
  "tier",
  "blockNumber",
  "blockHash",
]

/** `next` with `row`'s fields that only `transferTransition` writes. */
export function keepOwned(row: Transaction, next: Transaction): Transaction {
  const out: Record<string, unknown> = { ...next }
  const from = row as Record<string, unknown>
  for (const field of OWNED) {
    if (field in from) out[field] = from[field]
    else delete out[field]
  }
  return out as Transaction
}

function ended(status: TransactionStatus, at: number) {
  return {
    status,
    detailedStatus: status === "success" ? QueueStatus.SUCCESS : QueueStatus.FAILED,
    progress: 100,
    endTime: at,
  }
}
