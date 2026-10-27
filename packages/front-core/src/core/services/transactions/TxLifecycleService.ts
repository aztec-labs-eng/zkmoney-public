import {
  PaylinkActionEnum,
  QueueStatus,
  TokenActionEnum,
  TransactionProgress,
  type IPendingTxStore,
  type PendingTxRecord,
} from "@obsidion/sdk"
import { provingProgress, ProvingStage } from "@obsidion/proving-progress"
import { EventEmitter } from "eventemitter3"
import {
  type TokenInTxService,
  type Transaction,
  type PaylinkAction,
  type Action,
  type TransactionStatus,
  FaucetActionEnum,
} from "../../../types"
import { TransactionTracker, QUEUE_UPDATE_EVENT, type TransactionQueueItem } from "./index"
import { TransactionStorage } from "../../storages/TransactionStorage"
import type {
  CoordinationLoopRegistration,
  CoordinationStateAggregate,
} from "./types"
import { WithdrawalStorage } from "../bridge/WithdrawalStorage"
import type { WithdrawalRecord } from "../bridge/types"

import { logger } from "src/utils/logger"
import { makeLimiter } from "src/utils/makeLimiter"

/**
 * `getTxReceipt` is the ONLY node API the lifecycle service touches. We model
 * it as a tiny structural type so tests can substitute a stub without pulling
 * an Aztec node mock through; production wires `createAztecNodeClient(...)`
 * here when the service is instantiated by `app/_layout.tsx`.
 */
export interface TxReceiptLike {
  isMined(): boolean
  isPending(): boolean
  isDropped(): boolean
  hasExecutionSucceeded(): boolean
}

export interface NodeLike {
  getTxReceipt(txHash: string): Promise<TxReceiptLike>
}

/**
 * Subscriber event surface: pending-record resolutions and expired-record
 * terminalizations. Subscribers filter on `type`.
 */
export type TxLifecycleEvent =
  | { type: "pending-resolved"; txHash: string; outcome: "success" | "dropped" | "reverted" }
  | { type: "pending-expired"; txHash: string }

export type TxLifecycleListener = (event: TxLifecycleEvent) => void

