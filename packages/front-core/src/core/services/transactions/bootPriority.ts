/**
 * Boot order: the balance first. PXE runs one job at a time, so every reader started at unlock
 * delays the first balance, and each one that syncs or adds a tagging source wipes the token's note
 * discovery or moves the anchor the balance read checks. The coordinator's first read settles
 * `notes`. `deposits` settles once the deposits the balance is missing are stored again: the first
 * SIPA pass, and on a device that is catching up, the replay of its Savings moves, whose rebuilt
 * deposits can still be unspent. `history` follows once the activity scanner's first pass also
 * reaches head: a proof holds PXE's one job slot for its whole run, so one started earlier stalls
 * the scanner's remaining reads and the activity list with them. `BOOT_ORDER` names every other
 * boot-time reader and the stage it waits for, and is the one place that order is set.
 *
 * A notes wait gives up after `BOOT_WAIT_MS`, so a sync that stalls, or is paused because the tab
 * is hidden, cannot starve the rest. It is never shorter than the scanner's catch-up read, or
 * waiters would flood the queue in the middle of the very first note discovery they wait for.
 * `deposits` settles on its own `DEPOSITS_WAIT_MS` after `notes`, so a slow L1 cannot hold the
 * other readers. `history` likewise settles on `HISTORY_WAIT_MS` after the balance.
 *
 * A catch-up that starts before the balance settles opens a boot sync that lasts until the replays
 * end, even past `DEPOSITS_WAIT_MS`, so the balance never changes once it stops showing as syncing;
 * it closes regardless `BALANCE_SYNC_WAIT_MS` after `notes`. While open, the balance shows as
 * "syncing deposits", since it can still be short of replayed claims, and the sync holds a catch-up
 * of its own so the activity skeleton stays up across the gap between the scanner's pass and the
 * replays. It never reopens once closed. Readers at `restore` rebuild what a replay needs: at
 * `notes` while the boot sync is open, else at `settled`.
 */

import { logger } from "src/utils/logger"
import { globalEventEmitter } from "../GlobalEventEmitter"
import { TRANSFER_SCAN_CATCH_UP_TIMEOUT_MS } from "./TransferEventScanner"

export const BOOT_WAIT_MS = TRANSFER_SCAN_CATCH_UP_TIMEOUT_MS
export const DEPOSITS_WAIT_MS = 60_000
export const BALANCE_SYNC_WAIT_MS = 180_000
export const HISTORY_WAIT_MS = 60_000

/**
 * `notes`: the first balance. `settled`: the balance with the replayed deposits in it. `history`:
 * settled, and the activity history read up to head. `restore`: `notes` on a device catching up,
 * `settled` otherwise.
 */
type BootStage = "notes" | "restore" | "settled" | "history"

/** What each boot-time reader waits for. */
export const BOOT_ORDER = {
  /** The SIPA pass; its first clean run settles `deposits`. */
  deposits: "notes",
  /** A catching-up device's Savings moves: their burns rebuilt, then their deposits stored. */
  savingsMoves: "restore",
  /** The Savings token and its position. */
  savings: "notes",
  /** Owed SIPA broadcasts: tagging sources, then a proof. */
  broadcasts: "notes",
  /** The reorg monitor's PXE sync after it settles records. */
  reorgSync: "notes",
  /** The XMTP client: a large WASM, a database and a network sync. */
  messaging: "notes",
  /** The resolver payment watcher: L1 polls and address derivation, no PXE work. */
  resolverPayments: "notes",
  withdrawalRescan: "restore",
  paylinkRescan: "settled",
  migrationProbe: "settled",
  /** A fresh device's search for registration addresses it has no record of. */
  registrationDiscovery: "settled",
  /** A pool fill is a proof. */
  depositPool: "history",
} as const satisfies Record<string, BootStage>

