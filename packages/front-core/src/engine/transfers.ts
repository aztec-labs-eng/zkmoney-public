import { QueueStatus, TokenActionEnum } from "@obsidion/core/constants"
import type { PaylinkTransaction, TokenTransaction, Transaction } from "../types/transactions"
import type { OnNetwork } from "../types/networkStamp"
import { normalizeTag } from "../utils/normalizeTag"
import type { Database, Write } from "./database"
import {
  decodeRecord,
  loadRecords,
  persistentStore,
  timeKey,
  type IndexRange,
  type RecordSet,
} from "./persistentStore"
import { keepOwned, transferTransition, type TransferEvent } from "./transferTransition"
import { ACTIVITY, legacyRow, legacyRows, migrateTransfers } from "../storageMigrations/transfers"
import { legacyLinkRows, moveLinksOut } from "./paylinks"
import type { PaylinkRecord } from "./paylinkTransition"
import { operationIndex, operationRows } from "./operations"
import type { OperationRecord } from "./operationTransition"
import { memoryStore, type ReadonlyStore } from "./store"

/** Rows the store keeps in memory: the newest, which Home and the recent feed read. */
export const RECENT_ROWS = 10

/**
 * - `time`: the row's timestamp.
 * - `hash`: its hash.
 * - `request`: the payment request it carries.
 * - `peer`: a send's or receive's counterparty, as an address and as a tag.
 * - `pending`: every pending row, under `PENDING`.
 */
export type TransferIndex = "time" | "hash" | "request" | "peer" | "pending"

export const PENDING = "1"

export type Recorded<T extends Transaction> =
  | { tx: T; inserted: true }
  | { tx: Transaction; inserted: false }

export interface TransfersDeps {
  /** The account's database. */
  db: Database
  now: () => number
}

/**
 * Every transfer the chain shows that this device did not start, in both directions, one record
 * each, keyed by tx hash. This device's own transfers are their operations; an own row an older
 * build kept, keyed by its operation id, stays. A created link's row is its funding transfer; the
 * link is in `paylinks`. A row's status and anchors change only through `transferTransition`. Reads
 * hold saved rows only. A write without `w` commits on its own and resolves once saved; with one,
 * it joins that transaction.
 */
export interface Transfers {
  /** Settles once the open's migration and index build are saved. */
  readonly ready: Promise<void>
  /** The `RECENT_ROWS` newest rows, newest first. */
  readonly view: ReadonlyStore<RecordSet<Transaction>>
  where(index: TransferIndex, at: string | IndexRange): ReadonlyStore<RecordSet<Transaction>>
  get(id: string, w?: Write): Promise<Transaction | undefined>
  /** The row whose own hash this is. */
  byHash(txHash: string, w?: Write): Promise<Transaction | undefined>
  /** Whether any row carries this hash. */
  hasTxHash(txHash: string, w?: Write): Promise<boolean>
  /** Applies `event` to the row; the row when it changed. */
  apply(id: string, event: TransferEvent, w?: Write): Promise<Transaction | undefined>
  /**
   * A row read off chain, keyed by its hash. The first writer of a hash wins, except over a plain
   * receive when `replaces` names it: a paylink payout's row takes its place, under its id.
   */
  record<T extends Transaction>(
    row: OnNetwork<T>,
    opts?: { replaces?: TokenActionEnum.RECEIVE },
    w?: Write,
  ): Promise<Recorded<T>>
  /** Sets the memo on the row with this hash when it has none. */
  backfillMemo(txHash: string, memo: string, w?: Write): Promise<boolean>
  /** Reorg: back to pending under a new epoch, or failed for good. */
  demoteByTxHash(
    txHash: string,
    opts?: { terminal?: "failed" },
  ): Promise<{ matched: boolean; reorgEpoch?: number }>
  /** Settles by hash unless the write is from an older reorg epoch or the row was cancelled. */
  settleByHash(
    txHash: string,
    status: QueueStatus.SUCCESS | QueueStatus.FAILED,
    completionTime: number,
    reorgEpoch?: number,
  ): Promise<{ matched: boolean }>
  /** Every row, read once. */
  all(): Promise<readonly Transaction[]>
  /**
   * Rows from a retired rollup's database, in the legacy format. Nothing here can finish one, so an
   * unfinished row lands failed. A row whose hash, or link, is already here is skipped, and so is
   * one with neither, though a held row takes a counterparty tag the new copy verified. Rows keep the
   * network they were stamped with, and a created link moves to `paylinks` in the same write.
   * Resolves, once saved, to how many were added.
   */
  importHistoricRows(rows: readonly object[]): Promise<number>
}

