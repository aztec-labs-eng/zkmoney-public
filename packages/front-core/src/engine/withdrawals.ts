import {
  WITHDRAWAL_RECORD_VERSION,
  WITHDRAWAL_TERMINAL_PHASES,
  type WithdrawalRecord,
} from "../core/services/bridge/types"
import type { OnNetwork } from "../types/networkStamp"
import type { Database, Write } from "./database"
import { decodeRecord, loadRecords, persistentStore } from "./persistentStore"
import type { Loaded } from "./recordSource"
import { derived, type ReadonlyStore } from "./store"
import {
  decodeWithdrawals,
  KEY_WITHDRAWALS,
  migrateWithdrawals,
} from "../storageMigrations/withdrawals"
import {
  withdrawalTransition,
  type BurnExecutor,
  type WithdrawalEvent,
} from "./withdrawalTransition"

/** Longest a pre-mine `submitting` row may sit before it counts as interrupted; proving takes minutes. */
export const WITHDRAWAL_SUBMIT_TIMEOUT_MS = 10 * 60 * 1000

/** Fresh `wdraw_*` key for a record created at `at`, such as at Confirm. */
export function newWithdrawalLocalId(at: number): string {
  return `wdraw_${at.toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export interface WithdrawalsDeps {
  /** The account's database. */
  db: Database
  now: () => number
}

/**
 * The account's withdrawals, one record each, keyed by lowercase `localId`; the burn's `l2TxHash`
 * also resolves to its record. A record changes only through `withdrawalTransition`. Every record
 * loads; reads hold saved records only. A write without `w` commits on its own and resolves once
 * saved; with one, it joins that transaction.
 */
export interface Withdrawals {
  /** Saved records, newest first; `hydrated` once they loaded. */
  readonly list: ReadonlyStore<Loaded<WithdrawalRecord>>
  /** The first read finished, even if it failed. */
  readonly settled: ReadonlyStore<boolean>
  readonly ready: Promise<void>
  /** Every record, read once. */
  all(): Promise<readonly WithdrawalRecord[]>
  /** By `localId` or burn hash. */
  get(keyOrHash: string, w?: Write): Promise<WithdrawalRecord | undefined>
  byHash(l2TxHash: string, w?: Write): Promise<WithdrawalRecord | undefined>
  /** Saves `record` whole, stamped with the record version and its network. */
  create(record: OnNetwork<WithdrawalRecord>, w?: Write): Promise<WithdrawalRecord>
  /** Saves a record read off chain or another database, unless one holds its id or burn hash. */
  adopt(
    record: OnNetwork<WithdrawalRecord>,
  ): Promise<{ record: WithdrawalRecord; adopted: boolean }>
  /** The record when `event` changed it. */
  apply(keyOrHash: string, event: WithdrawalEvent, w?: Write): Promise<WithdrawalRecord | undefined>
  remove(keyOrHash: string, w?: Write): Promise<void>
  /** Fails `submitting` rows with no hash older than `maxAgeMs`; the tab that proved them closed. */
  failInterrupted(now: number, maxAgeMs: number): Promise<WithdrawalRecord[]>
  /**
   * Stamps version 1 records with their burn's executor as `burnOf` reads it. A record that names
   * a deployment `burnOf` does not know stays for the next pass.
   */
  migrateExecutors(
    burnOf: (record: WithdrawalRecord) => BurnExecutor | undefined,
  ): Promise<WithdrawalRecord[]>
}

const PREFIX = "acct/withdrawals"

const key = (id: string) => id.toLowerCase()

/**
 * The withdrawals a database no withdrawal store is open on holds, such as a retired rollup's: this
 * store's records, then the blob's records it lacks.
 */
export function storedWithdrawals(db: {
  get(key: string): string | null | undefined
  keys(prefix: string): string[]
}): WithdrawalRecord[] {
  const out = new Map<string, WithdrawalRecord>()
  for (const k of db.keys(`${PREFIX}/`)) {
    const raw = db.get(k)
    if (raw === null || raw === undefined) continue
    const record = decodeRecord(raw) as WithdrawalRecord
    if (typeof record?.localId === "string") out.set(key(record.localId), record)
  }
  for (const [id, record] of decodeWithdrawals(db.get(KEY_WITHDRAWALS), key)) {
    if (!out.has(id)) out.set(id, record)
  }
  return [...out.values()]
}

export function createWithdrawals(deps: WithdrawalsDeps): Withdrawals {
  const { db } = deps
  const store = persistentStore<WithdrawalRecord, "hash">(db, {
    prefix: PREFIX,
    version: 1,
    id: (record) => key(record.localId),
    migrate: (from, w) => migrateWithdrawals(from, w, { prefix: PREFIX, key }),
    indexes: { hash: (record) => (record.l2TxHash ? [key(record.l2TxHash)] : []) },
    load: "all",
  })
  const list = derived([store.view], ({ records, loaded, failed }) => ({
    records: [...records].sort((a, b) => b.startTime - a.startTime),
    hydrated: loaded && !failed,
  }))
  const all = () => loadRecords(store.view)
  const writing = async <T>(w: Write | undefined, fn: (w: Write) => Promise<T>): Promise<T> => {
    if (w) return fn(w)
    await store.ready
    return db.write(fn)
  }
  const byHash = async (l2TxHash: string, w?: Write) => {
    if (!l2TxHash) return undefined
    const hash = key(l2TxHash)
    const [indexed] = await loadRecords(store.where("hash", hash))
    const record = indexed && (await store.get(key(indexed.localId), w))
    return record?.l2TxHash && key(record.l2TxHash) === hash ? record : undefined
  }
  const get = async (keyOrHash: string, w?: Write) =>
    (await store.get(key(keyOrHash), w)) ?? byHash(keyOrHash, w)
  /** Applies each event to its record, in one transaction. */
  const applyAll = (events: readonly (readonly [string, WithdrawalEvent])[], w?: Write) =>
    writing(w, async (w) => {
      const changed: WithdrawalRecord[] = []
      const now = deps.now()
      for (const [id, event] of events) {
        const record = await get(id, w)
        const next = record && withdrawalTransition(record, event, now)
        if (!next) continue
        await store.put(next, w)
        changed.push(next)
      }
      return changed
    })

  const create = async (record: OnNetwork<WithdrawalRecord>, w?: Write) => {
    const stamped: WithdrawalRecord = {
      ...record,
      version: record.version ?? WITHDRAWAL_RECORD_VERSION,
      networkId: record.networkId.toLowerCase(),
    }
    const stored =
      WITHDRAWAL_TERMINAL_PHASES.has(stamped.phase) && !stamped.endTime
        ? { ...stamped, endTime: deps.now() }
        : stamped
    await store.put(stored, w)
    return stored
  }

  return {
    list,
    settled: derived([store.view], ({ loaded, failed }) => loaded || failed),
    ready: store.ready,
    all,
    get,
    byHash,
    create,
    adopt: (record) =>
      writing(undefined, async (w) => {
        const held =
          (await store.get(key(record.localId), w)) ??
          (record.l2TxHash ? await byHash(record.l2TxHash, w) : undefined)
        if (held) return { record: held, adopted: false }
        return { record: await create(record, w), adopted: true }
      }),
    async apply(keyOrHash, event, w) {
      const [next] = await applyAll([[keyOrHash, event]], w)
      return next
    },
    remove: (keyOrHash, w) =>
      writing(w, async (w) => {
        const record = await get(keyOrHash, w)
        await store.remove(key(record?.localId ?? keyOrHash), w)
      }),
    async failInterrupted(now, maxAgeMs) {
      const due = (await all()).filter((r) => now - r.startTime >= maxAgeMs)
      return applyAll(due.map((r) => [r.localId, { type: "interrupted" }] as const))
    },
    async migrateExecutors(burnOf) {
      const due = (await all()).filter((r) => (r.version ?? 1) < WITHDRAWAL_RECORD_VERSION)
      return applyAll(
        due.map((r) => {
          const burn = r.deployment && !r.deployment.executor ? burnOf(r) : undefined
          return [r.localId, { type: "executorMigrated", burn }] as const
        }),
      )
    },
  }
}
