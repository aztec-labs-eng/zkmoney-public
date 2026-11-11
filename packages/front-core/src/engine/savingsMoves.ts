import type { Address, Hex } from "viem"
import type { SavingsMoveRecord } from "../core/services/savings/types"
import {
  KEY_SAVINGS_MOVES,
  legacySavingsMoves,
  migrateSavingsMoves,
} from "../storageMigrations/savingsMoves"
import { logger } from "../utils/logger"
import type { Database } from "./database"
import { WalletError } from "./errors"
import { decodeRecord, loadRecords, type RecordSet } from "./persistentStore"
import type { ReadonlyStore } from "./store"
import { strictRecords } from "./strictRecords"

const PREFIX = "acct/savingsMoves"

/**
 * The moves this account made, one per burn's withdrawal record. A move holds funds in flight: a
 * saved move that does not read fails the load, and every read and write rejects while it does.
 * Writes resolve once committed.
 */
export interface SavingsMoves {
  readonly ready: Promise<void>
  readonly view: ReadonlyStore<RecordSet<SavingsMoveRecord>>
  /** Every move once read; rejects while the saved moves do not read. */
  all(): Promise<readonly SavingsMoveRecord[]>
  get(withdrawalLocalId: string): Promise<SavingsMoveRecord | null>
  put(record: SavingsMoveRecord): Promise<SavingsMoveRecord>
  /**
   * Read-modify-write of one move; `change` returns null to leave it as it is. Resolves to what the
   * store holds afterwards.
   */
  update(
    withdrawalLocalId: string,
    change: (current: SavingsMoveRecord | null) => SavingsMoveRecord | null,
  ): Promise<SavingsMoveRecord | null>
  /** Drops a move whose burn never went out. */
  remove(withdrawalLocalId: string): Promise<void>
}

/** Newest first. */
export const newestMovesFirst = (moves: readonly SavingsMoveRecord[]): SavingsMoveRecord[] =>
  [...moves].sort((a, b) => b.startTime - a.startTime)

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)

const isSavingsMove = (value: unknown): value is SavingsMoveRecord =>
  isObj(value) &&
  typeof value.withdrawalLocalId === "string" &&
  (value.direction === "in" || value.direction === "out") &&
  typeof value.startTime === "number" &&
  Number.isFinite(value.startTime)

/** A saved move, or a throw that fails the read. */
export function savingsMoveOf(value: unknown, key: string): SavingsMoveRecord {
  if (!isSavingsMove(value)) throw new WalletError("unknown", `Savings move ${key} is damaged`)
  return value
}

function decoded(raw: string): unknown {
  try {
    return decodeRecord(raw)
  } catch {
    return undefined // the decode boundary: a retired database's damaged move is skipped
  }
}

export function createSavingsMoves({ db }: { db: Database }): SavingsMoves {
  const store = strictRecords<SavingsMoveRecord>(db, {
    prefix: PREFIX,
    field: "withdrawalLocalId",
    check: savingsMoveOf,
    migrate: (from, w, ids) => migrateSavingsMoves(from, w, ids, savingsMoveOf),
  })
  return {
    ready: store.ready,
    view: store.view,
    all: () => loadRecords(store.view),
    get: (id) => store.get(id),
    async put(record) {
      await store.update(record.withdrawalLocalId, () => record)
      return record
    },
    update: (id, change) => store.update(id, change),
    async remove(id) {
      await store.removeIf(id, () => true)
    },
  }
}

/**
 * The moves a database no Savings move store is open on holds, such as a retired rollup's: this
 * store's records, then the blob's records it lacks. A move that does not read is skipped, so one
 * damaged move never stops an import.
 */
export function storedSavingsMoves(db: {
  get(key: string): string | null | undefined
  keys(prefix: string): string[]
}): SavingsMoveRecord[] {
  const out = new Map<string, SavingsMoveRecord>()
  let skipped = 0
  const keep = (record: unknown) => {
    if (!isSavingsMove(record)) skipped++
    else if (!out.has(record.withdrawalLocalId.toLowerCase()))
      out.set(record.withdrawalLocalId.toLowerCase(), record)
  }
  for (const k of db.keys(`${PREFIX}/`)) {
    const raw = db.get(k)
    if (typeof raw === "string") keep(decoded(raw))
  }
  for (const record of legacySavingsMoves(db.get(KEY_SAVINGS_MOVES))) keep(record)
  if (skipped) logger.warn(`[savingsMoves] a retired database holds ${skipped} damaged move(s)`)
  return [...out.values()]
}

/**
 * Marks recovered each retired move whose deposit a refund to `to` in `txHash` returned. A leaf
 * index names a deposit only within its rollup's Inbox, so the amount must match too.
 */
export async function noteRefundedSavingsMoves(
  moves: Pick<SavingsMoves, "all" | "update">,
  deposits: readonly { leafIndex: string; amount: string }[],
  to: Address,
  txHash: Hex,
): Promise<void> {
  if (!deposits.length) return
  const refunded = ({ retired, recovered, deposit }: SavingsMoveRecord) =>
    !!retired &&
    !recovered &&
    !!deposit &&
    deposits.some((d) => d.leafIndex === deposit.inboxIndex && d.amount === deposit.amount)
  for (const move of await moves.all())
    if (refunded(move))
      await moves.update(move.withdrawalLocalId, (current) =>
        current && refunded(current) ? { ...current, recovered: { to, txHashes: [txHash] } } : null,
      )
}
