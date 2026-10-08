/**
 * Boot order: the balance first. PXE runs one job at a time, so on a fresh device every reader
 * started at unlock delays the first balance, and each one that syncs or adds a tagging source
 * wipes the token's note discovery. The coordinator's first read settles `notes`; the first SIPA
 * pass, whose replayed claims the balance includes, waits for it and then settles `deposits`;
 * every other boot-time PXE reader waits for both.
 *
 * A notes wait gives up after `BOOT_WAIT_MS`, so a sync that stalls, or is paused because the tab
 * is hidden, cannot starve the rest. It is never shorter than the scanner's catch-up read, or
 * waiters would flood the queue in the middle of the very first note discovery they wait for.
 * `deposits` settles on its own `DEPOSITS_WAIT_MS` after `notes`, so a slow L1 cannot hold the
 * balance or the other readers.
 *
 * A catch-up that starts before the balance settles opens a boot sync that lasts until it does: the
 * balance shows as "syncing deposits", since it can still be short of replayed claims, and the
 * sync holds a catch-up of its own so the activity skeleton stays up across the gap between the
 * scanner's pass and the SIPA replay. It never reopens once closed.
 */

import { logger } from "src/utils/logger"
import { globalEventEmitter } from "../GlobalEventEmitter"
import { TRANSFER_SCAN_CATCH_UP_TIMEOUT_MS } from "./TransferEventScanner"

export const BOOT_WAIT_MS = TRANSFER_SCAN_CATCH_UP_TIMEOUT_MS
export const DEPOSITS_WAIT_MS = 60_000

type CatchUpSource = Pick<
  typeof globalEventEmitter,
  "beginSyncCatchUp" | "isSyncCatchingUp" | "onSyncCatchUpChanged" | "offSyncCatchUpChanged"
>

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

export class BootPriority {
  private readonly notes = deferred()
  private readonly deposits = deferred()
  private readonly settled: Promise<void>
  private balanceSettled = false
  private syncing = false
  private syncClosed = false
  private progress: number | null = null
  private endCatchUp: (() => void) | null = null
  private readonly listeners = new Set<() => void>()
  private readonly waitMs: number

  constructor(
    opts: {
      waitMs?: number
      depositsWaitMs?: number
      now?: () => number
      catchUp?: CatchUpSource
    } = {},
  ) {
    this.waitMs = opts.waitMs ?? BOOT_WAIT_MS
    const now = opts.now ?? (() => globalThis.performance?.now() ?? Date.now())
    const catchUp = opts.catchUp ?? globalEventEmitter

    const onCatchUp = (catchingUp: boolean) => {
      if (!catchingUp || this.syncing || this.syncClosed) return
      this.syncing = true
      this.endCatchUp = catchUp.beginSyncCatchUp()
      this.notify()
      void this.whenBalanceSettled().then(() => this.closeSync())
    }
    let notesAt = 0
    void this.notes.promise.then(() => {
      notesAt = now()
      setTimeout(() => {
        if (!this.balanceSettled)
          logger.warn("[bootPriority] deposit replay still running; not waiting")
        this.deposits.resolve()
      }, opts.depositsWaitMs ?? DEPOSITS_WAIT_MS)
    })
    this.settled = Promise.all([this.notes.promise, this.deposits.promise]).then(() => {
      this.balanceSettled = true
      catchUp.offSyncCatchUpChanged(onCatchUp)
      this.closeSync()
      logger.log(
        `[bootPriority] balance settled at ${Math.round(now())}ms (notes at ${Math.round(
          notesAt,
        )}ms)`,
      )
    })
    catchUp.onSyncCatchUpChanged(onCatchUp)
    onCatchUp(catchUp.isSyncCatchingUp())
  }

  /** The coordinator published its first balance. */
  notesSynced(): void {
    this.notes.resolve()
  }

  /** The first SIPA pass's items checked so far; ignored unless the boot sync is open. */
  depositProgress(done: number, total: number): void {
    if (!this.syncing || total === 0) return
    this.progress = done / total
    this.notify()
  }

  /** The first SIPA pass ended, claims included. */
  depositsReplayed(): void {
    this.deposits.resolve()
  }

  whenNotesSynced(): Promise<void> {
    return this.bounded(this.notes.promise)
  }

  async whenBalanceSettled(): Promise<void> {
    await this.whenNotesSynced()
    await this.bounded(this.settled)
  }

  /** A fresh device's first balance may still be short of deposits the replay has not claimed. */
  isBalanceSyncing(): boolean {
    return this.syncing
  }

  /** Share of the boot replay checked, 0–1; null until its total is known. */
  balanceSyncProgress(): number | null {
    return this.progress
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private closeSync(): void {
    if (this.syncClosed) return
    this.syncClosed = true
    this.syncing = false
    this.progress = null
    this.endCatchUp?.()
    this.endCatchUp = null
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private bounded(promise: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.waitMs)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
  }
}

/** One wallet per process; settles once per page load. */
export const bootPriority = new BootPriority()