const lower = (value: string) => value.toLowerCase()

const PREFIX = "acct/transfers"
const LINKS = "acct/paylinks"
const OPERATIONS = "acct/operations"

/** Index values: present, lowercase, and free of the key separator. */
function values(...raw: (string | undefined | null | false)[]): string[] {
  return [...new Set(raw.flatMap((v) => (v && !v.includes("/") ? [lower(v)] : [])))]
}

/** A tag as the index keeps it, or an address lowercased. */
const peerOf = (raw: string | undefined) =>
  !raw ? undefined : /^0x/i.test(raw) ? raw : normalizeTag(raw) ?? undefined

const INDEXES: Record<TransferIndex, (row: Transaction) => readonly string[]> = {
  time: (row) => [timeKey(row.timestamp)],
  hash: (row) => values(row.txHash),
  request: (row) => values((row as TokenTransaction).requestId),
  peer: (row) => {
    const tx = row as TokenTransaction
    if (tx.action === "send") return values(peerOf(tx.to), peerOf(tx.toTag))
    if (tx.action === "receive") return values(peerOf(tx.from), peerOf(tx.senderL2Address))
    return []
  },
  pending: (row) => (row.status === "pending" ? [PENDING] : []),
}

/**
 * The rows a database no transfers store is open on holds, such as a retired rollup's: this store's
 * records with their links folded in, its own transfers' operations as rows, then the legacy
 * blob's, in their own formats.
 */
export function storedTransfers(db: {
  get(key: string): string | null | undefined
  keys(prefix: string): string[]
}): object[] {
  const read = <R>(prefix: string) =>
    db.keys(`${prefix}/`).flatMap((k) => {
      const raw = db.get(k)
      return raw === null || raw === undefined ? [] : [decodeRecord(raw) as R]
    })
  const ops = read<OperationRecord>(OPERATIONS)
  const saved = legacyLinkRows(
    [...read<Transaction>(PREFIX), ...read<Transaction>(ACTIVITY)],
    read<PaylinkRecord>(LINKS),
    operationIndex(ops),
  )
  // This device's own transfers are their operations.
  const own = operationRows({ records: ops, loaded: true, failed: false }).records
  return [...saved, ...own, ...legacyRows((k) => db.get(k))]
}

