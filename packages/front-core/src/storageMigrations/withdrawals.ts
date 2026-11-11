/**
 * Storage migration: older builds' withdrawals, from the legacy blob. Remove when no supported build
 * older than the one that writes `acct/withdrawals` v1 remains and the rollup migration
 * reads no withdrawal blob.
 */
import type { WithdrawalPhase, WithdrawalRecord } from "../core/services/bridge/types"
import type { Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { encodeRecord } from "../engine/persistentStore"
import { withdrawalFailure } from "../engine/withdrawalTransition"

/** The blob older builds kept every withdrawal in, one JSON object keyed by lowercase `localId`. */
export const KEY_WITHDRAWALS = "@obsidion/withdrawals/records"

/** Records stored without `tokenDecimals` all burned an 18-decimal token. */
const UNSTAMPED_TOKEN_DECIMALS = 18

const PHASE_RANK: Record<WithdrawalPhase, number> = {
  submitting: 0,
  l2_mined: 1,
  awaiting_proven: 2,
  finalizing_l1: 3,
  swapping: 4,
  bridging: 5,
  recoverable: 6,
  failed: 7,
  recovered: 8,
  done: 9,
}

/** Two saved copies of one record: the furthest phase, and every field either one learned. */
function merge(existing: WithdrawalRecord, incoming: WithdrawalRecord): WithdrawalRecord {
  const phase =
    PHASE_RANK[incoming.phase] >= PHASE_RANK[existing.phase] ? incoming.phase : existing.phase
  return {
    ...existing,
    ...incoming,
    localId: existing.localId,
    phase,
    l2TxHash: incoming.l2TxHash ?? existing.l2TxHash,
    blockNumber: incoming.blockNumber ?? existing.blockNumber,
    rawAmount: incoming.rawAmount ?? existing.rawAmount,
    relayerTip: incoming.relayerTip ?? existing.relayerTip,
    withdrawalFee: incoming.withdrawalFee ?? existing.withdrawalFee,
    withdrawalId: incoming.withdrawalId ?? existing.withdrawalId,
    l1TxHash: incoming.l1TxHash ?? existing.l1TxHash,
    receivedAmount: incoming.receivedAmount ?? existing.receivedAmount,
    finalizeTxHash: incoming.finalizeTxHash ?? existing.finalizeTxHash,
    failure: incoming.failure ?? existing.failure,
    endTime:
      existing.endTime != null && incoming.endTime != null
        ? Math.max(existing.endTime, incoming.endTime)
        : incoming.endTime ?? existing.endTime,
    phaseEnteredAt: incoming.phaseEnteredAt ?? existing.phaseEnteredAt,
  }
}

/** A record as this version keeps it: a stored `error` text becomes its `failure`. */
function withFailure(record: WithdrawalRecord): WithdrawalRecord {
  const { error, ...rest } = record as WithdrawalRecord & { error?: unknown }
  if (typeof error !== "string" || rest.failure) return rest
  return { ...rest, failure: withdrawalFailure(error) }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The records a `KEY_WITHDRAWALS` blob holds, keyed by `key`, the store's id; copies of one record
 * merge. A malformed blob holds none.
 */
export function decodeWithdrawals(
  raw: string | null | undefined,
  key: (id: string) => string,
): [string, WithdrawalRecord][] {
  let parsed: unknown
  try {
    parsed = raw === null || raw === undefined ? undefined : JSON.parse(raw)
  } catch {
    return []
  }
  if (!isRecord(parsed)) return []
  const out = new Map<string, WithdrawalRecord>()
  for (const value of Object.values(parsed)) {
    if (!isRecord(value) || typeof value.localId !== "string" || typeof value.phase !== "string")
      continue
    const stored = withFailure(value as unknown as WithdrawalRecord)
    const record =
      stored.tokenDecimals === undefined
        ? { ...stored, tokenDecimals: UNSTAMPED_TOKEN_DECIMALS }
        : stored
    const id = key(record.localId)
    const held = out.get(id)
    out.set(id, held ? merge(held, record) : record)
  }
  return [...out]
}

/**
 * The first open imports the blob, each `error` text as its `failure`; a record saved under the
 * store already wins.
 */
export async function migrateWithdrawals(
  from: number | undefined,
  w: Write,
  { prefix, key }: { prefix: string; key: (id: string) => string },
): Promise<void> {
  if (from !== undefined) throw new WalletError("invariant", `withdrawals: unknown version ${from}`)
  // A withdrawal can be funds in flight: every record carries over. The blob stays for a rollback.
  const records = decodeWithdrawals(await w.get(KEY_WITHDRAWALS), key)
  const saved = await w.getMany(records.map(([id]) => `${prefix}/${id}`))
  records.forEach(([id, record], i) => {
    if (saved[i] === undefined) w.put(`${prefix}/${id}`, encodeRecord(record))
  })
}
