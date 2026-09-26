/**
 * Projection codec for a `PendingTxRecord` through JSON + encrypted storage. The wire shape is the
 * record itself (three JSON primitives). Decoding reads only those keys, so a persisted blob carrying
 * extra fields still yields a record.
 */

import type { PendingTxRecord } from "@obsidion/sdk"

/** Wire shape stored under each record's key. */
export interface SerializedPendingTxRecord {
  readonly txHash: string
  readonly expiresAtMs: number
  readonly submittedAt: number
}

export function encodeRecord(record: PendingTxRecord): SerializedPendingTxRecord {
  return {
    txHash: record.txHash,
    expiresAtMs: record.expiresAtMs,
    submittedAt: record.submittedAt,
  }
}

/** JSON-string form for transport through the storage adapter. */
export function serializeRecord(record: PendingTxRecord): string {
  return JSON.stringify(encodeRecord(record))
}

/** Throws on a malformed wire object; `PendingTxStore.load` drops such entries. */
export function deserializeRecord(json: string): PendingTxRecord {
  return decodeRecord(JSON.parse(json) as SerializedPendingTxRecord)
}

export function decodeRecord(wire: SerializedPendingTxRecord): PendingTxRecord {
  const { txHash, expiresAtMs, submittedAt } = wire
  if (typeof txHash !== "string" || txHash.length === 0) {
    throw new Error("PendingTxRecord: txHash must be a non-empty string")
  }
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(submittedAt)) {
    throw new Error("PendingTxRecord: expiresAtMs and submittedAt must be finite numbers")
  }
  return { txHash, expiresAtMs, submittedAt }
}