export function createTransfers(deps: TransfersDeps): Transfers {
  const { db } = deps
  const store = persistentStore<Transaction, TransferIndex>(db, {
    prefix: PREFIX,
    version: 5,
    id: (row) => row.id,
    migrate: (from, w) => migrateTransfers(from, w, { db, prefix: PREFIX }),
    indexes: INDEXES,
    load: { index: "time", window: RECENT_ROWS, reverse: true },
  })
  /** Runs `fn` in the caller's write, or in one of its own. */
  const writing = async <T>(w: Write | undefined, fn: (w: Write) => Promise<T>): Promise<T> => {
    if (w) return fn(w)
    await store.ready
    return db.write(fn)
  }
  /** Every row carrying the hash. Inside a write, rows are read through `w`, so what it staged counts. */
  const carrying = async (txHash: string, w?: Write): Promise<Transaction[]> => {
    if (!txHash) return []
    const hash = lower(txHash)
    const [indexed, keyed] = await Promise.all([
      loadRecords(store.where("hash", hash)),
      store.get(hash, w),
    ])
    const rows = new Map(indexed.map((row) => [row.id, row]))
    if (keyed) rows.set(keyed.id, keyed)
    const ids = [...rows.keys()]
    // What the write staged over the saved rows.
    const current = await Promise.all(ids.map((id) => store.get(id, w)))
    return current.flatMap((row) => (row && lower(row.txHash) === hash ? [row] : []))
  }
  const byHash = (txHash: string, w?: Write) => carrying(txHash, w).then((rows) => rows[0])
  const apply = (id: string, event: TransferEvent, w?: Write) =>
    store.apply(id, (row) => row && transferTransition(row, event), w)

  return {
    ready: store.ready,
    view: store.view,
    where: store.where,
    get: store.get,
    byHash,
    hasTxHash: async (txHash, w) => (await carrying(txHash, w)).length > 0,
    apply,
    record: <T extends Transaction>(
      row: OnNetwork<T>,
      opts: { replaces?: TokenActionEnum.RECEIVE } = {},
      w?: Write,
    ): Promise<Recorded<T>> =>
      writing(w, async (w): Promise<Recorded<T>> => {
        const existing = await byHash(row.txHash, w)
        if (existing && existing.action !== opts.replaces) return { tx: existing, inserted: false }
        const txHash = lower(row.txHash)
        const tx: T = {
          ...row,
          id: existing?.id ?? txHash,
          txHash,
          networkId: row.networkId.toLowerCase(),
        }
        await store.put(tx, w)
        return { tx, inserted: true }
      }),
    backfillMemo: (txHash, memo, w) =>
      writing(w, async (w) => {
        const row = await byHash(txHash, w)
        if (!row || (row as { memo?: string }).memo) return false
        return !!(await store.apply(
          row.id,
          (current) => current && keepOwned(current, { ...current, memo } as Transaction),
          w,
        ))
      }),
    demoteByTxHash: (txHash, opts = {}) =>
      writing(undefined, async (w) => {
        const row = await byHash(txHash, w)
        if (!row) return { matched: false }
        const next = await apply(
          row.id,
          { type: "demoted", at: deps.now(), terminal: opts.terminal },
          w,
        )
        return { matched: true, reorgEpoch: (next ?? row).reorgEpoch }
      }),
    settleByHash: (txHash, status, completionTime, reorgEpoch) =>
      writing(undefined, async (w) => {
        const row = await byHash(txHash, w)
        if (!row) return { matched: false }
        await apply(row.id, { type: "confirmed", at: completionTime, status, epoch: reorgEpoch }, w)
        return { matched: true }
      }),
    all: () => loadRecords(store.where("time", {})),
    importHistoricRows: (legacy) =>
      writing(undefined, async (w) => {
        const saved = await loadRecords(store.where("time", {}))
        const hashes = new Set<string>()
        const ids = new Set<string>()
        const links = new Set(
          (await db.range(`${LINKS}/`)).flatMap(([, raw]) => {
            const { paylink } = decodeRecord(raw) as PaylinkRecord
            return paylink ? [paylink] : []
          }),
        )
        const index = (row: Transaction) => {
          ids.add(row.id)
          if (row.txHash) hashes.add(lower(row.txHash))
          const link = (row as PaylinkTransaction).paylink
          if (isLink(row) && link) links.add(link)
        }
        saved.forEach(index)
        const put: string[] = []
        let added = 0
        for (const [i, raw] of legacy.entries()) {
          // No queue here owns a retired rollup's row.
          const kept: Record<string, unknown> = { ...raw }
          delete kept.queueId
          const row = historicRow(legacyRow(kept, i))
          const hash = row.txHash ? lower(row.txHash) : undefined
          const link = isLink(row) ? (row as PaylinkTransaction).paylink : undefined
          if (!hash && !link) continue
          const held = hash ? await byHash(hash, w) : undefined
          if (held) {
            const next = withCounterpartyTag(held, row)
            if (next)
              await store.apply(held.id, (current) => current && keepOwned(current, next), w)
            continue
          }
          if ((hash && hashes.has(hash)) || (link && links.has(link)) || ids.has(row.id)) continue
          index(row)
          await store.put(row, w)
          put.push(row.id)
          added++
        }
        await moveLinksOut(w, put)
        return added
      }),
  }
}

