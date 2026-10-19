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
  /** Planned and approved, sent to L2, refunded on L1, or received on the destination. */
  state: "planned" | "sent" | "refunded" | "received"
  tx?: string
  startTime: number
}

/** A batch has arrived once its deposit is credited; a recovery to Ethereum or a failure is not. */
export function upgradeBatchArrived(arrival?: Pick<SIPADepositRecord, "phase">): boolean {
  return arrival?.phase === "claimed"
}

/** A batch's figure: its credit once its deposit has one, what left the old version until then. */
export function upgradeBatchFigure(
  batch: Pick<UpgradeBatchItem, "amount" | "exitFee">,
  arrival?: SIPADepositRecord,
): bigint {
  const credited = upgradeBatchArrived(arrival) && depositAmounts(arrival!).netAtomic
  return credited || BigInt(batch.amount) - BigInt(batch.exitFee)
}

/** What a run's batches bring to the balance: one whose deposit settled uncredited brings nothing. */
export function upgradeRunTotal(
  legs: readonly {
    batch: Pick<UpgradeBatchItem, "amount" | "exitFee">
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
    const register = this.registering.then(async () => {
      const runs = await this.runs(storage)
      if (!runs.includes(key)) await storage.setItem(RUNS_KEY, JSON.stringify([...runs, key]))
    })
    this.registering = register.catch(() => {})
    await register
    await this.changed()
  }

  /**
   * `storage` with each of run `key`'s writes reported here; the record's registers the run. A
   * failed report never fails the write, which a send may be waiting on.
   */
  reporting(
    key: string,
    storage: Pick<IStorageAdapter, "getItem" | "setItem">,
  ): Pick<IStorageAdapter, "getItem" | "setItem"> {
    return {
      getItem: (k) => storage.getItem(k),
      setItem: async (k, value) => {
        await storage.setItem(k, value)
        void (k === key ? this.addRun(key, storage) : this.changed()).catch((error) =>
          logger.warn("[upgrade] activity refresh failed:", error),
        )
      },
    }
  }

  /** The last loaded batches, oldest run first. */
  items(): readonly UpgradeBatchItem[] {
    return this.cached
  }

  /** A load has finished, so `items` is what storage held rather than nothing yet. */
  loaded(): boolean {
    return this.read
  }

  /** Reload the batches and tell listeners. Only the latest load publishes. */
  async changed(): Promise<void> {
    const load = ++this.loads
    try {
      const items = await this.load()
      if (load === this.loads) this.cached = items
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

  /** A refund batch: a live source's withdrawals carry no selection. */
  private async batch(run: string, id: string): Promise<MigrationFundingBatch | undefined> {
    const raw = await this.storage.getItem(`${run}/source/${id}`)
    const batch = raw ? (JSON.parse(raw) as MigrationFundingBatch) : undefined
    return batch?.sourceSelection ? batch : undefined
  }

  private async load(): Promise<UpgradeBatchItem[]> {
    const out: UpgradeBatchItem[] = []
    for (const run of await this.runs()) {
      const raw = await this.storage.getItem(run)
      const record = raw ? (JSON.parse(raw) as MetadataMigrationRecord) : undefined
      const plan = record?.plan ? (JSON.parse(record.plan) as { sourceBatch?: string }) : undefined
      const first = plan?.sourceBatch && (await this.batch(run, plan.sourceBatch))
      if (first && record) {
        const received = FIRST_RECEIVED.has(record.phase) || !!record.subscriptionTx
        out.push({
          ...item(run, plan.sourceBatch!, first, true),
          state: received ? "received" : record.bootstrapTx ? "sent" : "planned",
          tx: record.bootstrapTx,
        })
      }
      for (let index = 0; ; index++) {
        const id = `remaining-${index}`
        const batch = await this.batch(run, id)
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
          tx: batch.broadcastTx,
        })
      }
    }
    return out
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
    startTime: batch.sentAt ?? batch.createdAt ?? 0,
  }
}
