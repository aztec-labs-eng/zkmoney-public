import { QueueStatus, TokenActionEnum, createNode } from "@obsidion/sdk"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import { getActiveGenerationNode } from "../activeGenerationNode.js"
import { getNodeApiKey } from "../nodeApiKey.js"
import { TxHash, TxStatus } from "@aztec/stdlib/tx"
import { assert } from "ts-essentials"
import {
  Transaction,
  TokenInTxService,
  TransactionStatus,
  TokenAction,
  PaylinkAction,
  TokenTransaction,
  FaucetTransaction,
  PaylinkTransaction,
  AccountCreationTransaction,
  AccountCreationAction,
  ContractCallTransaction,
  FaucetAction,
  AccountActions,
} from "src/types"
import {
  TransactionTracker,
  TransactionQueueItem,
  createTransactionObject,
  TRANSACTION_PROGRESS,
  TRANSACTION_STATUS,
  QUEUE_STATUS,
  LOG_PREFIX,
  TRANSACTION_ACTIONS,
  normalizeTxHash,
} from "../services/transactions"
import { globalEventEmitter } from "../services"
import { getActiveNetworkId } from "../activeNetworkId"
import { AccountStorage } from "./AccountStorage"
import { NetworkStorage } from "./NetworkStorage"
import type { IStorageAdapter } from "./adapter"
import { TRANSACTIONS_STORAGE_KEY } from "./constants"
import { logger } from "src/utils/logger"

/**
 * Persistent store for the wallet's transaction history. Mirrors the shape of
 * the other storage classes in this directory: singleton, `IStorageAdapter`-
 * backed, validates and wipes corrupt JSON.
 *
 * Replaces the prior `TransactionStore` static helper, which mutated
 * `AccountState.transactions` via `AccountStorage`. The split is twofold:
 * (1) transactions are no longer keyed by account because the wallet supports
 * one account per device, and (2) tx writes no longer fire `accountUpdated`
 * — they fire the dedicated `transactionsUpdated` event so consumers can
 * subscribe without churn from identity-only changes.
 *
 * One-time migration: on first load when this key is empty, lift any
 * surviving `transactions[]` field off the persisted `AccountState` blob via
 * `AccountStorage.consumeLegacyTransactions` and seed it here.
 */

/**
 * Thrown by the incoming-transfer write methods when the receive pipeline
 * runs against a wallet that has no usable account.
 */
export class NoAccountError extends Error {
  constructor() {
    super("No current account")
    this.name = "NoAccountError"
  }
}

/**
 * Recipient-shape heuristic used to project a `flavor` field onto legacy
 * paylink rows persisted before the EmailPayment→Paylink rename. Email-bound
 * paylinks store the recipient as an email string in `to`; direct paylinks
 * persist no recipient. Anchored, no-whitespace, single-`@` form is enough
 * to distinguish the two; we are not validating deliverable addresses.
 */
const PAYLINK_EMAIL_RECIPIENT_REGEX = /^[^@\s]+@[^@\s]+$/

/**
 * Type guard for paylink rows. The persisted discriminator is the
 * `emailPaymentAction` field (kept under its legacy name for stored-row
 * back-compat), not the `action` value or the type-level union tag.
 */
function isPaylinkRow(tx: Transaction): tx is PaylinkTransaction {
  return typeof (tx as { emailPaymentAction?: unknown }).emailPaymentAction === "string"
}

/**
 * Read-time projection applied to every persisted transaction row, regardless
 * of which load path produced it. Defaults `kind` to `"send"` for legacy rows
 * pre-dating the field, and back-fills `flavor` for legacy paylink rows
 * pre-dating the EmailPayment→Paylink rename via the recipient-shape
 * heuristic. Centralized so the legacy `AccountState.transactions` migration
 * path and the normal parsed-rows path produce the same in-memory shape.
 */
function projectTransaction(tx: Transaction): Transaction {
  const withKind: Transaction =
    tx.kind === undefined ? ({ ...tx, kind: "send" } as Transaction) : tx
  if (isPaylinkRow(withKind) && (withKind as { flavor?: unknown }).flavor === undefined) {
    const recipient = withKind.to
    const looksLikeEmail =
      typeof recipient === "string" &&
      recipient.length > 0 &&
      PAYLINK_EMAIL_RECIPIENT_REGEX.test(recipient)
    return {
      ...withKind,
      flavor: looksLikeEmail ? ("email" as const) : ("direct" as const),
    }
  }
  return withKind
}

/** Longest a pre-submit row may sit without a hash before it counts as interrupted; proving takes minutes. */
export const SEND_SUBMIT_TIMEOUT_MS = 10 * 60 * 1000

export const INTERRUPTED_SEND_ERROR =
  "This payment was interrupted before it was sent. The amount is still in your balance."

export class TransactionStorage {
  private static instance: TransactionStorage | null = null
  private storage: IStorageAdapter
  private legacyMigrationAttempted = false
  private legacyMigrationPromise: Promise<Transaction[]> | null = null

  private constructor(storage: IStorageAdapter) {
    this.storage = storage
  }