export type BootReader = keyof typeof BOOT_ORDER

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
  private readonly sipa = deferred()
  private readonly moves = deferred()
  private readonly deposits = deferred()
  private readonly caughtUp = deferred()
  private readonly settled: Promise<void>
  private readonly history: Promise<void>
  private notesReached = false
  private balanceSettled = false
  /** The replays ended, or the boot sync stopped waiting for them. */
  private replaysEnded = false
  /** The boot sync was open at `notes`: restore readers run then, and the moves replay counts. */
  private restoring = false
  private historySettled = false
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
      syncWaitMs?: number
      historyWaitMs?: number
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
      // A sync whose notes wait gave up has no replay to wait for.
      void this.whenStage("settled").then(() => {
        if (!this.notesReached) this.closeSync()
      })
    }
    let notesAt = 0
    void Promise.all([this.sipa.promise, this.moves.promise]).then(() => {
      this.deposits.resolve()
      this.endReplays()
    })
    void this.notes.promise.then(() => {
      notesAt = now()
      this.notesReached = true
      this.restoring = this.syncing
      if (!this.restoring) this.moves.resolve()
      setTimeout(() => {
        if (!this.balanceSettled)
          logger.warn("[bootPriority] deposit replay still running; readers not waiting")
        this.deposits.resolve()
      }, opts.depositsWaitMs ?? DEPOSITS_WAIT_MS)
      setTimeout(() => {
        if (this.syncing && !this.replaysEnded)
          logger.warn(
            "[bootPriority] deposit replay still running; balance stops showing as syncing",
          )
        this.endReplays()
      }, opts.syncWaitMs ?? BALANCE_SYNC_WAIT_MS)
    })
    this.settled = Promise.all([this.notes.promise, this.deposits.promise]).then(() => {
      this.balanceSettled = true
      catchUp.offSyncCatchUpChanged(onCatchUp)
      if (this.replaysEnded) this.closeSync()
      logger.log(
        `[bootPriority] balance settled at ${Math.round(now())}ms (notes at ${Math.round(
          notesAt,
        )}ms)`,
      )
      setTimeout(() => {
        if (!this.historySettled)
          logger.warn("[bootPriority] activity history still catching up; not waiting")
        this.caughtUp.resolve()
      }, opts.historyWaitMs ?? HISTORY_WAIT_MS)
    })
    this.history = Promise.all([this.settled, this.caughtUp.promise]).then(() => {
      this.historySettled = true
      logger.log(`[bootPriority] history settled at ${Math.round(now())}ms`)
    })
    catchUp.onSyncCatchUpChanged(onCatchUp)
    onCatchUp(catchUp.isSyncCatchingUp())
  }

  /** The coordinator published its first balance. */
  notesSynced(): void {
    this.notes.resolve()
  }

  /** The activity scanner read up to head. */
  historyReplayed(): void {
    this.caughtUp.resolve()
  }

  /** The first SIPA pass's items checked so far; ignored unless the boot sync is open. */
  depositProgress(done: number, total: number): void {
    if (!this.syncing || total === 0) return
    this.progress = done / total
    this.notify()
  }

  /** The first SIPA pass ended, claims included. */
  depositsReplayed(): void {
    this.sipa.resolve()
  }

  /** A settle pass that began after the Savings moves were rebuilt ended. */
  movesReplayed(): void {
    this.moves.resolve()
  }

  /** Resolves when `reader` may start: its stage was reached, or each stage's wait gave up. */
  whenReady(reader: BootReader): Promise<void> {
    return this.whenStage(BOOT_ORDER[reader])
  }

  /** Whether `reader`'s stage has been reached; a wait that gave up does not count. */
  isReady(reader: BootReader): boolean {
    const stage: BootStage = BOOT_ORDER[reader]
    if (stage === "history") return this.historySettled
    if (stage === "notes" || (stage === "restore" && this.restoring)) return this.notesReached
    return this.balanceSettled
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

  private endReplays(): void {
    this.replaysEnded = true
    if (this.balanceSettled) this.closeSync()
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

  private async whenStage(stage: BootStage): Promise<void> {
    await this.bounded(this.notes.promise)
    if (stage === "notes" || (stage === "restore" && this.restoring)) return
    await this.bounded(this.settled)
    if (stage === "history") await this.bounded(this.history)
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