export interface TxLifecycleServiceOptions {
  pendingTxStore: IPendingTxStore
  node: NodeLike
  /**
   * Override for unit tests — defaults to `setInterval` / `clearInterval`.
   * Production should not pass these.
   */
  scheduler?: {
    setInterval: (cb: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
  /** Optional clock for tests; defaults to `Date.now`. */
  now?: () => number
}

const POLL_INTERVAL_MS = 1_000
const SLOW_TICK_THRESHOLD_MS = 750
const SLOW_TICK_WARN_INTERVAL_MS = 60_000
const EXPIRY_SWEEP_INTERVAL_MS = 60_000
const RECEIPT_CONCURRENCY_LIMIT = 8

/**
 * TxLifecycleService. Owns every in-flight tx's lifecycle: the UI tx history
 * facade (queue manager + transaction storage rows) and the post-submit
 * resolution of pending records from their receipts.
 *
 * Single-writer model:
 * - SOLE writer of `pendingTxStore.remove` for the post-submit lifecycle. The
 *   wallet's `sendTx` catch-path undo is the only documented exception.
 * - Only **polling-driven** writer of `TransactionStorage` terminal status.
 *   Eager `completeTransaction` calls from send-screen hooks coexist; both
 *   paths are idempotent. The monotonicity guard on
 *   `TransactionStorage.updateTransactionCompletion` keeps a hook's CANCELLED
 *   write from being clobbered by a stale polling-loop SUCCESS.
 *
 * Polling model:
 * - 1Hz `setInterval` walks `pendingTxStore.list()` and resolves each record
 *   from its receipt: mined → success / reverted, dropped → dropped.
 * - Per-tick `getTxReceipt` concurrency capped at 8 via a semaphore.
 * - Slow-tick `console.warn` once per 60s if a tick takes > 750ms.
 *
 * Listener model:
 * - `pendingTxStore.onUpdated` is attached **synchronously inside `get(...)`
 *   before the constructor returns** so post-singleton wallet writes fire
 *   the listener. Pre-listener-attach writes are picked up by `resumeAll()`.
 *
 * Cleanup model:
 * - `expireAndTerminalize(txHash)` runs on three triggers (60s sweep, AppState
 *   'active', per-tick observation past `expiresAtMs`). Concurrent triggers
 *   are deduped via `activeExpirations` (process-local Set, JS-single-threaded
 *   = atomic).
 *
 * For the existing `TxLifecycleService` surface (recordTransaction,
 * completeTransaction, getTransactions, ...), the public method signatures
 * are preserved verbatim so downstream callers compile unchanged.
 */
export class TxLifecycleService {
  private static instance: TxLifecycleService | null = null

  // ── Existing TxLifecycleService state ────────────────────────────────────
  private serviceSubscriptions = new Map<
    string,
    {
      service: EventEmitter
      handler: (stage: string, progress: number, txHash?: string) => void
    }
  >()

  // ── Pending-tx tracking state ────────────────────────────────────────────
  private pendingTxStore: IPendingTxStore | null = null
  private node: NodeLike | null = null
  private scheduler: NonNullable<TxLifecycleServiceOptions["scheduler"]> = {
    setInterval: (cb, ms) =>
      (globalThis as unknown as { setInterval: typeof setInterval }).setInterval(
        cb,
        ms,
      ),
    clearInterval: (handle) =>
      (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval(
        handle as ReturnType<typeof setInterval>,
      ),
  }
  private now: () => number = Date.now

  private listeners = new Set<TxLifecycleListener>()
  private pollIntervalHandle: unknown = null
  private expirySweepHandle: unknown = null
  private pendingStoreUnsubscribe: (() => void) | null = null

  /** activeExpirations dedupe. */
  private activeExpirations = new Set<string>()

  /** activeProbes dedupe for resumeAll. */
  private activeProbes = new Set<string>()

  private lastSlowWarnAt = 0

  /** Ticking guard so overlapping ticks don't compound. */
  private tickInFlight = false

  // ── Async-send synth-row + bridge ────────────────────────────────────────
  // Operation-id ↔ queue-id correlation. `subscribeToProvingProgress` reads
  // these maps from inside the `provingProgress.on('stage-start')` handler to
  // route a stage event to the matching synth row. Single-flight on send
  // bounds the maps to ~1 entry at a time; entries are removed in
  // `completeTransaction`.
  private operationToQueueId = new Map<string, string>()
  private queueIdToOperationId = new Map<string, string>()

  /** Idempotency guard so the bridge listener wires exactly once. */
  private provingProgressBridgeWired = false
  /** Teardown handles for the bridge listeners (test-only `stop()`). */
  private bridgeTeardowns: Array<() => void> = []

  /**
   * Read-only registry of pending-coordination loops joined by
   * `getCoordinationState(txHash)`. Lifecycle does not mutate loop
   * records or own their oracles — keep the surface read-only to avoid
   * recreating the god-service shape the loops were extracted to escape.
   */
  private registeredCoordinationLoops = new Map<
    string,
    CoordinationLoopRegistration
  >()

  private constructor() {}

  // ─────────────────────────────────────────────────────────────────────────
  // Singleton accessors
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Backward-compat singleton accessor — the one used by every existing
   * `TxLifecycleService.getInstance()` caller. Returns the same instance as
   * `get()` but does NOT install the pending-tracking dependencies. Code that
   * needs the polling surface must call `get(opts)` once at boot before
   * reading via `getInstance()`.
   */
  static getInstance(): TxLifecycleService {
    if (!TxLifecycleService.instance) {
      TxLifecycleService.instance = new TxLifecycleService()
    }
    return TxLifecycleService.instance
  }

  /**
   * Polling-aware accessor. First call MUST pass `{ pendingTxStore, node }`;
   * subsequent calls return the same instance and ignore options (the shared
   * first-call-wins singleton pattern). Attaches the `pendingTxStore.onUpdated`
   * listener synchronously BEFORE returning so any wallet-side writes after
   * this point fire the listener.
   */
  static get(options?: TxLifecycleServiceOptions): TxLifecycleService {
    if (!TxLifecycleService.instance) {
      TxLifecycleService.instance = new TxLifecycleService()
    }
    if (options && !TxLifecycleService.instance.pendingTxStore) {
      TxLifecycleService.instance.attach(options)
    }
    return TxLifecycleService.instance
  }

  /**
   * Test-only reset. Stops timers, clears listeners, and detaches the
   * pending-store subscription so the next `get(...)` rebinds cleanly.
   */
  static reset(): void {
    const inst = TxLifecycleService.instance
    if (inst) {
      try {
        inst.stop()
      } finally {
        TxLifecycleService.instance = null
      }
    }
  }

  private attach(options: TxLifecycleServiceOptions): void {
    this.pendingTxStore = options.pendingTxStore
    this.node = options.node
    if (options.scheduler) this.scheduler = options.scheduler
    if (options.now) this.now = options.now

    // CRITICAL: attach onUpdated synchronously BEFORE we return so any
    // wallet-side `pendingTxStore.create` between this point and the first
    // `resumeAll()` walk fires the listener. Records that landed BEFORE
    // this attachment (boot races) are caught by `resumeAll()`'s walk.
    this.pendingStoreUnsubscribe = this.pendingTxStore.onUpdated((txHash) => {
      // The listener fires on every `create`/`patch`/`remove`; we use it to
      // ensure the polling loop is running. The actual resolution happens on
      // the next tick.
      this.ensurePollingStarted()
      // Touch the hash so a debugger / test can observe the wakeup.
      void txHash
    })

    this.ensurePollingStarted()
    this.ensureExpirySweepStarted()
    // wire the proving-progress bridge in full-account
    // mode. Test-account boot calls `subscribeToProvingProgress()` directly
    // because it skips `attach()` (no encrypted-store). The method is idempotent.
    this.subscribeToProvingProgress()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EXISTING TxLifecycleService surface — preserved verbatim
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a queue entry for any transaction type. Returns the queue ID.
   */
  async createQueueEntry(description: string, estimatedDuration: number = 120000): Promise<string> {
    const queueManager = TransactionTracker.getInstance()
    return await queueManager.addToQueue(description, estimatedDuration)
  }

  /**
   * Start tracking a transaction operation with optional service event subscription.
   */
  async startTrackingTx(
    operationType: Action,
    estimatedDuration: number = 240000,
    service: EventEmitter,
  ): Promise<string> {
    const descriptions = {
      [TokenActionEnum.SEND]: "Sending Token",
      [TokenActionEnum.RECEIVE]: "Receiving Token",
      [FaucetActionEnum.FAUCET]: "Receiving from Faucet",
      [PaylinkActionEnum.PAY]: "Creating Paylink",
      [PaylinkActionEnum.CLAIM]: "Claiming Paylink",
      [PaylinkActionEnum.CLAIM_BACK]: "Refunding Paylink",
      [PaylinkActionEnum.REFUNDED]: "Refunded Paylink",
      [PaylinkActionEnum.CLAIMED]: "Claimed Paylink",
    }

    const description = descriptions[operationType as keyof typeof descriptions] as string
    const queueId = await this.createQueueEntry(description, estimatedDuration)

    if (service) {
      this.autoSubscribeToService(service, queueId)
    }

    return queueId
  }

  private autoSubscribeToService(service: EventEmitter, queueId: string) {
    const queueManager = TransactionTracker.getInstance()
    const statusHandler = (stage: string, progress: number, txHash?: string) => {
      queueManager.updateStatus(queueId, stage as QueueStatus, progress, undefined, txHash)
    }
    service.on("status", statusHandler)
    this.serviceSubscriptions.set(queueId, { service, handler: statusHandler })
  }

  recordTransaction(
    queueId: string,
    txHash: string,
    actionType: Action,
    params: {
      token?: TokenInTxService
      recipient?: string
      payToEmailSecret?: string
      obsidionAccountAddress?: string
      partialAddress?: string
      tokenAddress?: string
      paylink?: string
      status?: QueueStatus
      hasUnknownAmount?: boolean
      /**
       * Direct vs email-bound paylink discriminator. REQUIRED when
       * `actionType` is a paylink action; ignored for token/faucet actions.
       * Omitting it on a paylink write throws — silently defaulting would
       * write a row with the wrong flavor that the read-time projection
       * cannot recover (the heuristic only fires when `flavor` is missing).
       */
      flavor?: "direct" | "email" | "zk"
    } = {},
  ): void {
    const {
      token,
      recipient,
      payToEmailSecret,
      obsidionAccountAddress,
      partialAddress,
      tokenAddress,
      paylink,
      status,
      hasUnknownAmount,
      flavor,
    } = params

    try {
      if (this.isTokenAction(actionType)) {
        if (!token) {
          throw new Error("Token is required for token transactions")
        }
        TransactionStorage.get().addTokenTransaction(
          actionType as TokenActionEnum,
          token,
          status as TransactionStatus,
          txHash,
          recipient,
          queueId,
          hasUnknownAmount,
        )
        this.updateTransactionHash(queueId, txHash)
        return
      }

      if (this.isFaucetAction(actionType)) {
        if (!token) {
          throw new Error("Token is required for faucet transactions")
        }
        TransactionStorage.get().addFaucetTransaction(
          token,
          status as TransactionStatus,
          txHash as string,
          queueId,
        )
        this.updateTransactionHash(queueId, txHash)
        return
      }

      if (this.isPaylinkAction(actionType)) {
        if (!txHash) {
          throw new Error("txHash is required for paylink transactions")
        }
        if (flavor !== "direct" && flavor !== "email" && flavor !== "zk") {
          throw new Error(
            "flavor ('direct' | 'email' | 'zk') is required for paylink transactions",
          )
        }
        TransactionStorage.get().createPaylinkTransaction(
          queueId,
          txHash,
          actionType as PaylinkAction,
          flavor,
          token,
          recipient,
          payToEmailSecret,
          obsidionAccountAddress,
          partialAddress,
          tokenAddress,
          paylink,
        )
        this.updateTransactionHash(queueId, txHash)
        return
      }
    } catch (error) {
      logger.error(`Error recording transaction: ${error}`)
    }

    this.updateTransactionHash(queueId, txHash, "Unknown action type")
  }

  private isTokenAction(action: Action): boolean {
    return action === TokenActionEnum.SEND || action === TokenActionEnum.RECEIVE
  }

  private isFaucetAction(action: Action): boolean {
    return action === FaucetActionEnum.FAUCET
  }

  private isPaylinkAction(action: Action): boolean {
    return (
      action === PaylinkActionEnum.PAY ||
      action === PaylinkActionEnum.CLAIM ||
      action === PaylinkActionEnum.CLAIM_BACK ||
      action === PaylinkActionEnum.REFUNDED ||
      action === PaylinkActionEnum.CLAIMED
    )
  }

  updateTransactionHash(queueId: string, txHash: string, error?: string): void {
    const queueManager = TransactionTracker.getInstance()

    queueManager.updateStatus(
      queueId,
      QueueStatus.MINING,
      TransactionProgress.MINING,
      error,
      txHash,
    )

    const queueItem = queueManager.getQueue().find((item) => item.id === queueId)
    if (queueItem) {
      TransactionStorage.get().updateActiveTransactionsFromQueue([queueItem])
    }
  }

  /**
   * Complete a transaction (success / failure / cancelled). The widened
   * `status` parameter accepts `CANCELLED` (widening on
   * `TransactionStorage.updateTransactionCompletion`); callers that only
   * know the SUCCESS/FAILED tri-state continue to compile.
   */
  completeTransaction(
    queueId: string,
    status: QueueStatus,
    txHash?: string,
    error?: string,
  ): void {
    const queueManager = TransactionTracker.getInstance()

    let queueStatus: QueueStatus
    let progress: number
    if (status === QueueStatus.SUCCESS) {
      queueStatus = QueueStatus.SUCCESS
      progress = TransactionProgress.SUCCESS
    } else if (status === QueueStatus.CANCELLED) {
      queueStatus = QueueStatus.CANCELLED
      progress = TransactionProgress.FAILED
    } else {
      queueStatus = QueueStatus.FAILED
      progress = TransactionProgress.FAILED
    }

    queueManager.updateStatus(queueId, queueStatus, progress, error, txHash)

    const completionTime = Date.now()
    TransactionStorage.get().updateTransactionCompletion(
      queueId,
      queueStatus as QueueStatus.SUCCESS | QueueStatus.FAILED | QueueStatus.CANCELLED,
      completionTime,
    )

    const subscription = this.serviceSubscriptions.get(queueId)
    if (subscription) {
      subscription.service.off("status", subscription.handler)
      this.serviceSubscriptions.delete(queueId)
    }

    // drop the op-id ↔ queue-id mapping so the bridge stops routing late
    // stage events to a now-terminal row.
    this.clearOperationMapping(queueId)
  }

  updateTransactionProgress(
    queueId: string,
    status: QueueStatus,
    progress: number,
    txHash?: string,
  ): void {
    const queueManager = TransactionTracker.getInstance()
    queueManager.updateStatus(queueId, status, progress, undefined, txHash)
    const queueItem = queueManager.getQueue().find((item) => item.id === queueId)
    if (queueItem) {
      TransactionStorage.get().updateActiveTransactionsFromQueue([queueItem])
    }
  }

  async getTransactions(): Promise<Transaction[]> {
    return TransactionStorage.get().getTransactions()
  }

  async getActiveTransactions(): Promise<Transaction[]> {
    const transactions = await this.getTransactions()
    return transactions.filter((tx) => tx.status === QueueStatus.PENDING)
  }

  // ==========================================================================
  // Coordination-loop registry
  // ==========================================================================

  /**
   * Register a coordination loop's read-only `getRecordByTxHash` accessor.
   * Last-writer-wins on `id` so remount-driven re-registration is safe.
   */
  registerCoordinationLoop(registration: CoordinationLoopRegistration): void {
    this.registeredCoordinationLoops.set(registration.id, registration)
  }

  unregisterCoordinationLoop(id: string): void {
    this.registeredCoordinationLoops.delete(id)
  }

  /**
   * Join across registered loops for `txHash`. Returns `{}` when none are
   * registered. Only loop-managed records are joined here; `PendingTxStore`
   * is owned directly and can be folded in when a consumer needs it.
   */
  getCoordinationState(txHash: string): CoordinationStateAggregate {
    const result: CoordinationStateAggregate = {}
    for (const [id, registration] of this.registeredCoordinationLoops) {
      result[id] = registration.getRecordByTxHash(txHash)
    }
    return result
  }

  clearTransactions(): void {
    TransactionStorage.get().clearTransactions()
  }

  /**
   * Terminal-status writeback for a resolved pending record: the tx receipt
   * was observed mined / dropped / reverted. Errors are logged and swallowed
   * so a storage-layer failure does not derail the polling loop.
   */
  private async writePendingResolvedToTransactionStorage(
    txHash: string,
    outcome: "success" | "reverted" | "dropped",
  ): Promise<void> {
    const status =
      outcome === "success" ? QueueStatus.SUCCESS : QueueStatus.FAILED
    try {
      const result = await TransactionStorage.get().updateByTxHash(txHash, status)
      // Free the op-id maps on the terminal write. This is the dominant
      // SUCCESS path for paylink-create rows, which never go through
      // `completeTransaction`.
      if (result.queueId !== undefined) {
        this.clearOperationMapping(result.queueId)
      }
    } catch (err) {
      logger.warn(
        `[TxLifecycleService] writePendingResolvedToTransactionStorage failed for ${txHash}:`,
        err,
      )
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Async-send synth-row + proving-progress bridge
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * persist a synthetic Pending row at Confirm tap so the activity feed
   * shows the send before `wallet.sendTx` returns. The row holds the visible
   * recipient + token amount but no `txHash` yet — `patchTxHashForQueue`
   * writes that once submit returns.
   *
   * Also registers the `operationId → queueId` correlation that
   * `subscribeToProvingProgress` reads to route stage events. The mapping
   * MUST be in place before the wallet's first `emitStageStart` fires; the
   * caller (`usePaymentFlow.handleConfirmSend`) achieves this by awaiting
   * `recordPreSubmitSendRow` before dispatching `sendToken({ operationId })`.
   *
   * Idempotent on the map (a re-call with the same op id overwrites). The
   * storage row is appended once per call; callers should guard against
   * double-submit via the queue-id stability check in `handleConfirmSend`.
   */
  async recordPreSubmitSendRow(
    queueId: string,
    operationId: string,
    params: { token: TokenInTxService; recipient: string },
  ): Promise<void> {
    this.operationToQueueId.set(operationId, queueId)
    this.queueIdToOperationId.set(queueId, operationId)
    await TransactionStorage.get().addPreSubmitTokenTransaction(
      queueId,
      operationId,
      params.token,
      params.recipient,
    )
  }

  /**
   * persist a synthetic Pending paylink row at Confirm tap so the activity
   * feed shows the in-flight paylink-create before the wallet's deposit tx
   * returns. Mirrors `recordPreSubmitSendRow` for paylink flows: registers
   * the operationId ↔ queueId correlation so `subscribeToProvingProgress`'s
   * stage-event bridge can advance this row's `detailedStatus`.
   *
   * Caller MUST mint `operationId` via `nextOperationId("paylink-create")`
   * before invoking this method, then thread the same id through
   * `paylinkService.createPaylinkContract({ operationId })` so the wallet's
   * proving-progress events emit with the matching correlator. The
   * synthetic row is written under `kind: "paylink-create"` and uses the
   * legacy `emailPaymentAction` field name so stored-row back-compat
   * is preserved.
   */
  async recordPreSubmitPaylinkRow(
    queueId: string,
    operationId: string,
    params: {
      action: PaylinkAction
      flavor: "direct" | "email" | "zk"
      token: TokenInTxService
      to?: string
      payToEmailSecret?: string
      obsidionAccountAddress?: string
      partialAddress?: string
      tokenAddress?: string
      paylink?: string
      memo?: string
      kind?: "paylink-create" | "paylink-claim" | "paylink-refund"
    },
  ): Promise<void> {
    this.operationToQueueId.set(operationId, queueId)
    this.queueIdToOperationId.set(queueId, operationId)
    await TransactionStorage.get().addPreSubmitPaylinkTransaction(queueId, operationId, {
      ...params,
      kind: params.kind ?? "paylink-create",
    })
  }

  /**
   * Persist a synthetic Pending withdraw row at Confirm tap.
   *
   * Unlike `recordPreSubmitSendRow` / `recordPreSubmitPaylinkRow`, the op-id ↔
   * queue-id maps are NOT populated: those drive `subscribeToProvingProgress`'s
   * bridge, which patches `TransactionStorage` only. Withdraw rows live in
   * `WithdrawalStorage`, so a patch keyed by a withdraw queueId would silently
   * no-op AND log a confusing `"[Bridge] patch FAILED"` on every Mining event.
   * The withdraw flow owns its own proving-progress bridge in `useWithdrawFlow`.
   */
  async recordPreSubmitWithdrawRow(record: WithdrawalRecord): Promise<void> {
    await WithdrawalStorage.get().create(record)
  }

  /**
   * write the real `txHash` onto a synth-row keyed by `queueId` after
   * `wallet.sendTx` resolves. The hash is what the polling loop's terminal
   * write matches the row on, and drives "view tx" deep links.
   */
  async patchTxHashForQueue(queueId: string, txHash: string): Promise<void> {
    await TransactionStorage.get().patchTxHashForQueue(queueId, txHash)
  }

  /**
   * write the post-submit paylink fields (secret, paylink URL, partial
   * address, token address) onto the paylink synth-row created via
   * `recordPreSubmitPaylinkRow`. These are derived from the deployed paylink
   * contract instance (`getContractInstance`) and the proven tx's offchain
   * effects, both of which are available only AFTER the paylink-create
   * dispatch returns from `paylinkService.createPaylinkContract`.
   */
  async patchPaylinkSynthRow(
    queueId: string,
    fields: {
      payToEmailSecret?: string
      paylink?: string
      partialAddress?: string
      tokenAddress?: string
      fallbackSecret?: string
      fromClaimable?: number
      untilClaimable?: number
      memo?: string
      refundableUntil?: number
    },
  ): Promise<void> {
    await TransactionStorage.get().patchPaylinkSynthRow(queueId, fields)
  }

  /**
   * wire the bridge listeners
   * independently of the pending-tracking attach path. Idempotent — safe to
   * call from both `attach()` (full-account boot) and the test-account boot in
   * `_layout.tsx`. The pending store is NOT required.
   *
   * Wires two listeners:
   *
   * 1. `provingProgress.on('stage-start')` — synchronous in-memory bridge that
   *    flips `TransactionTracker.updateStatus(queueId, mappedStatus)` for the
   *    queue id matching the event's `operationId`. The wallet emits
   *    `Mining` synchronously **before** `aztecNode.sendTx` runs, so the
   *    detail sheet pill reads `MINING` atomically with submit.
   *
   * 2. `TransactionTracker.QUEUE_UPDATE_EVENT` — async write-through so the
   *    persisted `TransactionStorage` row's `detailedStatus` catches up. The
   *    activity feed re-renders on the `transactionsUpdated` event from the
   *    storage save. Eventually-consistent vs the in-memory tracker.
   *
   * Stage → QueueStatus mapping:
   *   Simulating → SIMULATING
   *   Witgen     → PROVING   (witgen is part of the prove pipeline UX-wise)
   *   Proving    → PROVING
   *   Mining     → MINING
   *
   * Stage events whose `operationId` doesn't match any known queue id (e.g.
   * the wallet emitted before `recordPreSubmitSendRow` ran, or the row was
   * already terminalized) are dropped silently — the bridge degrades
   * gracefully rather than throwing.
   */
  subscribeToProvingProgress(): void {
    if (this.provingProgressBridgeWired) return
    this.provingProgressBridgeWired = true

    const onStageStart = (e: {
      stage: ProvingStage
      operationId?: string
      txHash?: string
    }) => {
      if (e.operationId === undefined) return
      const queueId = this.operationToQueueId.get(e.operationId)
      if (queueId === undefined) return
      const mapped = mapProvingStageToQueueStatus(e.stage)
      if (mapped === undefined) return

      // Always update the in-memory tracker so the queue snapshot reflects
      // the new stage (drives `QUEUE_UPDATE_EVENT` consumers).
      TransactionTracker.getInstance().updateStatus(queueId, mapped)

      // For the MINING + real-txHash event (the wallet emits this BEFORE
      // `aztecNode.sendTx` runs so the real hash is on the synth row at
      // submit), use the ATOMIC writer. Two separate `void` writes would
      // race on the load → mutate → save cycle — last writer wins, can lose
      // either detailedStatus or txHash.
      //
      // For all other stages (or Mining without txHash), fall through to the
      // queue-update bridge below which patches detailedStatus alone via
      // `patchDetailedStatusForQueue`.
      if (e.stage === ProvingStage.Mining && e.txHash !== undefined) {
        void TransactionStorage.get()
          .patchSynthRowAtMining(queueId, mapped, e.txHash)
          .catch((err) =>
            logger.error("[Bridge] patchSynthRowAtMining FAILED", err),
          )
      }
    }
    provingProgress.on("stage-start", onStageStart)
    this.bridgeTeardowns.push(() => provingProgress.off("stage-start", onStageStart))

    const onQueueUpdate = (queue: TransactionQueueItem[]) => {
      for (const item of queue) {
        if (!this.queueIdToOperationId.has(item.id)) continue
        void TransactionStorage.get()
          .patchDetailedStatusForQueue(item.id, item.status)
          .catch((err) =>
            logger.error("[Bridge] patchDetailedStatusForQueue FAILED", err),
          )
      }
    }
    const tracker = TransactionTracker.getInstance()
    tracker.on(QUEUE_UPDATE_EVENT, onQueueUpdate)
    this.bridgeTeardowns.push(() => tracker.off(QUEUE_UPDATE_EVENT, onQueueUpdate))
  }

  /** Internal: drop both directions of the op-id ↔ queue-id mapping. */
  private clearOperationMapping(queueId: string): void {
    const opId = this.queueIdToOperationId.get(queueId)
    if (opId !== undefined) this.operationToQueueId.delete(opId)
    this.queueIdToOperationId.delete(queueId)
  }

  /** Subscribe to all lifecycle events (pending resolution + expiry). */
  subscribe(listener: TxLifecycleListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Polling loop
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Idempotent: starts the 1Hz polling loop if not already running. The
   * listener attached at `attach` time also calls this so the loop spins up
   * when the wallet creates its first record.
   */
  private ensurePollingStarted(): void {
    if (!this.pendingTxStore || !this.node) return
    if (this.pollIntervalHandle !== null) return
    this.pollIntervalHandle = this.scheduler.setInterval(
      () => void this.runPollingTick(),
      POLL_INTERVAL_MS,
    )
  }

  private ensureExpirySweepStarted(): void {
    if (this.expirySweepHandle !== null) return
    if (!this.pendingTxStore) return
    this.expirySweepHandle = this.scheduler.setInterval(
      () => void this.runExpirySweep(),
      EXPIRY_SWEEP_INTERVAL_MS,
    )
  }

  /** Test/cleanup helper. */
  private stop(): void {
    if (this.pollIntervalHandle !== null) {
      this.scheduler.clearInterval(this.pollIntervalHandle)
      this.pollIntervalHandle = null
    }
    if (this.expirySweepHandle !== null) {
      this.scheduler.clearInterval(this.expirySweepHandle)
      this.expirySweepHandle = null
    }
    if (this.pendingStoreUnsubscribe) {
      this.pendingStoreUnsubscribe()
      this.pendingStoreUnsubscribe = null
    }
    this.listeners.clear()
    this.activeProbes.clear()
    this.activeExpirations.clear()
    // Bridge teardown — fires `provingProgress.off` and tracker.off so the
    // singleton-style global emitter is left clean for the next `get(...)`.
    for (const teardown of this.bridgeTeardowns) {
      try {
        teardown()
      } catch (err) {
        logger.warn("[TxLifecycleService] bridge teardown threw:", err)
      }
    }
    this.bridgeTeardowns = []
    this.provingProgressBridgeWired = false
    this.operationToQueueId.clear()
    this.queueIdToOperationId.clear()
    this.registeredCoordinationLoops.clear()
    this.pendingTxStore = null
    this.node = null
  }

  /**
   * One polling tick. Probes the receipt of every live pending record via
   * `handlePendingOnly`, at most `RECEIPT_CONCURRENCY_LIMIT` in flight.
   */
  async runPollingTick(): Promise<void> {
    if (!this.pendingTxStore || !this.node) return
    if (this.tickInFlight) return
    this.tickInFlight = true

    const tickStart = this.now()
    const limiter = makeLimiter(RECEIPT_CONCURRENCY_LIMIT)

    try {
      const pendingRecords = await this.pendingTxStore.list()
      const work = pendingRecords.map((pending) =>
        limiter(() => this.handlePendingOnly(pending)),
      )
      await Promise.all(work)
    } finally {
      const elapsed = this.now() - tickStart
      if (
        elapsed > SLOW_TICK_THRESHOLD_MS &&
        this.now() - this.lastSlowWarnAt > SLOW_TICK_WARN_INTERVAL_MS
      ) {
        logger.warn(`[TxLifecycleService] slow tick: ${elapsed}ms`)
        this.lastSlowWarnAt = this.now()
      }
      this.tickInFlight = false
    }
  }

  /**
   * Resolve one pending record from its receipt: mined → success / reverted,
   * dropped → dropped. A still-pending receipt or an RPC failure leaves the
   * record for the next tick.
   */
  private async handlePendingOnly(pending: PendingTxRecord): Promise<void> {
    const oReceipt = await this.tryGetReceipt(pending.txHash)
    if (oReceipt === "rpc-error") return

    if (oReceipt.isPending()) return

    if (oReceipt.isMined()) {
      const outcome: "success" | "reverted" = oReceipt.hasExecutionSucceeded()
        ? "success"
        : "reverted"
      await this.pendingTxStore!.remove(pending.txHash)
      // Mirror the terminal status onto the row so it flips out of PENDING.
      await this.writePendingResolvedToTransactionStorage(pending.txHash, outcome)
      this.emitListeners({
        type: "pending-resolved",
        txHash: pending.txHash,
        outcome,
      })
      return
    }

    if (oReceipt.isDropped()) {
      await this.pendingTxStore!.remove(pending.txHash)
      await this.writePendingResolvedToTransactionStorage(pending.txHash, "dropped")
      this.emitListeners({
        type: "pending-resolved",
        txHash: pending.txHash,
        outcome: "dropped",
      })
    }
  }

  /** `getTxReceipt` wrapper; a throw becomes the `"rpc-error"` sentinel. */
  private async tryGetReceipt(txHash: string): Promise<TxReceiptLike | "rpc-error"> {
    try {
      return await this.node!.getTxReceipt(txHash)
    } catch {
      return "rpc-error"
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Resume + expiry sweep
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Single cold-launch / `AppState.change → 'active'` entry point. Idempotent
   * via `activeProbes`. Hydrates the store, walks `pendingTxStore.list()` and
   * ensures the polling loop is running. Records persisted before launch or
   * written before the listener attached are caught here.
   */
  async resumeAll(): Promise<void> {
    this.requireAttached("resumeAll")
    await this.pendingTxStore!.load()
    const pendings = await this.pendingTxStore!.list()

    for (const p of pendings) {
      const k = p.txHash.toLowerCase()
      if (this.activeProbes.has(k)) continue
      this.activeProbes.add(k)
    }
    this.ensurePollingStarted()
    this.ensureExpirySweepStarted()
  }

  /**
   * Sweep tick — drives `expireAndTerminalize` for every record in
   * `pendingTxStore.listExpired()`. Triggered by 60s `setInterval` AND by
   * AppState 'active' transition (callers invoke `runExpirySweep()` on
   * foreground). Per-tick observation past `expiresAtMs` is also funneled
   * here via `expireAndTerminalize`.
   */
  async runExpirySweep(): Promise<void> {
    if (!this.pendingTxStore) return
    const expired = await this.pendingTxStore.listExpired()
    for (const record of expired) {
      await this.expireAndTerminalize(record.txHash)
    }
  }

  /**
   * Terminalization sequence for an expired record. Concurrent triggers
   * dedupe via `activeExpirations`.
   *
   *   1. Probe the receipt once more: the tx may have mined while no probe ran (app closed). A mined
   *      receipt resolves like a polling tick; an RPC failure leaves the record for the next sweep.
   *   2. Otherwise mark the `TransactionStorage` row FAILED and emit `pending-expired`.
   *   3. `pendingTxStore.removeExpired(txHash)`.
   */
  async expireAndTerminalize(txHash: string): Promise<void> {
    if (!this.pendingTxStore) return
    if (this.activeExpirations.has(txHash)) return
    this.activeExpirations.add(txHash)
    try {
      if (this.node) {
        const oReceipt = await this.tryGetReceipt(txHash)
        if (oReceipt === "rpc-error") return
        if (oReceipt.isMined()) {
          const outcome: "success" | "reverted" = oReceipt.hasExecutionSucceeded()
            ? "success"
            : "reverted"
          await this.pendingTxStore.remove(txHash)
          await this.writePendingResolvedToTransactionStorage(txHash, outcome)
          this.emitListeners({ type: "pending-resolved", txHash, outcome })
          return
        }
      }
      // Not mined past the kernel `expirationTimestamp`: the tx is dead on chain.
      await this.writePendingResolvedToTransactionStorage(txHash, "dropped")
      this.emitListeners({ type: "pending-expired", txHash })
      try {
        await this.pendingTxStore.removeExpired(txHash)
      } catch (err) {
        // Defensive: removeExpired throws on a non-expired record; swallow so
        // the dedupe set is released and the next sweep retries.
        logger.warn(`[TxLifecycleService] removeExpired threw for ${txHash}:`, err)
      }
    } finally {
      this.activeExpirations.delete(txHash)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────────────────────────────────

  private emitListeners(event: TxLifecycleEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        logger.warn("[TxLifecycleService] listener threw:", err)
      }
    }
  }

  private requireAttached(label: string): void {
    if (!this.pendingTxStore || !this.node) {
      throw new Error(
        `[TxLifecycleService] ${label}() called before TxLifecycleService.get(opts) was wired with pending-tracking dependencies.`,
      )
    }
  }
}

/**
 * map a `ProvingStage` (the wallet's local-prove pipeline event) to its
 * `QueueStatus` UI counterpart. Witgen and Proving both surface as `PROVING`
 * because the activity-feed pill / detail-sheet stage feed treats witness
 * generation as part of the prove step from the user's perspective. `Mining`
 * is the post-submit stage — emitted by `wallet.sendTx` synchronously before
 * `aztecNode.sendTx` runs.
 */
function mapProvingStageToQueueStatus(stage: ProvingStage): QueueStatus | undefined {
  switch (stage) {
    case ProvingStage.Simulating:
      return QueueStatus.SIMULATING
    case ProvingStage.Witgen:
      return QueueStatus.PROVING
    case ProvingStage.Proving:
      return QueueStatus.PROVING
    case ProvingStage.Mining:
      return QueueStatus.MINING
    default:
      return undefined
  }
}
