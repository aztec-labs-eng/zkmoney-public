import { TxHash } from "@aztec-labs/stdlib/tx"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { isFailedSubmission } from "../core/services/transactions/trackSubmission"
import { PaylinkActionEnum, TokenActionEnum } from "@obsidion/core/constants"
import type { Transaction, TransactionStatus } from "../types/transactions"
import type { Database, Write } from "./database"
import { bestEffort, WalletError } from "./errors"
import {
  operationTransition,
  type OperationBase,
  type OperationEvent,
  type OperationKind,
  type OperationRecord,
} from "./operationTransition"
import { loadRecords, persistentStore, type RecordSet } from "./persistentStore"
import { derived, memoryStore, type ReadonlyStore } from "./store"
import { migrateOperations } from "../storageMigrations/operations"

const PREFIX = "acct/operations"

/**
 * Ended records older than this are dropped at boot; until then the notifications panel lists them.
 * A transfer's record is its history and stays.
 */
const ENDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export type OperationInput = Pick<
  OperationBase,
  "operationId" | "flow" | "summary" | "parent" | "resumable" | "background"
> &
  OperationKind

export interface Operations {
  readonly ready: Promise<void>
  readonly view: ReadonlyStore<RecordSet<OperationRecord>>
  /** The operations a flow in this page runs: the boot sweep and the chain leave them to it. */
  readonly live: ReadonlyStore<ReadonlySet<string>>
  /** Unfinished ones a notification lists, newest first. */
  readonly running: ReadonlyStore<readonly OperationRecord[]>
  /** Ended ones a notification lists, dismissed ones included, newest first. */
  readonly ended: ReadonlyStore<readonly OperationRecord[]>
  /** A `local` one this page runs: closing, reloading or logging out would lose it. */
  readonly tabBound: ReadonlyStore<OperationRecord | undefined>
  get(operationId: string): Promise<OperationRecord | undefined>
  /**
   * A `local` record this page runs, once the view loaded; owned only once the write lands. An id
   * this page runs, or one already `sent` or `settled`, is refused; a `failed` or stale record
   * under the id is replaced.
   */
  begin(input: OperationInput, at?: number): Promise<void>
  /** Applies `event` through `operationTransition`. An ending releases it. */
  apply(operationId: string, event: OperationEvent, w?: Write): Promise<OperationRecord | undefined>
  /** Its owner runs a resumable record again in this page. */
  resume(operationId: string): Promise<void>
  /** The flow stopped running in this page; a `sent` record passes to {@link resolveSent}. */
  release(operationId: string): void
  /** Nothing was sent and nothing is worth reporting, e.g. the passkey prompt was closed. */
  remove(operationId: string): Promise<void>
  /**
   * Ends every `local` record that started by `activeSince`: one tab runs the wallet and starts
   * nothing before it becomes the active tab, so the tab that owned it stopped. One that began
   * proving or was handed off fails; any other lost nothing and goes, unless it is a transfer's
   * record, which fails quietly. A resumable one waits for its owner. Ended records past retention
   * go too, except a transfer's and a failure with a hash. One write.
   */
  sweep(activeSince: number, at?: number): Promise<void>
  /**
   * Settles `sent` records no running flow owns and no owner resumes, from their receipts: included
   * settles, dropped or reverted fails, anything else waits. An unreachable node changes nothing.
   */
  resolveSent(node: Pick<AztecNode, "getTxReceipt">, at?: number): Promise<void>
  /** Clears every ending from the notifications panel; running operations stay. */
  dismissEnded(at?: number): Promise<void>
}

/** A record's funding: its operation's state, or as the record's own hash shows it. */
export type Funding = OperationRecord["state"] | "unsent"

/** Operations by id and by hash, and `local` refunds by link, for {@link withOperation}. */
export interface OperationIndex {
  byId: ReadonlyMap<string, OperationRecord>
  byHash: ReadonlyMap<string, OperationRecord>
  refunds: ReadonlyMap<string, OperationRecord>
}

export function operationIndex(records: readonly OperationRecord[]): OperationIndex {
  const byId = new Map<string, OperationRecord>()
  const byHash = new Map<string, OperationRecord>()
  const refunds = new Map<string, OperationRecord>()
  for (const r of records) {
    byId.set(r.operationId, r)
    if (r.txHash) byHash.set(r.txHash.toLowerCase(), r)
    if (r.kind === "paylink-refund" && r.state === "local") refunds.set(r.payload.linkId, r)
  }
  return { byId, byHash, refunds }
}