  /**
   * Run the legacy `AccountState.transactions` migration exactly once,
   * persisting the result through `setItem` directly because we are already
   * holding the load slot for whichever caller raced in first. Subsequent
   * concurrent callers `await` the same promise and see the migrated array
   * without redoing the work or racing a duplicate save.
   *
   * On rejection (transient storage failure or
   * `consumeLegacyTransactions` throw) we MUST clear the cached promise
   * AND the `legacyMigrationAttempted` gate so the next caller can retry.
   * Otherwise one transient failure poisons every future empty-key load
   * for the lifetime of the singleton.
   *
   * Order the writes so the legacy rows survive a transient `setItem`
   * failure. We FIRST read legacy rows non-
   * destructively, THEN write them to the new transaction key, THEN
   * strip them from the account blob. A failure between step 1 and 2
   * leaves the legacy rows still readable from the account blob and the
   * gate clears so the next load retries. A failure between step 2 and
   * 3 leaves both copies — that's safe because subsequent
   * `loadTransactions` calls short-circuit on `raw !== null` (the new
   * key is now populated) and never re-enter the migration path. The
   * stale account field is harmless residue, not retried. The unsafe
   * order (consume-then-write) lost the legacy rows entirely if the
   * new-key write rejected.
   */
  private async runLegacyMigration(): Promise<Transaction[]> {
    // No AccountStorage singleton (e.g. the node CLI) → no legacy account blob to migrate.
    let accountStorage: AccountStorage
    try {
      accountStorage = AccountStorage.get()
    } catch {
      return []
    }
    try {
      const legacy = await accountStorage.consumeLegacyTransactions()
      if (!legacy || legacy.length === 0) return []
      await this.storage.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify(legacy))
      // New-key write succeeded; strip is safe to attempt. A failure here
      // is non-blocking — `loadTransactions` will read from the new key on
      // the next call and ignore the stale field on the account blob.
      try {
        await accountStorage.stripLegacyTransactions()
      } catch (stripErr) {
        logger.warn(
          `${LOG_PREFIX} Legacy transactions migrated to new key but strip failed:`,
          stripErr,
        )
      }
      return legacy
    } catch (err) {
      this.legacyMigrationAttempted = false
      this.legacyMigrationPromise = null
      throw err
    }
  }

  static get(storage?: IStorageAdapter): TransactionStorage {
    if (!TransactionStorage.instance) {
      if (!storage) {
        throw new Error("First call to getInstance requires parameter")
      }
      TransactionStorage.instance = new TransactionStorage(storage)
    }
    return TransactionStorage.instance
  }

  private async loadTransactions(): Promise<Transaction[]> {
    const raw = await this.storage.getItem(TRANSACTIONS_STORAGE_KEY)
    if (raw === null) {
      // Legacy migration's save was bypassing the mutex chain.
      // `loadTransactions` is called from inside
      // `withSerializedTransactions` (so writer-path migration is already
      // serialized) AND from the public `getTransactions` read path (which
      // is NOT serialized). On a fresh install where storage is empty, a
      // concurrent `getTransactions()` racing against a writer could let
      // the read see legacy rows while the writer's load still saw `null`,
      // dropping legacy data. Gate the migration on a once-per-instance
      // promise so concurrent callers share the same in-flight migration
      // and the save happens exactly once.
      if (!this.legacyMigrationAttempted) {
        this.legacyMigrationAttempted = true
        this.legacyMigrationPromise = this.runLegacyMigration()
      }
      if (this.legacyMigrationPromise) {
        const legacy = await this.legacyMigrationPromise
        // Legacy `AccountState.transactions` rows pre-date both the `kind`
        // field and the `flavor` discriminator. Project them
        // through the same helper as the parsed-rows path so the first read
        // after upgrade returns the same shape as every subsequent read.
        if (legacy.length > 0) return legacy.map(projectTransaction)
      }
      return []
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await this.storage.removeItem(TRANSACTIONS_STORAGE_KEY)
      return []
    }

    if (!Array.isArray(parsed)) {
      await this.storage.removeItem(TRANSACTIONS_STORAGE_KEY)
      return []
    }

    return (parsed as Transaction[]).map(projectTransaction)
  }

  private async saveTransactions(
    transactions: Transaction[],
    opts: { emit?: boolean } = { emit: true },
  ): Promise<void> {
    await this.storage.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify(transactions))
    if (opts.emit !== false) {
      globalEventEmitter.emitTransactionsUpdated()
    }
  }

  /**
   * Raw read of the persisted transaction list.
   *
   * Pure read: UI reads do not touch the network. The 1Hz polling loop owned
   * by `TxLifecycleService` is the sole authority for terminal-status writes
   * from the polling path.
   */
  public async getTransactions(): Promise<Transaction[]> {
    return await this.loadTransactions()
  }

  public async clearTransactions(): Promise<void> {
    await this.withSerializedTransactions(
      (transactions) => {
        transactions.length = 0
        return true
      },
      () => true,
    )
  }

  /**
   * Mutex chain serializing every load → mutate → save writer. Without it,
   * writer A loads the array, writer B loads the same pre-A array, writer A
   * saves, writer B saves its stale-but-mutated copy → writer A's mutations
   * disappear.
   *
   * This manifested at MINING where the bridge fires both
   * `patchSynthRowAtMining(detailedStatus + txHash)` AND
   * `patchDetailedStatusForQueue(detailedStatus only)` synchronously.
   * Without the chain, the second write could clobber `txHash` back to
   * empty.
   *
   * Every writer that does load → mutate → save
   * (including `updateByTxHash`, `updateActiveTransactionsFromQueue`,
   * `updateTransactionCompletion`, `_addTransaction`, `clearTransactions`)
   * must run through `withSerializedTransactions`. Bypassing it lets a
   * direct writer's `CANCELLED` save race with a serialized writer's
   * `MINING` save and lose the terminal flip.
   */
  private updateChain: Promise<unknown> = Promise.resolve()

  /**
   * Run `fn` against the current persisted transaction list inside the
   * mutex chain. `fn` mutates the array in place and returns a value `R`;
   * `shouldSave(R)` decides whether the mutation should be persisted.
   * Use the returned value to communicate matched/changed/no-op outcomes
   * back to the caller without leaking the array.
   *
   * Save+emit happens inside the critical section, so subsequent writers
   * see the persisted state. Rejections are swallowed on `updateChain` so
   * one failing writer doesn't poison the chain — but the returned promise
   * still rejects to its caller.
   */
  private withSerializedTransactions<R>(
    fn: (transactions: Transaction[]) => R | Promise<R>,
    shouldSave: (result: R) => boolean,
  ): Promise<R> {
    const next = this.updateChain.then(async () => {
      const transactions = await this.loadTransactions()
      const result = await fn(transactions)
      if (shouldSave(result)) {
        await this.saveTransactions(transactions)
      }
      return result
    })
    this.updateChain = next.catch(() => undefined)
    return next
  }

  /**
   * Find a single transaction by predicate and apply an in-place update. Returns
   * `true` if a match was found and persisted; `false` otherwise. The updater
   * mutates the matched record directly — callers do not return a new object.
   *
   * Serialized via `updateChain` so concurrent callers run sequentially —
   * each load sees the latest persisted state including prior writers'
   * mutations.
   */
  public async updateTransaction(
    predicate: (tx: Transaction) => boolean,
    updater: (tx: Transaction) => void,
  ): Promise<boolean> {
    return this.withSerializedTransactions(
      (transactions) => {
        const idx = transactions.findIndex(predicate)
        if (idx < 0) return false
        updater(transactions[idx])
        return true
      },
      (changed) => changed,
    )
  }

  /** Drop the first transaction matching `predicate`. Returns whether one was removed. */
  public async removeTransaction(predicate: (tx: Transaction) => boolean): Promise<boolean> {
    return this.withSerializedTransactions(
      (transactions) => {
        const idx = transactions.findIndex(predicate)
        if (idx < 0) return false
        transactions.splice(idx, 1)
        return true
      },
      (changed) => changed,
    )
  }

  /**
   * Fail pre-submit rows older than `maxAgeMs`: a `pending` row with no hash exists only while the
   * tab that created it is proving, so one that old was interrupted before anything was sent.
   * Returns the rows failed.
   */
  public async failInterruptedSends(
    now: number = Date.now(),
    maxAgeMs: number = SEND_SUBMIT_TIMEOUT_MS,
  ): Promise<Transaction[]> {
    const failed: Transaction[] = []
    for (const row of await this.getTransactions()) {
      if (row.status !== TRANSACTION_STATUS.PENDING || row.txHash || !row.queueId) continue
      if (now - row.timestamp < maxAgeMs) continue
      await this.updateTransaction(
        (tx) => tx.queueId === row.queueId && !tx.txHash,
        (tx) => {
          tx.status = TRANSACTION_STATUS.FAILED as TransactionStatus
          tx.detailedStatus = QueueStatus.FAILED
          tx.error = INTERRUPTED_SEND_ERROR
        },
      )
      failed.push(row)
    }
    return failed
  }

  /**
   * Map a terminal `QueueStatus` to its legacy tri-state `TransactionStatus`
   * counterpart. CANCELLED maps to "failed" (no on-chain effect for the
   * original tx). SUCCESS maps to "success", FAILED to "failed".
   */
  private static legacyStatusFor(status: QueueStatus): TransactionStatus {
    return status === QueueStatus.SUCCESS ? "success" : "failed"
  }

  /**
   * Reorg-epoch guard: once a row has been demoted (`reorgEpoch > 0`),
   * forward writes must carry the matching epoch or they are stale and ignored.
   */
  private static isStaleEpochWrite(tx: Transaction, callerEpoch: number | undefined): boolean {
    const epoch = tx.reorgEpoch ?? 0
    return epoch > 0 && (callerEpoch ?? 0) !== epoch
  }

  /**
   * Reorg demote by txHash. Bumps `reorgEpoch`, reverses the row to `pending`
   * (clearing terminal `detailedStatus`/`endTime`), and preserves block anchors.
   * `terminal: "failed"` (generation freeze) lands `failed` immediately instead
   * — no re-inclusion expected.
   */
  public async demoteByTxHash(
    txHash: string,
    opts: { terminal?: "failed" } = {},
  ): Promise<{ matched: boolean; reorgEpoch?: number }> {
    if (txHash === "") return { matched: false }
    const target = txHash.toLowerCase()
    return this.withSerializedTransactions(
      (transactions) => {
        const idx = transactions.findIndex((tx) => (tx.txHash ?? "").toLowerCase() === target)
        if (idx < 0) return { matched: false, save: false }

        const tx = transactions[idx]
        const nextEpoch = (tx.reorgEpoch ?? 0) + 1
        if (opts.terminal === "failed") {
          transactions[idx] = {
            ...tx,
            status: "failed",
            detailedStatus: QueueStatus.FAILED,
            progress: TRANSACTION_PROGRESS.COMPLETE,
            endTime: Date.now(),
            queueId: undefined,
            reorgEpoch: nextEpoch,
          }
        } else {
          transactions[idx] = {
            ...tx,
            status: "pending",
            detailedStatus: QueueStatus.PENDING,
            endTime: undefined,
            reorgEpoch: nextEpoch,
          }
        }
        return { matched: true, save: true, reorgEpoch: nextEpoch }
      },
      (r) => r.save,
    ).then((r) => ({ matched: r.matched, reorgEpoch: r.reorgEpoch }))
  }

  /**
   * Update a transaction by its `txHash` to a terminal state. Single-writer
   * fan-in for `TxLifecycleService`'s polling loop. Preserves the same
   * monotonicity guard as `updateTransactionCompletion`: once a row has
   * reached `CANCELLED`, a subsequent `SUCCESS`/`FAILED` write is a no-op
   * (the eager hook write of CANCELLED is treated as the source of truth).
   *
   * Returns `true` if a row was matched and persisted; `false` otherwise.
   * `txHash` matching is case-insensitive.
   */
  public async updateByTxHash(
    txHash: string,
    status: QueueStatus.SUCCESS | QueueStatus.FAILED | QueueStatus.CANCELLED,
    completionTime: number = Date.now(),
    reorgEpoch?: number,
  ): Promise<{ matched: boolean; queueId?: string }> {
    // pre-submit rows persist with `txHash: ""` until the real
    // hash returns from `wallet.sendTx`. An empty target would lower-case-match every
    // synth row in the table — including unrelated in-flight ops — and rewrite their
    // detailedStatus to a terminal value. Bail before that happens.
    if (txHash === "") return { matched: false }
    const target = txHash.toLowerCase()
    const result = await this.withSerializedTransactions(
      (transactions) => {
        const idx = transactions.findIndex((tx) => (tx.txHash ?? "").toLowerCase() === target)
        if (idx < 0) return { matched: false, save: false }

        const existing = transactions[idx]
        if (TransactionStorage.isStaleEpochWrite(existing, reorgEpoch)) {
          return { matched: true, save: false, queueId: existing.queueId }
        }
        const existingDetailed = existing.detailedStatus as QueueStatus | undefined
        if (
          existingDetailed === QueueStatus.CANCELLED &&
          (status === QueueStatus.SUCCESS || status === QueueStatus.FAILED)
        ) {
          return { matched: true, save: false, queueId: existing.queueId }
        }

        const matchedQueueId = existing.queueId
        const updated: Transaction = {
          ...existing,
          endTime: completionTime,
          status: TransactionStorage.legacyStatusFor(status),
          detailedStatus: status,
          progress: TRANSACTION_PROGRESS.COMPLETE,
          queueId: undefined,
        }
        // Scrub paylink-specific fields on CANCELLED (mirror of
        // `updateTransactionCompletion`; see the rationale there).
        if (status === QueueStatus.CANCELLED) {
          const ptx = updated as Partial<PaylinkTransaction>
          if ("payToEmailSecret" in ptx) ptx.payToEmailSecret = undefined
          if ("paylink" in ptx) ptx.paylink = undefined
        }
        transactions[idx] = updated
        return { matched: true, save: true, queueId: matchedQueueId }
      },
      (r) => r.save,
    )
    // surface the matched row's `queueId` so callers
    // (TxLifecycleService's pending-resolved writer)
    // can free their op-id ↔ queue-id maps and the row-source registry. The
    // row's `queueId` is always the pre-clear value here — the column is
    // wiped on the terminal write below for fresh-row scrubbing, but the
    // helper already captured it.
    return { matched: result.matched, queueId: result.queueId }
  }

  /**
   * Update all transactions tagged with an active queueId so their persisted
   * state reflects the latest tracker queue snapshot.
   */
  public async updateActiveTransactionsFromQueue(queue: TransactionQueueItem[]): Promise<void> {
    if (queue.length === 0) return

    await this.withSerializedTransactions(
      (transactions) => {
        const activeTxIds = transactions
          .filter((tx) => tx.queueId)
          .map((tx) => tx.queueId as string)
        if (activeTxIds.length === 0) return false

        let hasUpdates = false

        transactions.forEach((tx, index) => {
          if (!tx.queueId) return
          const queueItem = queue.find((item) => item.id === tx.queueId)
          if (!queueItem) return

          const mappedStatus: TransactionStatus =
            queueItem.status === QUEUE_STATUS.SUCCESS
              ? TRANSACTION_STATUS.SUCCESS
              : queueItem.status === QUEUE_STATUS.FAILED
              ? TRANSACTION_STATUS.FAILED
              : TRANSACTION_STATUS.PENDING

          const needsUpdate =
            tx.status !== mappedStatus ||
            tx.detailedStatus !== queueItem.status ||
            tx.progress !== queueItem.progress ||
            (tx.error !== queueItem.error &&
              !(tx.error === null && queueItem.error === undefined) &&
              !(tx.error === undefined && queueItem.error === null)) ||
            (queueItem.txHash && tx.txHash !== queueItem.txHash)

          if (!needsUpdate) return

          logger.log(
            `${LOG_PREFIX} Updating active transaction:`,
            tx.queueId,
            "status:",
            queueItem.status,
          )

          transactions[index] = {
            ...tx,
            status: mappedStatus,
            detailedStatus: queueItem.status as QueueStatus,
            progress: queueItem.progress,
            error: queueItem.error,
            txHash: queueItem.txHash || tx.txHash,
            endTime: queueItem.endTime,
          }

          hasUpdates = true
        })

        return hasUpdates
      },
      (changed) => changed,
    )
  }

  public async addTokenTransaction(
    action: TokenAction,
    token: TokenInTxService | null,
    status: TransactionStatus,
    txHash?: string,
    recipient?: string,
    queueId?: string,
    hasUnknownAmount?: boolean,
    memo?: string,
    toTag?: string,
  ): Promise<void> {
    assert(token, "Token must be provided")
    assert(
      action === TokenActionEnum.SEND || action === TokenActionEnum.RECEIVE,
      "Action must be a valid token action",
    )

    logger.log(`${LOG_PREFIX} Adding token transaction:`, {
      action,
      tokenSymbol: token.symbol,
      tokenAddress: token.address,
      amount: token.amount,
      hasUnknownAmount,
      txHash,
    })

    const queueItem = queueId ? this.findQueueItem(queueId) : undefined

    if (hasUnknownAmount) {
      logger.log(`${LOG_PREFIX} Setting hasUnknownAmount flag to true for`, token.symbol)
      token.hasUnknownAmount = true
    }

    await this._addTransaction({
      action,
      token,
      timestamp: Date.now(),
      status,
      txHash,
      to: recipient,
      ...(toTag ? { toTag } : {}),
      memo,
      queueId,
      detailedStatus: queueItem?.status as QueueStatus | undefined,
      progress: queueItem?.progress,
      error: queueItem?.error,
      startTime: queueItem?.startTime,
      endTime: queueItem?.endTime,
      estimatedDuration: queueItem?.estimatedDuration,
    })
  }

  /**
   * Whether any stored row already carries this `txHash`, whatever its action.
   *
   * Broader than {@link findByTxHash} on purpose: the paylink escrow pays its claimant with the
   * same token `transfer`, so a claim or refund reaches the chain-native scanner as an ordinary
   * incoming `Transfer`. Matching only send/receive rows would let the scanner file that a second
   * time as a stranger receive, double-counting it in the feed and firing a notification for it.
   */
  public async hasTxHash(txHash: string): Promise<boolean> {
    const target = normalizeTxHash(txHash)
    return this.withSerializedTransactions(
      (transactions) =>
        transactions.some(
          (tx) =>
            normalizeTxHash(tx.txHash ?? "") === target ||
            normalizeTxHash((tx as { refundTxHash?: string }).refundTxHash ?? "") === target,
        ),
      () => false,
    )
  }

  /**
   * Look up a token-action transaction (`send` or `receive`) by `txHash`. The
   * chain-native transfer scanner calls this for a pre-lock dedup check; the
   * in-lock check inside `addIncomingTokenTransaction` catches any cross-writer
   * race that slips past this read.
   *
   * Returns `null` when nothing matches. Runs through the writer mutex chain
   * so the snapshot is consistent with any in-flight write in the same
   * process. Never throws.
   */
  public async findByTxHash(txHash: string): Promise<TokenTransaction | null> {
    // Case-insensitive: a peer can replay a transfer with alternate hex casing.
    const target = normalizeTxHash(txHash)
    return this.withSerializedTransactions(
      (transactions) => {
        const match = transactions.find(
          (tx) =>
            normalizeTxHash(tx.txHash ?? "") === target &&
            (tx.action === TokenActionEnum.SEND || tx.action === TokenActionEnum.RECEIVE),
        )
        return (match as TokenTransaction | undefined) ?? null
      },
      () => false,
    )
  }

  /**
   * Look up a `receive` row by the payment-request id its `Transfer.meta` carried. Used by the
   * request-fulfillment reconciler's reverse join when the request row lands after the receive.
   */
  public async findReceivesByRequestId(requestId: string): Promise<TokenTransaction[]> {
    const target = requestId.toLowerCase()
    return this.withSerializedTransactions(
      (transactions) => {
        return transactions.filter(
          (tx) =>
            tx.action === TokenActionEnum.RECEIVE && (tx.requestId ?? "").toLowerCase() === target,
        ) as TokenTransaction[]
      },
      () => false,
    )
  }

  /**
   * Batched {@link findReceivesByRequestId}: one pass over the history for many ids, keyed by
   * lowercased request id. The reverse-join sweep runs on every request-store change and would
   * otherwise re-read and re-parse the whole transaction blob once per pending row.
   */
  public async findReceivesByRequestIds(
    requestIds: readonly string[],
  ): Promise<Map<string, TokenTransaction[]>> {
    const wanted = new Set(requestIds.map((id) => id.toLowerCase()))
    if (wanted.size === 0) return new Map()
    return this.withSerializedTransactions(
      (transactions) => {
        const out = new Map<string, TokenTransaction[]>()
        for (const tx of transactions) {
          if (tx.action !== TokenActionEnum.RECEIVE) continue
          const id = (tx.requestId ?? "").toLowerCase()
          if (!id || !wanted.has(id)) continue
          const bucket = out.get(id)
          if (bucket) bucket.push(tx as TokenTransaction)
          else out.set(id, [tx as TokenTransaction])
        }
        return out
      },
      () => false,
    )
  }

  /**
   * Persist a `TokenTransaction` scanned from the chain-native transfer scanner.
   * `action` defaults to `receive`: `from` is the sender's tag or raw L2 address
   * (display value), `to` is the current account. A `send` is the mirror: `from`
   * is the current account, `to` the recipient's canonical L2 address.
   * `senderL2Address` is the proven on-chain sender either way. The row carries
   * `status: "success"` because the scan read the event from an already-included
   * block before this is called.
   *
   * Idempotent by `txHash` within the action. A concurrent or repeat call for the
   * same hash short-circuits to the existing row and returns `{ tx, inserted: false }`.
   * First-writer wins — the second writer's sender / memo data is discarded
   * so a malicious peer cannot overwrite the legitimate sender's attribution.
   *
   * On a fresh `receive` insert, emits `globalEventEmitter.incomingTransfer` *after*
   * the persistence resolves so listeners can rely on the row being readable.
   */
  public async addIncomingTokenTransaction(input: {
    action?: "send" | "receive"
    txHash: string
    from: string
    senderL2Address: string
    to: string
    token: TokenInTxService
    timestamp: number
    memo?: string
    blockNumber?: number
    requestId?: string
    /** Network the receive was scanned on; defaults to the active network at write time. */
    networkId?: string
    /** Verifier-attested raw amount in base units. */
    amountAtomic?: string
  }): Promise<{ tx: TokenTransaction; inserted: boolean }> {
    const action = input.action === "send" ? TokenActionEnum.SEND : TokenActionEnum.RECEIVE
    // Normalize once: dedupe and persist on canonical hex so case-replay can't double-insert.
    const txHash = normalizeTxHash(input.txHash)
    const result = await this.withSerializedTransactions<{
      tx: TokenTransaction
      inserted: boolean
    }>(
      (transactions) => {
        const existing = transactions.find(
          (tx) => normalizeTxHash(tx.txHash ?? "") === txHash,
        ) as TokenTransaction | undefined
        if (existing) {
          return { tx: existing, inserted: false }
        }

        const transaction: TokenTransaction = {
          action,
          token: input.token,
          timestamp: input.timestamp,
          status: TRANSACTION_STATUS.SUCCESS as TransactionStatus,
          txHash,
          from: input.from,
          to: input.to,
          senderL2Address: input.senderL2Address,
          memo: input.memo,
          networkId: input.networkId ?? getActiveNetworkId(),
          blockNumber: input.blockNumber,
          requestId: input.requestId,
          amountAtomic: input.amountAtomic,
        }
        transactions.push(transaction)
        return { tx: transaction, inserted: true }
      },
      (r) => r.inserted,
    )

    if (result.inserted && action === TokenActionEnum.RECEIVE) {
      try {
        globalEventEmitter.emitIncomingTransfer(result.tx)
      } catch (err) {
        logger.warn(`${LOG_PREFIX} incomingTransfer listener threw:`, err)
      }
    }

    return result
  }

  /**
   * A creator PAY row rebuilt from the funding transfer's own Transfer copy (see `rebuildPaylinks`):
   * mined, unclaimed, and carrying the refund material. Upgrades a scanner's plain send row;
   * a link this device created (or already rebuilt) is left as it is.
   */
  public async addRecoveredPaylinkTransaction(input: {
    txHash: string
    flavor: "direct" | "email"
    token: TokenInTxService
    timestamp: number
    blockNumber: number
    to?: string
    payToEmailSecret: string
    obsidionAccountAddress: string
    tokenAddress: string
    paylink: string
    fallbackSecret: string
    fromClaimable: number
    untilClaimable: number
    refundableUntil: number
    memo?: string
    networkId: string
  }): Promise<{ tx: PaylinkTransaction; inserted: boolean }> {
    const txHash = normalizeTxHash(input.txHash)
    return this.withSerializedTransactions<{ tx: PaylinkTransaction; inserted: boolean }>(
      (transactions) => {
        const index = transactions.findIndex((tx) => normalizeTxHash(tx.txHash ?? "") === txHash)
        const existing = transactions[index]
        if (existing && existing.action !== TokenActionEnum.SEND) {
          return { tx: existing as PaylinkTransaction, inserted: false }
        }
        const { networkId, ...row } = input
        const transaction: PaylinkTransaction = {
          ...row,
          txHash,
          action: PaylinkActionEnum.PAY,
          emailPaymentAction: PaylinkActionEnum.PAY,
          status: TRANSACTION_STATUS.SUCCESS as TransactionStatus,
          networkId,
          isClaimed: false,
        }
        if (existing) transactions[index] = transaction
        else transactions.push(transaction)
        return { tx: transaction, inserted: true }
      },
      (r) => r.inserted,
    )
  }

  /**
   * Append a synthetic pre-submit row for a send tx. Created at Confirm tap so
   * the activity feed shows a Pending row before `wallet.sendTx` returns. The
   * row holds the user-visible recipient and amount but no `txHash` yet —
   * `patchTxHashForQueue` writes that once submit returns. The persisted
   * `operationId` lets the in-memory queue→storage write-through bridge in
   * `TxLifecycleService` correlate live `proving-progress` stage events back
   * to this row.
   *
   * Persists immediately and emits `transactionsUpdated` via `saveTransactions`,
   * so the activity feed re-renders synchronously at Confirm tap.
   */
  public async addPreSubmitTokenTransaction(
    queueId: string,
    operationId: string,
    token: TokenInTxService,
    recipient: string,
  ): Promise<void> {
    const now = Date.now()
    await this._addTransaction({
      action: TokenActionEnum.SEND as TokenAction,
      token,
      timestamp: now,
      status: TRANSACTION_STATUS.PENDING as TransactionStatus,
      txHash: "",
      to: recipient,
      queueId,
      operationId,
      detailedStatus: QueueStatus.PENDING,
      progress: 0,
      startTime: now,
      kind: "send",
    })
  }

  /**
   * persist a synthetic Pending paylink row at Confirm tap so the activity
   * feed shows a Pending paylink row before `wallet.sendTx` returns. Mirrors
   * `addPreSubmitTokenTransaction` for the paylink-create flow. The row holds
   * the visible amount, flavor, and (for email flavor) recipient email but no
   * `txHash` yet — `patchTxHashForQueue` writes that once submit returns.
   *
   * `flavor` is the unified-type discriminator; for direct paylinks
   * the recipient (`to`) is left undefined since direct paylinks have no
   * recipient identity.
   */
  public async addPreSubmitPaylinkTransaction(
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
    const now = Date.now()
    await this._addTransaction({
      action: params.action,
      emailPaymentAction: params.action,
      flavor: params.flavor,
      token: params.token,
      timestamp: now,
      status: TRANSACTION_STATUS.PENDING as TransactionStatus,
      txHash: "",
      to: params.to,
      payToEmailSecret: params.payToEmailSecret,
      obsidionAccountAddress: params.obsidionAccountAddress,
      partialAddress: params.partialAddress,
      tokenAddress: params.tokenAddress,
      paylink: params.paylink,
      memo: params.memo,
      queueId,
      operationId,
      detailedStatus: QueueStatus.PENDING,
      progress: 0,
      startTime: now,
      kind: params.kind ?? "paylink-create",
    } as Partial<PaylinkTransaction>)
  }

  /**
   * Patch the persisted `txHash` for a synth-row keyed by `queueId`. Called
   * from `TxLifecycleService` immediately after `wallet.sendTx` returns the
   * real hash. Idempotent — re-issuing the same patch is a no-op.
   */
  public async patchTxHashForQueue(queueId: string, txHash: string): Promise<boolean> {
    return this.updateTransaction(
      (tx) => tx.queueId === queueId && (!tx.txHash || tx.txHash === ""),
      (tx) => {
        tx.txHash = txHash
      },
    )
  }

  /**
   * patch the post-submit paylink-specific fields onto a synth-row keyed
   * by `queueId`. The paylink-create flow writes a placeholder pre-submit row
   * via `addPreSubmitPaylinkTransaction`, then dispatches `wallet.sendTx`
   * which returns `{ txHash, ciphertext, ... }`. This method writes the
   * post-creation fields (secret, paylink URL, partial address, token
   * address) onto the existing synth row so the activity-row presenter has
   * the full picture. Idempotent.
   */
  public async patchPaylinkSynthRow(
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
  ): Promise<boolean> {
    return this.updateTransaction(
      (tx) => tx.queueId === queueId,
      (tx) => {
        const ptx = tx as Partial<PaylinkTransaction>
        if (fields.payToEmailSecret !== undefined) ptx.payToEmailSecret = fields.payToEmailSecret
        if (fields.paylink !== undefined) ptx.paylink = fields.paylink
        if (fields.partialAddress !== undefined) ptx.partialAddress = fields.partialAddress
        if (fields.tokenAddress !== undefined) ptx.tokenAddress = fields.tokenAddress
        if (fields.fallbackSecret !== undefined) ptx.fallbackSecret = fields.fallbackSecret
        if (fields.fromClaimable !== undefined) ptx.fromClaimable = fields.fromClaimable
        if (fields.untilClaimable !== undefined) ptx.untilClaimable = fields.untilClaimable
        if (fields.memo !== undefined) ptx.memo = fields.memo
        if (fields.refundableUntil !== undefined) ptx.refundableUntil = fields.refundableUntil
      },
    )
  }

  /**
   * Atomic write of `{ detailedStatus, txHash }` for a synth-row keyed by
   * `queueId`. Used by the `TxLifecycleService.subscribeToProvingProgress`
   * bridge at MINING start, where two separate writes (one for status, one
   * for hash) would race on the load → mutate → save cycle and one could
   * clobber the other. One updateTransaction
   * call mutates both fields against the same loaded snapshot, so neither
   * field can be lost.
   *
   * `txHash` write follows the same idempotency as `patchTxHashForQueue`:
   * only writes if the row's existing hash is empty, so a later patch
   * from `usePaymentFlow.then`'s belt-and-suspenders call is a no-op.
   */
  public async patchSynthRowAtMining(
    queueId: string,
    detailedStatus: QueueStatus,
    txHash: string,
    reorgEpoch?: number,
  ): Promise<boolean> {
    return this.updateTransaction(
      (tx) => tx.queueId === queueId,
      (tx) => {
        if (TransactionStorage.isStaleEpochWrite(tx, reorgEpoch)) return
        // Terminal-state guard: a stale/replayed bridge event must not
        // move CANCELLED/SUCCESS/FAILED back to MINING. The only legitimate
        // writers for these states are `updateTransactionCompletion` and the
        // lifecycle poll (`updateByTxHash`).
        const existing = tx.detailedStatus as QueueStatus | undefined
        if (
          existing === QueueStatus.SUCCESS ||
          existing === QueueStatus.FAILED ||
          existing === QueueStatus.CANCELLED
        ) {
          return
        }
        tx.detailedStatus = detailedStatus
        if (!tx.txHash || tx.txHash === "") {
          tx.txHash = txHash
        }
      },
    )
  }

  /**
   * Patch the persisted `detailedStatus` (and the legacy tri-state `status`
   * mirror, when crossing into terminal territory) for a synth-row keyed by
   * `queueId`. The in-memory bridge in `TxLifecycleService` calls this when
   * `provingProgress` emits a stage transition so the activity feed picks up
   * `simulating → witgen → proving → mining` without a polling-loop tick.
   *
   * Pre-terminal stages (`SIMULATING`/`PROVING`/`MINING`) only update
   * `detailedStatus` — the row stays `"pending"` because the legacy
   * tri-state has no slot for them. Terminal stages
   * (`SUCCESS`/`FAILED`/`CANCELLED`) ALSO flip `tx.status`, `progress`, and
   * `endTime` so the hero pill switches off "Sending…" the moment ServiceBase
   * emits success — without waiting for the lifecycle poll's `updateByTxHash`
   * retry to catch up.
   *
   * Mirrors `updateByTxHash`'s monotonicity: if the row already reached
   * `CANCELLED`, a later `SUCCESS`/`FAILED` write is a no-op (the eager hook
   * write of CANCELLED is the source of truth).
   */
  public async patchDetailedStatusForQueue(
    queueId: string,
    status: QueueStatus,
    reorgEpoch?: number,
  ): Promise<boolean> {
    const isTerminal =
      status === QueueStatus.SUCCESS ||
      status === QueueStatus.FAILED ||
      status === QueueStatus.CANCELLED

    // Monotonicity guard runs inside the mutex critical section. A
    // pre-check outside the mutex can stale before
    // the queued write fires — e.g., a flow writes CANCELLED between this
    // read and the queued write, then the queued SUCCESS
    // clobbers it. With the check inside, the loaded snapshot is the
    // same one the save will persist, so the guard is sound.
    const result = await this.withSerializedTransactions(
      (transactions) => {
        const idx = transactions.findIndex((tx) => tx.queueId === queueId)
        if (idx < 0) return { matched: false, save: false }

        const tx = transactions[idx]
        if (TransactionStorage.isStaleEpochWrite(tx, reorgEpoch)) {
          return { matched: true, save: false }
        }
        const existingDetailed = tx.detailedStatus as QueueStatus | undefined
        if (
          (status === QueueStatus.SUCCESS || status === QueueStatus.FAILED) &&
          existingDetailed === QueueStatus.CANCELLED
        ) {
          return { matched: true, save: false }
        }

        tx.detailedStatus = status
        if (isTerminal) {
          const now = Date.now()
          tx.status = TransactionStorage.legacyStatusFor(status)
          tx.progress = TRANSACTION_PROGRESS.COMPLETE
          tx.endTime = now
        }
        return { matched: true, save: true }
      },
      (r) => r.save,
    )
    return result.matched
  }

  public async addFaucetTransaction(
    token: TokenInTxService | null,
    status: TransactionStatus,
    txHash: string,
    queueId?: string,
  ): Promise<void> {
    assert(token, "Token must be provided")

    logger.log(`${LOG_PREFIX} Adding faucet transaction:`, {
      tokenSymbol: token.symbol,
      tokenAddress: token.address,
      amount: token.amount,
      txHash,
    })

    const queueItem = queueId ? this.findQueueItem(queueId) : undefined

    await this._addTransaction({
      action: TRANSACTION_ACTIONS.FAUCET as FaucetAction,
      token,
      timestamp: Date.now(),
      status,
      txHash,
      queueId,
      detailedStatus: queueItem?.status as QueueStatus | undefined,
      progress: queueItem?.progress,
      error: queueItem?.error,
      startTime: queueItem?.startTime,
      endTime: queueItem?.endTime,
      estimatedDuration: queueItem?.estimatedDuration,
      description: "Received tokens from faucet",
    })
  }

  /**
   * Create a paylink row (formerly `createEmailPaymentTransaction`). Caller
   * passes the `flavor` discriminator explicitly — direct paylinks (no
   * recipient validation) and email paylinks (email-bound) share the same
   * action enum but render with flavor-specific copy.
   */
  public async createPaylinkTransaction(
    queueId: string,
    txHash: string,
    paylinkAction: PaylinkAction,
    flavor: "direct" | "email" | "zk",
    token?: TokenInTxService | null,
    recipient?: string,
    payToEmailSecret?: string,
    obsidionAccountAddress?: string,
    partialAddress?: string,
    tokenAddress?: string,
    paylink?: string,
    refundFields?: {
      fallbackSecret?: string
      fromClaimable?: number
      untilClaimable?: number
      refundableUntil?: number
    },
  ): Promise<void> {
    const queueItem = this.findQueueItem(queueId)
    if (!queueItem) {
      logger.log(`${LOG_PREFIX} Queue item not found:`, queueId)
      return
    }

    await this._addTransaction({
      emailPaymentAction: paylinkAction,
      flavor,
      token: token || undefined,
      timestamp: queueItem.startTime,
      status: TRANSACTION_STATUS.PENDING as TransactionStatus,
      txHash: txHash || "",
      to: recipient,
      queueId,
      detailedStatus: queueItem.status as QueueStatus,
      progress: queueItem.progress,
      startTime: queueItem.startTime,
      estimatedDuration: queueItem.estimatedDuration,
      description: queueItem.description,
      payToEmailSecret,
      obsidionAccountAddress,
      partialAddress,
      tokenAddress,
      paylink,
      fallbackSecret: refundFields?.fallbackSecret,
      fromClaimable: refundFields?.fromClaimable,
      untilClaimable: refundFields?.untilClaimable,
      refundableUntil: refundFields?.refundableUntil,
    } as Partial<PaylinkTransaction>)
  }

  /**
   * Mark a tx complete by queueId. Strips `queueId` so the tracker no longer
   * considers the record active.
   *
   * Accepts `CANCELLED` for a flow that abandons its row before submit. Adds a
   * light-weight monotonicity guard: once the row has reached `CANCELLED`, a
   * later `SUCCESS`/`FAILED` write from a stale polling-loop tick is a no-op
   * (the eager flow write of CANCELLED is treated as the source of truth).
   * Defensive — coexists with the eager `completeTransaction` calls from
   * send-screen hooks (`usePaymentFlow.ts:251`) and the polling-driven writes
   * from `TxLifecycleService`.
   */
  public async updateTransactionCompletion(
    queueId: string,
    status: QueueStatus.SUCCESS | QueueStatus.FAILED | QueueStatus.CANCELLED = QueueStatus.SUCCESS,
    completionTime: number = Date.now(),
    reorgEpoch?: number,
  ): Promise<void> {
    await this.withSerializedTransactions(
      (transactions) => {
        const txIndex = transactions.findIndex((tx) => tx.queueId === queueId)
        if (txIndex < 0) return false

        // Monotonicity: once CANCELLED is written, ignore subsequent
        // SUCCESS/FAILED writes from a stale polling-loop tick.
        const existing = transactions[txIndex]
        if (TransactionStorage.isStaleEpochWrite(existing, reorgEpoch)) return false
        const existingDetailed = existing.detailedStatus as QueueStatus | undefined
        if (
          existingDetailed === QueueStatus.CANCELLED &&
          (status === QueueStatus.SUCCESS || status === QueueStatus.FAILED)
        ) {
          return false
        }

        // Legacy `TransactionStatus` is the narrow `"pending" | "success" | "failed"`
        // tri-state used by older UI rows. CANCELLED maps to "failed" (no-op
        // outcome from the user's perspective). The richer `detailedStatus` field
        // carries the precise QueueStatus for screens that wire rich rendering.
        const legacyStatus: TransactionStatus =
          status === QueueStatus.SUCCESS ? "success" : "failed"

        transactions[txIndex].endTime = completionTime
        transactions[txIndex].status = legacyStatus
        transactions[txIndex].detailedStatus = status
        transactions[txIndex].queueId = undefined

        // On CANCELLED, scrub paylink-specific fields
        // (`payToEmailSecret`, `paylink`) so the row no longer matches by
        // secret. Without this, a cancelled
        // email paylink would still match and a later
        // `markTransactionAsClaimed`/`markTransactionAsRefunded` call could
        // mutate the cancelled row. A cancelled paylink never reached the
        // chain, but local-storage hygiene matters for the activity feed and
        // the claim flow's matcher.
        if (status === QueueStatus.CANCELLED) {
          const ptx = transactions[txIndex] as Partial<PaylinkTransaction>
          if ("payToEmailSecret" in ptx) ptx.payToEmailSecret = undefined
          if ("paylink" in ptx) ptx.paylink = undefined
        }
        return true
      },
      (changed) => changed,
    )
  }

  /**
   * Reconcile pending contract-call transactions against the Aztec node.
   * Operates on the supplied list, persists if anything changed, and returns
   * the (possibly updated) list to the caller.
   *
   * @deprecated — use `TxLifecycleService`'s unified polling loop instead.
   * This method has no callers in the merged-service design; it is retained
   * as an opt-in helper to reduce churn. Phase N+1 may remove it
   * outright once we are confident no consumer needs it.
   */
  public async checkTxStatusFromNode(transactions: Transaction[]): Promise<Transaction[]> {
    const pendingTxs = transactions.filter(
      (tx) =>
        tx.status === TRANSACTION_STATUS.PENDING ||
        tx.detailedStatus === QueueStatus.PENDING ||
        tx.detailedStatus === QueueStatus.MINING,
    ) as ContractCallTransaction[]

    if (pendingTxs.length === 0) return transactions

    let mutated = false

    try {
      const network = await NetworkStorage.get().getNetwork()
      // Prefer the canonical generation's node (a fresh v5 client can't talk
      // to a v4 node); fall back only if the wallet hasn't published one yet.
      const node = getActiveGenerationNode() ?? createNode(network.nodeUrl, getNodeApiKey())

      for (const tx of pendingTxs) {
        if (!tx.txHash) continue
        try {
          const txHash = TxHash.fromString(tx.txHash)
          const receipt = await node.getTxReceipt(txHash)

          if (receipt.status === TxStatus.CHECKPOINTED) {
            mutated =
              this.applyContractCallStatus(
                transactions,
                tx.txHash,
                TRANSACTION_STATUS.SUCCESS as "success",
              ) || mutated
          } else if (receipt.status === TxStatus.DROPPED) {
            mutated =
              this.applyContractCallStatus(
                transactions,
                tx.txHash,
                TRANSACTION_STATUS.FAILED as "failed",
              ) || mutated
          }
        } catch (error) {
          logger.log(
            `${LOG_PREFIX} Could not get receipt for ${tx.txHash}:`,
            error instanceof Error ? error.message : error,
          )
        }
      }
    } catch (error) {
      logger.error(`${LOG_PREFIX} Error checking contract call statuses:`, error)
    }

    if (mutated) {
      await this.saveTransactions(transactions)
    }

    return transactions
  }

  private applyContractCallStatus(
    transactions: Transaction[],
    txHash: string,
    status: "success" | "failed",
  ): boolean {
    const txIndex = transactions.findIndex((tx) => tx.txHash === txHash)
    if (txIndex < 0) return false

    const tx = transactions[txIndex]
    transactions[txIndex] = {
      ...tx,
      status,
      detailedStatus: status === "success" ? QUEUE_STATUS.SUCCESS : QUEUE_STATUS.FAILED,
      endTime: Date.now(),
      progress: TRANSACTION_PROGRESS.COMPLETE,
      queueId: undefined,
    }
    return true
  }

  // deprecated — retained for legacy callers; account-creation transactions are
  // no longer first-class. Will be removed once the last consumer is gone.
  public async addAccountCreationTransaction(
    action: AccountCreationAction,
    txHash: string,
    status: TransactionStatus = TRANSACTION_STATUS.PENDING as TransactionStatus,
    queueId?: string,
    accountAddress?: string,
    isDevMode?: boolean,
    hasEmail?: boolean,
    detailedStatus?: QueueStatus,
    progress?: number,
  ): Promise<void> {
    logger.log(`${LOG_PREFIX} Adding account creation transaction:`, {
      action,
      txHash,
      status,
      queueId,
      accountAddress,
    })

    const queueItem = queueId ? this.findQueueItem(queueId) : undefined

    await this._addTransaction({
      action,
      timestamp: Date.now(),
      status,
      txHash,
      queueId,
      accountAddress,
      isDevMode,
      hasEmail,
      detailedStatus: detailedStatus || (queueItem?.status as QueueStatus | undefined),
      progress: progress || queueItem?.progress,
      startTime: queueItem?.startTime || Date.now(),
      estimatedDuration: queueItem?.estimatedDuration,
      description:
        action === AccountActions.CREATE_ACCOUNT ? "Account Created" : "Account Imported",
    })
  }

  private findQueueItem(queueId: string): TransactionQueueItem | undefined {
    return TransactionTracker.getInstance()
      .getQueue()
      .find((item) => item.id === queueId)
  }

  private async _addTransaction(
    params: Partial<
      TokenTransaction | FaucetTransaction | PaylinkTransaction | AccountCreationTransaction
    >,
  ): Promise<void> {
    try {
      params.status = params.status
        ? params.status
        : (TRANSACTION_STATUS.PENDING as TransactionStatus)
      // Fan-in networkId stamp: every add path routes through here.
      params.networkId ??= getActiveNetworkId()
      const transaction = createTransactionObject(params)
      if (!transaction) return

      await this.withSerializedTransactions(
        (transactions) => {
          transactions.push(transaction)
          return true
        },
        () => true,
      )
    } catch (error) {
      logger.error(`${LOG_PREFIX} Failed to create transaction:`, error)
      throw error
    }
  }
}
