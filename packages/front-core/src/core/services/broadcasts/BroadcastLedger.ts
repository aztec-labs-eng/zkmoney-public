/**
 * The durable list of SIPA broadcasts this wallet owes. A SIPA's funds reach the user only once
 * its broadcast tells the relayer it exists, so each one stays here, across reloads, until the
 * chain shows it landed. The ledger only records; `BroadcastScheduler` decides what runs next.
 */
import type { IStorageAdapter } from "../../storages/adapter"
import { RecordStorage } from "../bridge/RecordStorage"

/**
 * `registration`: a name's deposit address. `deposit`: an address handed to the user. `pool`: one
 * broadcast ahead of need, which nobody has seen yet.
 */
export type BroadcastKind = "registration" | "deposit" | "pool"

/** What the executor rebuilds the broadcast from. Nothing secret: the keys re-derive the rest. */
export type BroadcastSource =
  | { type: "registration"; account: string }
  | { type: "slot"; cacheKey: string; day: number; nonce: number }

/**
 * `queued`: owed, and waiting for its turn or its retry time. `proving`: a page is building it.
 * `sent`: the node accepted it; the chain decides. `landed`: included, nothing left to do.
 */
export type BroadcastState = "queued" | "proving" | "sent" | "landed"

export interface BroadcastJob {
  /** The SIPA address, lowercase. */
  address: string
  kind: BroadcastKind
  /** The account storage scope the job belongs to. */
  scope: string | null
  source: BroadcastSource
  createdAt: number
  /** First shown to the user. */
  shownAt?: number
  /** Funds were seen at the address. */
  fundedAt?: number
  state: BroadcastState
  /** Attempts that failed. An interruption or a wait is not one. */
  failures: number
  /** Not run again before this time, ms. */
  retryAt?: number
  txHash?: string
  lastError?: string
  /** The operation the job's attempts report through; none for a pool job. */
  operationId?: string
  landedAt?: number
}

export const BROADCASTS_STORAGE_KEY = "@obsidion/sipa-broadcasts"

const RETRY_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000]

/** Wait before the next attempt after `failures` failed ones. A job never stops retrying. */
export function retryDelay(failures: number): number {
  return RETRY_BACKOFF_MS[Math.min(failures, RETRY_BACKOFF_MS.length) - 1] ?? 0
}

const keyOf = (address: string) => address.toLowerCase()

/** `txHash`: a broadcast an earlier page already sent, which the chain decides. */
export type NewBroadcastJob = Pick<BroadcastJob, "address" | "kind" | "scope" | "source"> &
  Partial<Pick<BroadcastJob, "shownAt" | "fundedAt" | "operationId" | "txHash">>

export class BroadcastLedger {
  private store: RecordStorage<BroadcastJob>

  constructor(storage: IStorageAdapter) {
    this.store = new RecordStorage<BroadcastJob>({
      storage,
      storageKey: BROADCASTS_STORAGE_KEY,
      keyOf: (job) => job.address,
      sortBy: (job) => job.createdAt,
      label: "BroadcastLedger",
      // A job that did not land in storage is a broadcast a reload forgets.
      strict: true,
    })
  }

  load(): Promise<void> {
    return this.store.load()
  }

  list(): BroadcastJob[] {
    return this.store.list()
  }

  get(address: string): BroadcastJob | null {
    return this.store.getByKey(keyOf(address))
  }

  onListChanged(listener: (jobs: BroadcastJob[]) => void): () => void {
    return this.store.onListChanged(listener)
  }

  /**
   * Owe a broadcast. A job already owed keeps its progress: only the evidence and the kind can
   * move, and only towards more urgent.
   */
  async enqueue(input: NewBroadcastJob, now: number = Date.now()): Promise<BroadcastJob> {
    const address = keyOf(input.address)
    await this.store.load()
    const existing = this.store.getByKey(address)
    if (existing) {
      if (input.shownAt !== undefined) await this.markShown(address, input.shownAt)
      if (input.fundedAt !== undefined) await this.markFunded(address, input.fundedAt)
      return this.store.getByKey(address)!
    }
    return this.store.setRecord(address, {
      ...input,
      address,
      createdAt: now,
      state: input.txHash ? "sent" : "queued",
      failures: 0,
    })
  }