/** A funding as a row's status: one never sent reads failed. */
export const FUNDING_STATUS: Record<Funding, TransactionStatus> = {
  unsent: "failed",
  local: "pending",
  sent: "pending",
  settled: "success",
  failed: "failed",
}

/**
 * The one join of a domain record to its operation, by `operationId`, else by hash. A record no
 * operation here ran (rebuilt from chain, made on another device) is funded once it holds a hash.
 * A link also joins the refund that is `local` on it, from the refund's begin until its hash.
 */
export function withOperation<R extends { id?: string; operationId?: string; txHash?: string }>(
  record: R,
  index: OperationIndex,
): { record: R; op?: OperationRecord; funding: Funding; refunding?: OperationRecord } {
  const op =
    (record.operationId && index.byId.get(record.operationId)) ||
    (record.txHash && index.byHash.get(record.txHash.toLowerCase())) ||
    undefined
  const refunding = record.id === undefined ? undefined : index.refunds.get(record.id)
  const joined = { record, ...(refunding ? { refunding } : {}) }
  if (op) return { ...joined, op, funding: op.state }
  return { ...joined, funding: record.txHash ? "settled" : "unsent" }
}

export type TransferOperation = Extract<OperationRecord, { kind: string }>

export const isTransfer = (op: OperationRecord): op is TransferOperation => op.kind !== undefined

const PAYOUT = {
  "paylink-claim": PaylinkActionEnum.CLAIM,
  "paylink-refund": PaylinkActionEnum.CLAIM_BACK,
} as const

/** A transfer's operation as its row: the chain files none for it. */
export function operationRow(op: TransferOperation): Transaction {
  const status = FUNDING_STATUS[op.state]
  const base = {
    id: op.txHash ? op.txHash.toLowerCase() : op.operationId,
    operationId: op.operationId,
    networkId: op.payload.networkId,
    timestamp: op.startedAt,
    status,
    txHash: op.txHash ?? "",
    token: op.payload.token,
    amountAtomic: BigInt(op.payload.amountAtomic),
    memo: op.payload.memo,
    ...(op.endedAt !== undefined ? { endTime: op.endedAt } : {}),
    ...(status === "failed"
      ? { failure: { code: op.cause === "interrupted" ? "tx.interrupted" : "tx.failed" } }
      : {}),
  }
  if (op.kind === "send") {
    const { to, toTag, requestId } = op.payload
    return { ...base, action: TokenActionEnum.SEND, to, toTag, requestId } as Transaction
  }
  const action = PAYOUT[op.kind]
  const { flavor } = op.payload
  return { ...base, action, emailPaymentAction: action, kind: op.kind, flavor } as Transaction
}

/** The rows of the transfers `keep` lists, beside the chain's. */
export function operationRows(
  ops: RecordSet<OperationRecord>,
  keep: (op: TransferOperation) => boolean = () => true,
): RecordSet<Transaction> {
  const records = ops.records.filter(isTransfer).filter(keep).map(operationRow)
  return { records, loaded: ops.loaded, failed: ops.failed }
}

/** Whether a refund of the link `id` is `local`, as the operations hold it now. */
export const refundRuns = (ops: Pick<Operations, "view">, id: string): boolean =>
  !!withOperation({ id }, operationIndex(ops.view.get().records)).refunding

const listed = (r: OperationRecord) => !r.background
const newestFirst = (a: OperationRecord, b: OperationRecord) => b.startedAt - a.startedAt
const sameList = (a: readonly OperationRecord[], b: readonly OperationRecord[]) =>
  a.length === b.length && a.every((r, i) => r === b[i])

