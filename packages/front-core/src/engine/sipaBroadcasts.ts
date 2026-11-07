/**
 * Runs the SIPA broadcasts this wallet owes, one at a time, until each has landed. A SIPA's funds
 * reach the user only once its broadcast tells the relayer it exists. Registrations go first, since
 * no deposit broadcast is sponsored before the name lands; then funded addresses, then the user's
 * own, then the pool, each oldest first. One runs at a time because every sponsored broadcast spends
 * the account's subscription note, and the PXE cannot see a pending spend. Each attempt first asks
 * whether the broadcast already landed, and a failed one retries after a backoff, without end.
 */
import type { OperationStore } from "../core/services/operations/OperationStore"
import { bestEffort, WalletError, toFailure } from "./errors"
import { loadRecords, type RecordSet } from "./persistentStore"
import type { Resource } from "./resource"
import { task, within, type Task } from "./runtime"
import type {
  BroadcastJob,
  BroadcastSource,
  SipaBroadcastWait,
  SipaDeposit,
  SipaDeposits,
} from "./sipaDeposits"
import { selectSipaDeposit } from "./sipaDeposits"
import type { ReadonlyStore } from "./store"

/** Thrown by an executor that cannot run the job yet: a locked wallet, a rail not open yet. */
export class BroadcastDeferred extends Error {
  constructor(readonly until: number, readonly wait?: SipaBroadcastWait) {
    super(wait ?? "deferred")
    this.name = "BroadcastDeferred"
  }
}

/** A job whose source is of type `T`. */
export type BroadcastJobOf<T extends BroadcastSource["type"]> = BroadcastJob & {
  source: Extract<BroadcastSource, { type: T }>
}

export interface BroadcastExecutor<J extends BroadcastJob = BroadcastJob> {
  /** The broadcast already landed: an earlier page sent it, or another device did. */
  landed(job: J): Promise<boolean>
  /**
   * Build and send it. `onTxHash` must resolve before the node takes the tx: it saves the hash, so
   * a page that stops mid-send leaves the chain to decide. Resolves once the node accepted the tx.
   * Throws `WalletError("deposit.addressRetired")` when nothing is left to publish.
   */
  send(
    job: J,
    attempt: { operationId?: string; onTxHash: (txHash: string) => Promise<void> },
  ): Promise<string>
  /** The broadcast landed, however the task learned it: the owner's records follow. */
  onLanded?(job: J): Promise<void> | void
}

/** One executor per source type. */
export type BroadcastExecutors = {
  [T in BroadcastSource["type"]]: BroadcastExecutor<BroadcastJobOf<T>>
}

export type BroadcastTxState = "included" | "pending" | "dropped"

/** How often a sent broadcast's receipt is read. */
export const SENT_POLL_MS = 5_000

/** How long a broadcast waits for an unlock or a claim server before asking again. */
export const BROADCAST_WAIT_MS = 30_000

/** Every record's broadcast, with its address. */
export function broadcastJobs(records: readonly SipaDeposit[]): BroadcastJob[] {
  return records.flatMap((r) =>
    r.broadcast ? [{ ...r.broadcast, address: r.sipaAddress.toLowerCase() }] : [],
  )
}

/** The broadcast of `address`, if one is owed or landed. */
export function broadcastJob(
  records: readonly SipaDeposit[],
  address: string,
): BroadcastJob | undefined {
  const record = selectSipaDeposit({ records }, address)
  return record?.broadcast && { ...record.broadcast, address: address.toLowerCase() }
}

const rank = (job: BroadcastJob) =>
  job.fundedAt !== undefined ? 0 : job.kind === "registration" ? 1 : job.kind === "deposit" ? 2 : 3

/** Jobs that wait their turn: open, and blocked only by the queue. */
function contenders(jobs: readonly BroadcastJob[]): BroadcastJob[] {
  const open = jobs.filter((job) => job.state !== "landed")
  if (open.some((job) => job.state === "proving" || job.state === "sent")) return []
  const registrations = open.filter((job) => job.kind === "registration")
  return registrations.length > 0 ? registrations : open
}