  /** The user saw the address: a pool job becomes theirs, with none of the pool's failures. */
  async markShown(address: string, now: number = Date.now()): Promise<void> {
    await this.update(address, (job) =>
      job.kind === "pool"
        ? { ...job, shownAt: job.shownAt ?? now, kind: "deposit", failures: 0, retryAt: undefined }
        : job.shownAt !== undefined
        ? null
        : { ...job, shownAt: now },
    )
  }

  /** Funds are waiting on it: a job backing off runs at once. */
  async markFunded(address: string, now: number = Date.now()): Promise<void> {
    await this.update(address, (job) =>
      job.fundedAt !== undefined
        ? null
        : { ...job, fundedAt: now, retryAt: job.state === "queued" ? undefined : job.retryAt },
    )
  }

  async setOperation(address: string, operationId: string): Promise<void> {
    await this.update(address, (job) =>
      job.operationId === operationId ? null : { ...job, operationId },
    )
  }

  async markProving(address: string): Promise<void> {
    await this.update(address, (job) => ({
      ...job,
      state: "proving",
      retryAt: undefined,
      txHash: undefined,
    }))
  }

  /** The proven tx's hash, known just before it is sent: a reload then asks the chain about it. */
  async noteTxHash(address: string, txHash: string): Promise<void> {
    await this.update(address, (job) => (job.txHash === txHash ? null : { ...job, txHash }))
  }

  async markSent(address: string, txHash: string): Promise<void> {
    await this.update(address, (job) => ({ ...job, state: "sent", txHash }))
  }

  async markLanded(address: string, now: number = Date.now()): Promise<void> {
    await this.update(address, (job) => ({
      ...job,
      state: "landed",
      landedAt: now,
      retryAt: undefined,
    }))
  }

  /** The attempt failed: back to the queue after a backoff. */
  async markFailed(address: string, error: string, now: number = Date.now()): Promise<void> {
    await this.update(address, (job) => {
      const failures = job.failures + 1
      return {
        ...job,
        state: "queued",
        failures,
        lastError: error,
        txHash: undefined,
        retryAt: now + retryDelay(failures),
      }
    })
  }

  /** Not possible yet (a locked wallet, a registration still landing): try again at `until`. */
  async defer(address: string, until: number, reason: string): Promise<void> {
    await this.update(address, (job) => ({
      ...job,
      state: "queued",
      lastError: reason,
      retryAt: until,
    }))
  }

  /** The user asked for another try: clears the backoff and the failure count. */
  async retryNow(address: string): Promise<void> {
    await this.update(address, (job) =>
      job.state === "queued" ? { ...job, failures: 0, retryAt: undefined } : null,
    )
  }

  /**
   * A page stopped while building a job. One whose hash was known may have reached the node, so the
   * chain decides it; any other is owed again. The interruption is not counted as a failure.
   */
  async recoverInterrupted(): Promise<void> {
    await this.store.load()
    for (const job of this.list()) {
      if (job.state !== "proving") continue
      await this.update(job.address, (j) => ({ ...j, state: j.txHash ? "sent" : "queued" }))
    }
  }

  /** The owner no longer needs it, e.g. a registration restarted at another address. */
  async remove(address: string): Promise<void> {
    await this.store.removeByKey(keyOf(address))
  }

  private async update(
    address: string,
    patch: (job: BroadcastJob) => BroadcastJob | null,
  ): Promise<void> {
    // A landed job is finished: nothing moves it again.
    await this.store.updateRecord(keyOf(address), (job) =>
      job && job.state !== "landed" ? patch(job) : null,
    )
  }
}
