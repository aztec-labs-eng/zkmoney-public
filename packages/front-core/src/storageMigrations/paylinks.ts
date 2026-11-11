/**
 * Storage migration: the failed fundings of links older builds kept on transfer rows. Remove when
 * no supported build older than the one that writes `acct/paylinks` v1 remains and the rollup
 * migration moves no links out of legacy rows.
 */
import type { Write } from "../engine/database"
import type { OperationRecord } from "../engine/operationTransition"
import { encodeRecord } from "../engine/persistentStore"
import type { Transaction } from "../types/transactions"

const OPERATIONS = "acct/operations"

/**
 * A create whose funding failed with a hash, and whose operation is gone, keeps that failure as a
 * quiet failed operation, so its link never reads funded off its hash.
 */
export async function carryFailedFundings(w: Write, rows: readonly Transaction[]): Promise<void> {
  for (const row of rows) {
    const { txHash } = row
    if (row.status !== "failed" || !txHash) continue
    // An older build's row may name no operation: the link then joins this one by its hash.
    const operationId = row.operationId ?? `legacy-${row.id}`
    if ((await w.get(`${OPERATIONS}/${operationId}`)) !== undefined) continue
    const at = row.endTime ?? row.timestamp
    const op: OperationRecord = {
      operationId,
      flow: "paylink-create",
      summary: row.description ?? "",
      state: "failed",
      startedAt: row.timestamp,
      txHash,
      endedAt: at,
      readAt: at,
      dismissedAt: at,
    }
    w.put(`${OPERATIONS}/${operationId}`, encodeRecord(op))
  }
}
