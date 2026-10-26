import type { MigrationFundingBatch } from "@obsidion/core/types"
import type { IStorageAdapter } from "../storages/adapter"
import { depositAmounts } from "../services/deposits/depositAmounts"
import { isSettledSipaPhase, type SIPADepositRecord } from "../services/deposits/SIPADepositStore"
import type { MetadataMigrationRecord } from "./metadataMigrationFlow"
import { logger } from "src/utils/logger"

/** One refund batch of an upgrade, as activity shows it. */
export interface UpgradeBatchItem {
  /** The run's record key. */
  run: string
  id: string
  /** The batch the bootstrap carries; the others ride their own sends. */
  first: boolean
  /** The destination SIPA the refund pays. */
  recipient: string
  /** What the source refunds, before its exit fee. */
  amount: string
  exitFee: string
  /** What its deposit pays on the destination; absent on a batch planned without it. */
  depositFee?: string
  /** Planned, sent to L2, refunded on L1, or received on the destination. */
  state: "planned" | "sent" | "refunded" | "received"
  /** The user approved its refund; the first batch's approval comes with the run's plan. */
  approved: boolean
  tx?: string
  startTime: number
}

/** A batch has arrived once its deposit is credited; a recovery to Ethereum or a failure is not. */
export function upgradeBatchArrived(arrival?: Pick<SIPADepositRecord, "phase">): boolean {
  return arrival?.phase === "claimed"
}

/** A batch's figure: what it lands, from its deposit once swept, from its fees until then. */
export function upgradeBatchFigure(
  batch: Pick<UpgradeBatchItem, "amount" | "exitFee" | "depositFee">,
  arrival?: SIPADepositRecord,
): bigint {
  if (upgradeBatchArrived(arrival) || arrival?.netAmount != null)
    return depositAmounts(arrival!).netAtomic
  return BigInt(batch.amount) - BigInt(batch.exitFee) - BigInt(batch.depositFee ?? 0)
}

/** What a run's batches bring to the balance: one whose deposit settled uncredited brings nothing. */
export function upgradeRunTotal(
  legs: readonly {
    batch: Pick<UpgradeBatchItem, "amount" | "exitFee" | "depositFee">
    arrival?: SIPADepositRecord
  }[],
): bigint {
  return legs.reduce(
    (sum, { batch, arrival }) =>
      arrival && isSettledSipaPhase(arrival.phase) && !upgradeBatchArrived(arrival)
        ? sum
        : sum + upgradeBatchFigure(batch, arrival),
    0n,
  )
}

const RUNS_KEY = "metadata-migration/runs"
/** Past `subscribing`, or once sponsorship was sent, the bootstrap's deposit has been received. */
const FIRST_RECEIVED: ReadonlySet<MetadataMigrationRecord["phase"]> = new Set([
  "subscribing",
  "recovering",
  "arriving",
  "done",
])

/**
 * The upgrade runs this account started and their refund batches, for activity. The batches are the
 * run's own records, so this reads them and never tracks anything itself; a migration session
 * reports each write through `changed`. A live source withdraws rather than refunds: not listed.
 */
export class UpgradeActivity {
  private static instances = new WeakMap<object, UpgradeActivity>()
  private listeners = new Set<() => void>()
  private cached: UpgradeBatchItem[] = []
  private cachedRecipients: ReadonlySet<string> = new Set()
  private loads = 0
  private read = false
  private registering = Promise.resolve()

  static get(storage: Pick<IStorageAdapter, "getItem" | "setItem">): UpgradeActivity {
    let activity = UpgradeActivity.instances.get(storage)
    if (!activity) UpgradeActivity.instances.set(storage, (activity = new UpgradeActivity(storage)))
    return activity
  }

  private constructor(private readonly storage: Pick<IStorageAdapter, "getItem" | "setItem">) {}

