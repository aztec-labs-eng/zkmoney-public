import { PaylinkActionEnum, QueueStatus, TokenActionEnum } from "@obsidion/core/constants"
import type { PaylinkTransaction, TokenTransaction, Transaction } from "../types/transactions"
import type { TokenInTxService } from "../types/tokens"
import type { NewIncomingTokenTx, NewPaylinkPayoutTx } from "../xmtp/receiverTypes"
import { decodeRecord, persistentStore, recordPrefix } from "./persistentStore"
import type { Failure } from "./errors"
import { keepOwned, activityTransition, type ActivityEvent } from "./activityTransition"
import type { KvStore } from "./kv"
import { legacyActivity, legacyRow, legacyRows } from "./activityLegacy"
import { derived, type ReadonlyStore } from "./store"

/** Longest a pre-submit row may sit without a hash before it counts as interrupted; proving takes minutes. */
export const SEND_SUBMIT_TIMEOUT_MS = 10 * 60 * 1000

/** A creator PAY row rebuilt from the funding transfer's own copy (see `rebuildPaylinks`). */
export interface RecoveredPaylink {
  txHash: string
  flavor: "direct" | "email"
  token: TokenInTxService
  amountAtomic: bigint
  timestamp: number
  blockNumber: number
  to?: string
  payToEmailSecret: string
  obsidionAccountAddress: string
  tokenAddress: string
  paylink: string
  fallbackSecret: string
  fromClaimable?: number
  untilClaimable?: number
  refundableUntil?: number
  memo?: string
  networkId: string
  isClaimed?: boolean
  claimedAt?: number
  claimedBy?: "self" | "chain"
  isRefunded?: boolean
  refundTxHash?: string
}

export interface ActivityDeps {
  kv: KvStore
  /** The network a row is stamped with when its writer names none. */
  networkId: () => string | undefined
}

/**
 * The account's activity rows, one record each: keyed by operation id for a row this device
 * started, else by tx hash. Every hash a row carries, its refund's included, resolves to that row.
 * A row's status, anchors and claim state change only through `activityTransition`. `rows` holds
 * saved rows only; every writer reads the latest write through `latest`. `insertPending` and
 * `setHash` resolve once durable, since a flow awaits them before it proves or submits; every other
 * write saves in the background, or with the open `kv.batch`.
 */
export interface Activity {
  /** Saved rows, oldest first. */
  readonly rows: ReadonlyStore<readonly Transaction[]>
  /** Settles once the open's migration is saved. */
  readonly ready: Promise<void>
  latest(id: string): Transaction | undefined
  byHash(txHash: string): Transaction | undefined
  /** Whether any row carries this hash, as its own or its refund's. */
  hasTxHash(txHash: string): boolean
  insertPending(row: Transaction): Promise<void>
  /** Stamps the submitted hash on a pending row that has none. False unless the row holds one. */
  setHash(id: string, txHash: string): Promise<boolean>
  /** Changes fields `activityTransition` does not own. */
  patch(id: string, change: (row: Transaction) => Transaction): boolean
  /** Applies `event` to the first row `match` accepts; the row when it changed. */
  apply(match: (row: Transaction) => boolean, event: ActivityEvent): Transaction | undefined
  /**
   * The flow's own outcome. `epoch` is the row's `reorgEpoch` when the flow started, so a write
   * that a reorg overtook is ignored. True when the row changed.
   */
  settle(id: string, txHash?: string, epoch?: number): boolean
  fail(id: string, failure: Failure, epoch?: number): boolean
  remove(id: string): void
  /** Fails rows this device started that hold no hash and are older than `maxAgeMs`. */
  failInterrupted(now: number, maxAgeMs: number): Transaction[]
  /** A transfer the chain scan read. The first writer of a hash wins. */
  upsertScanned(input: NewIncomingTokenTx): { tx: TokenTransaction; inserted: boolean }
  /** Upgrades a scanned send; any other row with the hash is left as it is. */
  addRecoveredPaylink(input: RecoveredPaylink): { tx: PaylinkTransaction; inserted: boolean }
  /** Upgrades a scanned receive; any other row with the hash is left as it is. */
  addRecoveredPayout(input: NewPaylinkPayoutTx): boolean
  /** Sets the memo on the row with this hash when it has none. */
  backfillMemo(txHash: string, memo: string): boolean
  /** Reorg: back to pending under a new epoch, or failed for good. */
  demoteByTxHash(
    txHash: string,
    opts?: { terminal?: "failed" },
  ): { matched: boolean; reorgEpoch?: number }
  /** Settles by hash unless the write is from an older reorg epoch or the row was cancelled. */
  settleByHash(
    txHash: string,
    status: QueueStatus.SUCCESS | QueueStatus.FAILED,
    completionTime: number,
    reorgEpoch?: number,
  ): { matched: boolean }
  /**
   * Rows from a retired rollup's database, in the legacy format. Nothing here can finish one, so an
   * unfinished row lands failed. A row whose hash, or link, is already here is skipped, and so is
   * one with neither. Rows keep the network they were stamped with. Resolves, once durable, to how
   * many were added.
   */
  importHistoricRows(rows: readonly object[]): Promise<number>
}