/** `held` with the counterparty tag a later read of the same transfer verified; undefined when none is new. */
function withCounterpartyTag(held: Transaction, row: Transaction): Transaction | undefined {
  if (held.action !== row.action) return undefined
  const into = held as TokenTransaction
  const from = row as TokenTransaction
  if (row.action === TokenActionEnum.SEND && from.toTag && !into.toTag) {
    return { ...held, toTag: from.toTag } as Transaction
  }
  if (
    row.action === TokenActionEnum.RECEIVE &&
    from.from &&
    from.senderL2Address &&
    from.from !== from.senderL2Address &&
    into.from?.toLowerCase() === from.senderL2Address.toLowerCase()
  ) {
    return { ...held, from: from.from } as Transaction
  }
  return undefined
}

const isLink = (row: Transaction) =>
  typeof (row as PaylinkTransaction).emailPaymentAction === "string"

/** A retired rollup's row as this store keeps it: nothing here can finish an unfinished one. */
function historicRow(row: Transaction): Transaction {
  if (row.status !== "pending") return row
  return {
    ...row,
    status: "failed",
    detailedStatus: QueueStatus.FAILED,
    progress: 100,
    endTime: row.endTime ?? row.timestamp,
    failure: { code: "tx.failed" },
  }
}

/** Rows the Activity screen reads per page. */
export const TRANSFER_PAGE = 50

export interface TransferPages {
  /** The newest rows, a page more after each `more`; a page that is loading keeps the last shown. */
  readonly rows: ReadonlyStore<RecordSet<Transaction> & { complete: boolean }>
  /** Reads one more page, once the last one loaded and filled. */
  more(): void
}

/**
 * The Activity screen's rows, newest first. Each page is a larger `time` query; the one shown stays
 * watched until the next one loads, so the list never empties while it grows.
 */
export function transferPages(
  transfers: Pick<Transfers, "where">,
  page = TRANSFER_PAGE,
): TransferPages {
  type Shown = RecordSet<Transaction> & { complete: boolean }
  type Page = { limit: number; records: ReadonlyStore<RecordSet<Transaction>> }
  const shown = memoryStore<Shown>({ records: [], loaded: false, failed: false, complete: false })
  const pageOf = (limit: number): Page => ({
    limit,
    records: transfers.where("time", { reverse: true, limit }),
  })
  /** The page shown, and the larger one loading behind it. */
  let held = [pageOf(page)]
  let offs: (() => void)[] = []
  let watchers = 0
  const publish = () => {
    const next = held[held.length - 1].records.get()
    if (held.length > 1 && next.loaded) {
      // The larger page landed: the smaller one goes.
      offs.shift()?.()
      held = held.slice(1)
    } else if (held.length > 1 && next.failed) {
      // The larger page failed: the smaller one stays, and the next `more` reads it again.
      if (offs.length === held.length) offs.pop()?.()
      held = held.slice(0, -1)
    }
    const { limit, records } = held[0]
    const set = records.get()
    shown.set({ ...set, complete: set.loaded && set.records.length < limit })
  }
  const watch = ({ records }: Page) => offs.push(records.subscribe(publish))
  return {
    rows: {
      get: shown.get,
      subscribe(listener) {
        const off = shown.subscribe(listener)
        if (watchers++ === 0) {
          held.forEach(watch)
          publish()
        }
        let done = false
        return () => {
          if (done) return
          done = true
          off()
          if (--watchers > 0) return
          offs.forEach((stop) => stop())
          offs = []
        }
      },
    },
    more() {
      const current = shown.get()
      if (held.length > 1 || !current.loaded || current.complete) return
      const next = pageOf(held[0].limit + page)
      held = [...held, next]
      if (watchers > 0) watch(next)
      publish()
    },
  }
}