  async runs(storage = this.storage): Promise<string[]> {
    const raw = await storage.getItem(RUNS_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  }

  /** Through the writing session's storage, which refuses another account's namespace. */
  async addRun(key: string, storage = this.storage): Promise<void> {
    await this.register(key, storage)
    await this.changed()
  }

  private register(key: string, storage: Pick<IStorageAdapter, "getItem" | "setItem">) {
    const register = this.registering.then(async () => {
      const runs = await this.runs(storage)
      if (!runs.includes(key)) await storage.setItem(RUNS_KEY, JSON.stringify([...runs, key]))
    })
    this.registering = register.catch(() => {})
    return register
  }

  /**
   * `storage` with each of run `key`'s writes reported here. The run is listed before its record is
   * written, or the write fails, so nothing it sends goes unlisted. A failed refresh never fails a
   * write, which a send may be waiting on.
   */
  reporting(
    key: string,
    storage: Pick<IStorageAdapter, "getItem" | "setItem">,
  ): Pick<IStorageAdapter, "getItem" | "setItem"> {
    return {
      getItem: (k) => storage.getItem(k),
      setItem: async (k, value) => {
        if (k === key) await this.register(key, storage)
        await storage.setItem(k, value)
        void this.changed().catch((error) =>
          logger.warn("[upgrade] activity refresh failed:", error),
        )
      },
    }
  }

  /** The last loaded batches, oldest run first. */
  items(): readonly UpgradeBatchItem[] {
    return this.cached
  }

  /** Every deposit address a run's batches pay, lowercase, a live source's included. */
  recipients(): ReadonlySet<string> {
    return this.cachedRecipients
  }

  /** A load has finished, so `items` is what storage held rather than nothing yet. */
  loaded(): boolean {
    return this.read
  }

  /** Reload the batches and tell listeners. Only the latest load publishes. */
  async changed(): Promise<void> {
    const load = ++this.loads
    try {
      const { items, recipients } = await this.load()
      if (load === this.loads) {
        this.cached = items
        this.cachedRecipients = recipients
      }
    } finally {
      if (load === this.loads) {
        this.read = true
        this.listeners.forEach((listener) => listener())
      }
    }
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A refund batch: a live source's withdrawals carry no selection, so only their address counts. */
  private async batch(
    run: string,
    id: string,
    recipients: Set<string>,
    live = false,
  ): Promise<MigrationFundingBatch | undefined> {
    const raw = await this.storage.getItem(`${run}/source/${id}`)
    const batch = raw ? (JSON.parse(raw) as MigrationFundingBatch) : undefined
    if (batch) recipients.add(batch.recipient.toLowerCase())
    return batch?.sourceSelection || (live && batch) ? batch : undefined
  }

  private async load(): Promise<{ items: UpgradeBatchItem[]; recipients: Set<string> }> {
    const out: UpgradeBatchItem[] = []
    const recipients = new Set<string>()
    for (const run of await this.runs()) {
      const raw = await this.storage.getItem(run)
      const record = raw ? (JSON.parse(raw) as MetadataMigrationRecord) : undefined
      const plan = record?.plan ? (JSON.parse(record.plan) as { sourceBatch?: string }) : undefined
      const first = plan?.sourceBatch && (await this.batch(run, plan.sourceBatch, recipients))
      // A live source's later batches are `remaining`, `remaining-1`, …: only their addresses count.
      for (let index = 0; await this.batch(run, liveId(index), recipients, true); index++);
      if (first && record) {
        const received = FIRST_RECEIVED.has(record.phase) || !!record.subscriptionTx
        out.push({
          ...item(run, plan.sourceBatch!, first, true),
          state: received ? "received" : record.bootstrapTx ? "sent" : "planned",
          approved: true,
          tx: record.bootstrapTx,
        })
      }
      for (let index = 0; ; index++) {
        const id = `remaining-${index}`
        const batch = await this.batch(run, id, recipients)
        if (!batch) break
        if (batch.abandoned) continue
        out.push({
          ...item(run, id, batch, false),
          state: batch.received
            ? "received"
            : batch.refunded
            ? "refunded"
            : batch.broadcastTx
            ? "sent"
            : "planned",
          approved: !!batch.approved,
          tx: batch.broadcastTx,
        })
      }
    }
    return { items: out, recipients }
  }
}

function item(run: string, id: string, batch: MigrationFundingBatch, first: boolean) {
  return {
    run,
    id,
    first,
    recipient: batch.recipient,
    amount: batch.amount,
    exitFee: batch.exitFee,
    depositFee: batch.depositFee,
    startTime: batch.sentAt ?? batch.createdAt ?? 0,
  }
}

const liveId = (index: number) => (index === 0 ? "remaining" : `remaining-${index}`)