const key = (txHash: string) => txHash.toLowerCase()

const STORE = { scope: "acct", name: "activity" } as const

/**
 * The rows a database no activity store is open on holds, such as a retired rollup's: this store's
 * records, then the legacy blob's, in their own formats.
 */
export function storedActivity(db: {
  get(key: string): string | null | undefined
  keys(prefix: string): string[]
}): object[] {
  const saved = db.keys(recordPrefix(STORE)).flatMap((k) => {
    const raw = db.get(k)
    return raw === null || raw === undefined ? [] : [decodeRecord(raw) as object]
  })
  return [...saved, ...legacyRows((k) => db.get(k))]
}

export function createActivity(deps: ActivityDeps): Activity {
  const saved = persistentStore<Transaction>(deps.kv, {
    ...STORE,
    version: 1,
    migrate: (from, saved, kv) => {
      if (from !== undefined) throw new Error(`activity: unknown version ${from}`)
      // Records saved after an import whose version write was lost win over a second import.
      const records = legacyActivity(kv)
      for (const [id, row] of saved) records.push([id, row as Transaction])
      return { records }
    },
  })
  const rows = derived([saved], (map) =>
    [...map.values()].sort((a, b) => a.timestamp - b.timestamp),
  )
  const index = derived([saved], (map) => {
    const hashes = new Map<string, string>()
    const refunds = new Set<string>()
    for (const row of map.values()) {
      if (row.txHash) hashes.set(key(row.txHash), row.id)
      const refund = (row as PaylinkTransaction).refundTxHash
      if (refund) refunds.add(key(refund))
    }
    return { hashes, refunds }
  })

  const { latest } = saved
  /** Each hash written this session, saved or not; a failed write drops out of `latest`, so it stops matching. */
  const written = new Map<string, string>()
  const put = (id: string, row: Transaction) => {
    if (row.txHash) written.set(key(row.txHash), id)
    saved.put(id, row)
  }
  const byHash = (txHash: string) => {
    if (!txHash) return undefined
    const hash = key(txHash)
    for (const id of [written.get(hash), index.get().hashes.get(hash), hash]) {
      const row = id === undefined ? undefined : latest(id)
      if (row?.txHash && key(row.txHash) === hash) return row
    }
    return undefined
  }
  const patch = (id: string, change: (row: Transaction) => Transaction) => {
    const row = latest(id)
    if (!row) return false
    put(id, keepOwned(row, change(row)))
    return true
  }
  /** Applies `event` to the row's latest write; the result is the row when it changed. */
  const apply = (id: string | undefined, event: ActivityEvent) => {
    const row = id === undefined ? undefined : latest(id)
    const next = row && activityTransition(row, event)
    if (next) put(next.id, next)
    return next
  }

  return {
    rows,
    ready: saved.ready,
    latest,
    byHash,
    hasTxHash: (txHash) =>
      !!txHash && (index.get().hashes.has(key(txHash)) || index.get().refunds.has(key(txHash))),
    insertPending(row) {
      const stamped = { ...row, networkId: row.networkId ?? deps.networkId() }
      return deps.kv.batch(() => put(row.id, stamped))
    },
    async setHash(id, txHash) {
      const row = latest(id)
      const next = row && activityTransition(row, { type: "sent", txHash })
      if (next) await deps.kv.batch(() => put(id, next))
      return !!(next ?? row)?.txHash
    },
    patch,
    apply: (match, event) =>
      apply(rows.get().find((row) => match(latest(row.id) ?? row))?.id, event),
    settle(id, txHash, epoch) {
      return !!apply(id, { type: "settled", at: Date.now(), txHash, epoch })
    },
    fail(id, failure, epoch) {
      return !!apply(id, { type: "failed", at: Date.now(), failure, epoch })
    },
    remove: (id) => saved.remove(id),
    failInterrupted(now, maxAgeMs) {
      const due = rows.get().filter((row) => !!row.operationId && now - row.timestamp >= maxAgeMs)
      return due.flatMap((row) => apply(row.id, { type: "interrupted" }) ?? [])
    },
    upsertScanned(input) {
      const existing = byHash(input.txHash)
      if (existing) return { tx: existing as TokenTransaction, inserted: false }
      const txHash = key(input.txHash)
      const tx: TokenTransaction = {
        id: txHash,
        action: input.action === "send" ? TokenActionEnum.SEND : TokenActionEnum.RECEIVE,
        token: input.token,
        amountAtomic: input.amountAtomic,
        timestamp: input.timestamp,
        status: "success",
        txHash,
        from: input.from,
        to: input.to,
        senderL2Address: input.senderL2Address,
        memo: input.memo,
        networkId: input.networkId ?? deps.networkId(),
        blockNumber: input.blockNumber,
        requestId: input.requestId,
      }
      put(tx.id, tx)
      return { tx, inserted: true }
    },
    addRecoveredPaylink(input) {
      const existing = byHash(input.txHash)
      if (existing && existing.action !== TokenActionEnum.SEND) {
        return { tx: existing as PaylinkTransaction, inserted: false }
      }
      const txHash = key(input.txHash)
      const tx: PaylinkTransaction = {
        ...input,
        id: existing?.id ?? txHash,
        txHash,
        action: PaylinkActionEnum.PAY,
        emailPaymentAction: PaylinkActionEnum.PAY,
        status: "success",
        isClaimed: input.isClaimed ?? false,
        // A settled refund scrubs the link, as the refund flow does.
        ...(input.isRefunded ? { paylink: undefined } : {}),
      }
      put(tx.id, tx)
      return { tx, inserted: true }
    },
    addRecoveredPayout(input) {
      const existing = byHash(input.txHash)
      if (existing && existing.action !== TokenActionEnum.RECEIVE) return false
      const txHash = key(input.txHash)
      put(existing?.id ?? txHash, {
        ...input,
        id: existing?.id ?? txHash,
        txHash,
        emailPaymentAction: input.action,
        status: "success",
      })
      return true
    },
    backfillMemo(txHash, memo) {
      const row = byHash(txHash)
      if (!row || (row as { memo?: string }).memo) return false
      return patch(row.id, (r) => ({ ...r, memo } as Transaction))
    },
    demoteByTxHash(txHash, opts = {}) {
      const row = byHash(txHash)
      if (!row) return { matched: false }
      const next = apply(row.id, { type: "demoted", at: Date.now(), terminal: opts.terminal })
      return { matched: true, reorgEpoch: (next ?? row).reorgEpoch }
    },
    settleByHash(txHash, status, completionTime, reorgEpoch) {
      const row = byHash(txHash)
      if (!row) return { matched: false }
      apply(row.id, { type: "confirmed", at: completionTime, status, epoch: reorgEpoch })
      return { matched: true }
    },
    importHistoricRows(legacy) {
      const hashes = new Set<string>()
      const links = new Set<string>()
      const index = (row: Transaction) => {
        if (row.txHash) hashes.add(key(row.txHash))
        const link = (row as PaylinkTransaction).paylink
        if (isLink(row) && link) links.add(link)
      }
      rows.get().forEach(index)
      const added: [string, Transaction][] = []
      legacy.forEach((raw, i) => {
        // No queue here owns a retired rollup's row.
        const kept: Record<string, unknown> = { ...raw }
        delete kept.queueId
        const row = historicRow(legacyRow(kept, i))
        const hash = row.txHash ? key(row.txHash) : undefined
        const link = isLink(row) ? (row as PaylinkTransaction).paylink : undefined
        if (!hash && !link) return
        if ((hash && (hashes.has(hash) || byHash(hash))) || (link && links.has(link))) return
        if (latest(row.id) || added.some(([id]) => id === row.id)) return
        index(row)
        added.push([row.id, row])
      })
      return deps.kv
        .batch(() => added.forEach(([id, row]) => put(id, row)))
        .then(() => added.length)
    },
  }
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