/** The broadcast that runs next, if one is due. */
export function nextBroadcast(
  jobs: readonly BroadcastJob[],
  now: number,
): BroadcastJob | undefined {
  return contenders(jobs)
    .filter((job) => (job.retryAt ?? 0) <= now)
    .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)[0]
}

/** Resolves true once the broadcast landed, false once an attempt fails or the job ends without one. */
export function broadcastSettled(
  view: ReadonlyStore<RecordSet<SipaDeposit>>,
  address: string,
): Promise<boolean> {
  let failures: number | undefined
  return watchJob(view, address, (job) => {
    failures ??= job?.failures ?? 0
    return job?.state === "landed" ? true : !job || job.failures > failures ? false : undefined
  })
}

/** Resolves once no attempt is proving or sent: it landed, failed, waits for its turn, or is gone. */
export function broadcastAttemptEnded(
  view: ReadonlyStore<RecordSet<SipaDeposit>>,
  address: string,
): Promise<void> {
  return watchJob(view, address, (job) =>
    job?.state === "proving" || job?.state === "sent" ? undefined : true,
  ).then(() => undefined)
}

/** Settles with `decide`'s first defined answer over the loaded records. */
export function watchJob<T>(
  view: ReadonlyStore<RecordSet<SipaDeposit>>,
  address: string,
  decide: (job: BroadcastJob | undefined) => T | undefined,
): Promise<T> {
  return new Promise((resolve) => {
    let done = false
    const check = () => {
      const { records, loaded } = view.get()
      if (done || !loaded) return
      const outcome = decide(broadcastJob(records, address))
      if (outcome === undefined) return
      done = true
      off()
      resolve(outcome)
    }
    const off = view.subscribe(check)
    check()
  })
}

export interface SipaBroadcastsDeps<W> {
  wallet: Resource<W>
  store: Pick<SipaDeposits, "view" | "ready" | "apply">
  operations: Pick<
    OperationStore,
    "begin" | "resume" | "markSent" | "settle" | "remove" | "release" | "get"
  >
  executors(wallet: W): BroadcastExecutors
  /** Where a sent tx stands. An unreachable node reads as `pending`. */
  txState(wallet: W, txHash: string): Promise<BroadcastTxState>
  /** Runs one attempt behind the wallet's one-proof-at-a-time gate. */
  runExclusive<T>(attempt: () => Promise<T>): Promise<T>
  /** True while the user's own transaction, or another background proof, runs. */
  busy?(): boolean
  /** The operation a job's attempts run as; none for a job nobody has seen. */
  describe(job: BroadcastJob): { flow: string; summary: string; background?: boolean } | undefined
  /** The account scope the job's operations carry. */
  scope: string | null
  now?(): number
}

export interface SipaBroadcastsTask {
  task: Task
  /**
   * This page sends the address's tx itself. Its hash is saved before the node takes the tx, so
   * until the send settles the node may not know it yet: a held job is not decided or run.
   */
  hold(address: string): () => void
}

