/**
 * TransferReceiveNotificationProducer — mints AppNotification entries
 * for every verified incoming `TokenTransaction` (`action: "receive"`).
 *
 * Differs from `BridgeNotificationProducer` in subscription model:
 *   - Bridge wraps `SnapshotNotificationProducer` over a feed because
 *     deposits / withdrawals go through pending → in-progress → done
 *     (multiple events per record).
 *   - Receives are one event per record by design — the producer
 *     subscribes directly to `globalEventEmitter.incomingTransfer`,
 *     emitted from `TransactionStore.addIncomingTokenTransaction`
 *     after the lock-protected write. `AppNotificationStore.createIfAbsent`
 *     id-keyed dedup keeps duplicate emissions idempotent.
 *
 * Startup reconciliation: on `start()`, scans the active account's
 * `transactions[]` for `action === "receive"` rows from the last 24h
 * and replays `createIfAbsent` for each. Catches the failure mode
 * where a receive landed in the store but the prior `createIfAbsent`
 * call rejected (storage full / IPC error / app suspended mid-write).
 * The bridge producer gets equivalent reconciliation implicitly from
 * snapshot replay on subscribe; the event-driven shape needs this
 * explicit catch-up.
 */

import { globalEventEmitter } from "../GlobalEventEmitter"
import { isZeroAddress } from "src/utils/validate"
import { truncateMiddle } from "src/utils/shortenAddr"
import type { TokenTransaction, Transaction } from "src/types/transactions"

import {
  AppNotificationStore,
  type CreateAppNotificationInput,
  type TransferNotificationTarget,
} from "./AppNotificationStore"
import type { NotificationProducer } from "./NotificationProducer"
import { logger } from "src/utils/logger"

const PRODUCER_ID = "transferReceive"
const RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1000

export interface TransferReceiveNotificationProducerOptions {
  notificationStore: AppNotificationStore
  /**
   * Returns the active account's `transactions[]` for startup
   * reconciliation. Returning `null` / empty is fine — the producer
   * skips reconciliation and just subscribes to the event stream.
   */
  accountTransactions: () => Promise<Transaction[] | null>
  /** Test seam; defaults to `Date.now`. */
  now?: () => number
}

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/

function isAddress(value: string | undefined | null): boolean {
  return typeof value === "string" && ADDRESS_REGEX.test(value)
}

/**
 * Resolve `tx.from` to a display string for the notification description.
 * A receive from the zero address is a MINT — surface it as "Faucet" (matching
 * the activity row's `resolveReceiveCounterparty`) rather than a bare zero hex.
 * Otherwise: if `tx.from` is already a tag (non-address shape), use it directly;
 * else truncate the L2 address with the same helper the activity feed uses, so
 * the notification and the row label agree.
 */
export function displayReceiveFrom(tx: TokenTransaction): string {
  if (isZeroAddress(tx.from) || isZeroAddress(tx.senderL2Address)) return "Faucet"
  const from = tx.from
  // Only an L1 address passes `isAddress`; an Aztec address is hex too and must not read as a tag.
  if (from && !isAddress(from) && !HEX.test(from)) return from
  const addr = tx.senderL2Address ?? from
  return addr ? truncateMiddle(addr, 15) : "Unknown"
}

const HEX = /^0x[0-9a-fA-F]+$/

/** "$5" or "$2.50": the wallet quotes every figure in dollars. */
export function dollars(amount: number): string {
  return `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`
}

export function isReceiveTransaction(tx: Transaction): tx is TokenTransaction {
  return "action" in tx && (tx as TokenTransaction).action === "receive"
}

function notificationInputForReceive(tx: TokenTransaction): CreateAppNotificationInput {
  const target: TransferNotificationTarget = {
    type: "transfer.txDetail",
    txHash: tx.txHash,
  }
  return {
    id: `transfer:receive:${tx.txHash.toLowerCase()}`,
    producer: PRODUCER_ID,
    domain: "transfer",
    sourceId: tx.txHash.toLowerCase(),
    title: "Transfer received",
    description: `+${dollars(tx.token.amount)} from ${displayReceiveFrom(tx)}`,
    timestampMs: tx.timestamp,
    systemIcon: "arrow.down.left",
    severity: "success",
    target,
  }
}

export class TransferReceiveNotificationProducer implements NotificationProducer {
  readonly id = PRODUCER_ID

  private static instance: TransferReceiveNotificationProducer | null = null

  static getOrCreate(
    opts: TransferReceiveNotificationProducerOptions,
  ): TransferReceiveNotificationProducer {
    if (!TransferReceiveNotificationProducer.instance) {
      TransferReceiveNotificationProducer.instance = new TransferReceiveNotificationProducer(opts)
    }
    return TransferReceiveNotificationProducer.instance
  }

  static resetForTests(): void {
    TransferReceiveNotificationProducer.instance?.stop()
    TransferReceiveNotificationProducer.instance = null
  }

  private readonly opts: TransferReceiveNotificationProducerOptions
  private readonly handleIncomingTransfer: (tx: TokenTransaction) => void
  private subscribed = false
  private processChain: Promise<void> = Promise.resolve()
  private now: () => number

  constructor(opts: TransferReceiveNotificationProducerOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
    // Stable reference so eventemitter3.off can remove by identity.
    this.handleIncomingTransfer = (tx: TokenTransaction) => {
      this.enqueue(() => this.mintFromTransaction(tx))
    }
  }

  /**
   * Subscribe to `incomingTransfer` and run startup reconciliation.
   * Idempotent — calling on an already-started producer is a no-op.
   */
  start(): void {
    if (this.subscribed) return
    this.subscribed = true
    globalEventEmitter.onIncomingTransfer(this.handleIncomingTransfer)
    // Reconciliation runs once per start(), enqueued behind any later
    // emissions so a real incomingTransfer during the catch-up still gets
    // serialized.
    this.enqueue(() => this.reconcile())
  }

  stop(): void {
    if (!this.subscribed) return
    this.subscribed = false
    globalEventEmitter.offIncomingTransfer(this.handleIncomingTransfer)
  }

  /** For test orchestration — drain any pending enqueued work. */
  async flush(): Promise<void> {
    await this.processChain
  }

  private enqueue(task: () => Promise<void>): void {
    this.processChain = this.processChain.catch(() => undefined).then(task)
  }

  private async mintFromTransaction(tx: TokenTransaction): Promise<void> {
    if (tx.action !== "receive") return
    try {
      await this.opts.notificationStore.createIfAbsent(notificationInputForReceive(tx))
    } catch (err) {
      logger.warn("[TransferReceiveNotificationProducer] createIfAbsent failed:", err)
    }
  }

  private async reconcile(): Promise<void> {
    let transactions: Transaction[] | null
    try {
      transactions = await this.opts.accountTransactions()
    } catch (err) {
      logger.warn("[TransferReceiveNotificationProducer] reconciliation read failed:", err)
      return
    }
    if (!transactions || transactions.length === 0) return

    const cutoff = this.now() - RECONCILIATION_WINDOW_MS
    for (const tx of transactions.filter(isReceiveTransaction)) {
      if (tx.timestamp >= cutoff) await this.mintFromTransaction(tx)
    }
  }
}