/** One namespace's operations. */
export function createOperations({
  db,
  legacy,
  transfers,
  now,
}: {
  db: Database
  now: () => number
  legacy?: { db: Pick<Database, "get">; scope: string | null }
  /** The transfers open imports the rows the legacy carry reads hashes from: this one waits for it. */
  transfers?: { ready: Promise<void> }
}): Operations {
  const store = persistentStore<OperationRecord>(db, {
    prefix: PREFIX,
    version: 2,
    id: (r) => r.operationId,
    load: "all",
    after: transfers?.ready,
    migrate: (from, w) => migrateOperations(from, w, { db, prefix: PREFIX, legacy }),
  })
  const live = memoryStore<ReadonlySet<string>>(new Set())
  /** Ids whose begin is writing their record. */
  const beginning = new Set<string>()
  const own = (operationId: string, on: boolean) => {
    if (live.get().has(operationId) === on) return
    const next = new Set(live.get())
    if (on) next.add(operationId)
    else next.delete(operationId)
    live.set(next)
  }
  const list = (keep: (r: OperationRecord) => boolean) =>
    derived([store.view], ({ records }) => records.filter(keep).sort(newestFirst), sameList)
  const apply = (operationId: string, event: OperationEvent, w?: Write) =>
    store.apply(operationId, (r) => (r ? operationTransition(r, event) : undefined), w)
  return {
    ready: store.ready,
    view: store.view,
    live: live.readonly,
    running: list((r) => listed(r) && (r.state === "local" || r.state === "sent")),
    ended: list((r) => listed(r) && r.endedAt !== undefined),
    tabBound: derived([store.view, live.readonly], ({ records }, owned) =>
      records.find((r) => r.state === "local" && listed(r) && owned.has(r.operationId)),
    ),
    // Read in the write queue, so a hash saved before the read is seen.
    async get(operationId) {
      await store.ready
      return db.write((w) => store.get(operationId, w))
    },
    async begin(input, at = now()) {
      // The tab binding reads the view: a flow begun before its first load waits for it, and one
      // whose view cannot load starts nothing.
      await loadRecords(store.view)
      const { operationId } = input
      if (live.get().has(operationId) || beginning.has(operationId))
        throw new WalletError("operation.running", operationId)
      const held = store.view.get().records.find((r) => r.operationId === operationId)
      if (held?.state === "sent" || held?.state === "settled")
        throw new WalletError("operation.sent", operationId)
      beginning.add(operationId)
      try {
        await store.put({ ...input, state: "local", startedAt: at })
      } finally {
        beginning.delete(operationId)
      }
      own(operationId, true)
    },
    async apply(operationId, event, w) {
      if (event.type === "settled" || event.type === "failed") own(operationId, false)
      return apply(operationId, event, w)
    },
    async resume(operationId) {
      const record = await apply(operationId, { type: "resumed" })
      if (record) own(operationId, true)
    },
    release: (operationId) => own(operationId, false),
    async remove(operationId) {
      own(operationId, false)
      await store.remove(operationId)
    },
    async sweep(activeSince, at = now()) {
      const records = await loadRecords(store.view)
      await db.write(async (w) => {
        for (const r of records) {
          if (r.endedAt !== undefined && at - r.endedAt > ENDED_RETENTION_MS) {
            // A failure with a hash is the one record that its transfer never landed.
            if (!r.kind && !(r.state === "failed" && r.txHash)) await store.remove(r.operationId, w)
          } else if (r.state === "local" && r.startedAt <= activeSince && !r.resumable) {
            const lost = r.provingStartedAt !== undefined || r.handedOffAt !== undefined
            if (!lost && !r.kind) await store.remove(r.operationId, w)
            else {
              const failed = {
                type: "failed",
                cause: "interrupted",
                at,
                quiet: !lost,
              } as const
              await store.apply(r.operationId, (s) => s && operationTransition(s, failed), w)
            }
          }
        }
      })
    },
    async resolveSent(node, at = now()) {
      const records = await loadRecords(store.view)
      const owned = live.get()
      for (const r of records) {
        if (r.state !== "sent" || r.resumable || owned.has(r.operationId) || !r.txHash) continue
        // No receipt is not evidence either way.
        const receipt = await bestEffort("unknown", node.getTxReceipt(TxHash.fromString(r.txHash)))
        if (!receipt) continue
        if (isFailedSubmission(receipt))
          await apply(r.operationId, { type: "failed", cause: "dropped", at })
        else if (receipt.blockNumber !== undefined)
          await apply(r.operationId, { type: "settled", txHash: r.txHash, at })
      }
    },
    async dismissEnded(at = now()) {
      const records = await loadRecords(store.view)
      await db.write(async (w) => {
        for (const r of records)
          await store.apply(
            r.operationId,
            (s) => s && operationTransition(s, { type: "dismissed", at }),
            w,
          )
      })
    },
  }
}