export function sipaBroadcasts<W>(deps: SipaBroadcastsDeps<W>): SipaBroadcastsTask {
  const { store, operations } = deps
  const now = deps.now ?? Date.now
  const held = new Map<string, number>()

  const jobs = () => broadcastJobs(store.view.get().records).filter((job) => !held.has(job.address))
  const current = (job: BroadcastJob) => broadcastJob(store.view.get().records, job.address) ?? job

  /** The owner's records follow first. False when they could not: the job stays open. */
  const landed = async (executor: BroadcastExecutor, job: BroadcastJob) => {
    const recorded = await bestEffort(
      "unknown",
      (async () => {
        await executor.onLanded?.(current(job))
        return true
      })(),
    )
    if (!recorded) return false
    await store.apply(job.address, { type: "broadcastLanded" })
    if (job.operationId) await operations.settle(job.operationId, job.txHash)
    return true
  }

  /**
   * Marks the job proving, under the operation this page owns for the attempt: resumed, or begun
   * once. Linked first: an operation begun but never linked would hold the leave guard with no owner.
   */
  const own = async (job: BroadcastJob): Promise<string | undefined> => {
    const shown = deps.describe(job)
    const resumed = job.operationId && operations.get(job.operationId) ? job.operationId : undefined
    const operationId = shown && (resumed ?? job.operationId ?? `broadcast_${job.address}_${now()}`)
    await store.apply(job.address, { type: "broadcastProving", operationId })
    if (resumed) await operations.resume(resumed)
    else if (shown && operationId)
      await operations.begin({ operationId, ...shown, scope: deps.scope, resumable: true }, now())
    return operationId
  }

  const attempt = async (executor: BroadcastExecutor, job: BroadcastJob, signal: AbortSignal) => {
    // A landing that cannot be read is no landing: the attempt asks the chain again next time. An
    // abort ends the attempt.
    if (await within(bestEffort("unknown", executor.landed(job)), "broadcast landed", { signal })) {
      if (!(await landed(executor, job)))
        await store.apply(job.address, { type: "broadcastDeferred", until: now() + SENT_POLL_MS })
      return
    }
    let operationId: string | undefined
    let txHash: string
    try {
      operationId = await own(job)
      txHash = await deps.runExclusive(() =>
        executor.send(job, {
          operationId,
          onTxHash: async (hash) => {
            await store.apply(job.address, { type: "broadcastHash", txHash: hash })
          },
        }),
      )
    } catch (err) {
      if (err instanceof BroadcastDeferred) {
        await store.apply(job.address, {
          type: "broadcastDeferred",
          until: err.until,
          wait: err.wait,
        })
      } else if (err instanceof WalletError && err.code === "deposit.addressRetired") {
        // Nothing was lost and nothing is worth reporting: the owner moved on.
        await store.apply(job.address, { type: "broadcastAbandoned" })
        if (operationId) await operations.remove(operationId)
      } else {
        // A hash means the node may hold the tx (a wait that timed out): the chain decides it.
        const noted = current(job).txHash
        await store.apply(
          job.address,
          noted
            ? { type: "broadcastSent", txHash: noted }
            : {
                type: "broadcastFailed",
                failure: toFailure(err, "deposit.broadcastFailed"),
                at: now(),
              },
        )
      }
      return
    } finally {
      if (operationId) operations.release(operationId)
    }
    await store.apply(job.address, { type: "broadcastSent", txHash })
    // The record holds the hash; the operation's copy only feeds the bell.
    if (operationId) await bestEffort("unknown", operations.markSent(operationId, txHash))
  }

  /** One step. True when another may follow at once. */
  const step = async (wallet: W, signal: AbortSignal): Promise<boolean> => {
    const executors = deps.executors(wallet)
    const executor = (job: BroadcastJob): BroadcastExecutor => executors[job.source.type]
    const open = jobs()
    const sent = open.find((job) => job.state === "sent")
    if (sent) {
      const state = await within(deps.txState(wallet, sent.txHash!), "broadcast state", { signal })
      if (state === "pending") return false
      if (state === "included") return landed(executor(sent), sent)
      await store.apply(sent.address, {
        type: "broadcastFailed",
        failure: { code: "deposit.broadcastDropped" },
        at: now(),
      })
      return true
    }
    if (deps.busy?.()) return false
    const job = nextBroadcast(open, now())
    if (!job) return false
    await attempt(executor(job), job, signal)
    return true
  }

  return {
    task: task("sipaBroadcasts", {
      needs: { wallet: deps.wallet },
      after: { firstBalance: true },
      every: SENT_POLL_MS,
      whenHidden: SENT_POLL_MS,
      backoff: { baseMs: 5_000, maxMs: 60_000 },
      async run({ wallet, signal }) {
        const records = await within(loadRecords(store.view), "sipaBroadcasts", { signal })
        // Runs go one at a time, so no attempt of this page is proving: a proving job is one an
        // earlier page or run left. It is owed again, or decided by the chain.
        for (const job of broadcastJobs(records).filter((j) => j.state === "proving"))
          await store.apply(job.address, { type: "broadcastInterrupted" })
        while (!signal.aborted && (await step(wallet, signal)));
      },
    }),
    hold(address) {
      const key = address.toLowerCase()
      held.set(key, (held.get(key) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const left = held.get(key)! - 1
        if (left > 0) held.set(key, left)
        else held.delete(key)
      }
    },
  }
}
