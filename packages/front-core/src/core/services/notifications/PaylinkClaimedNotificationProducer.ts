/**
 * PaylinkClaimedNotificationProducer — mints a notification when a
 * creator's sent paylink is detected as claimed off-device.
 *
 * Event-driven, mirroring TransferReceiveNotificationProducer: the
 * `PaylinkClaimReconciler` emits `globalEventEmitter.paylinkClaimed({ txHash })`
 * on the genuine unclaimed -> claimed transition (never on a re-read), and this
 * producer mints a notification. `AppNotificationStore.createIfAbsent` id-keyed on
 * the create `txHash` keeps it fire-once across reloads/restarts.
 *
 * Startup reconciliation replays recently-created claimed rows so a transition
 * detected while the producer wasn't subscribed still surfaces.
 */

import { globalEventEmitter } from "../GlobalEventEmitter"
import type { PaylinkTransaction, Transaction } from "src/types/transactions"

import {
  AppNotificationStore,
  type CreateAppNotificationInput,
  type PaylinkClaimedNotificationTarget,
} from "./AppNotificationStore"
import type { NotificationProducer } from "./NotificationProducer"
import { logger } from "src/utils/logger"
import { dollars } from "./TransferReceiveNotificationProducer"

const PRODUCER_ID = "paylinkClaimed"
const RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1000

function claimedNotificationId(txHash: string): string {
  return `paylink:claimed:${txHash.toLowerCase()}`
}

export interface PaylinkClaimedNotificationProducerOptions {
  notificationStore: AppNotificationStore
  /** Active account's `transactions[]` — for lookup-by-txHash and startup replay. */
  accountTransactions: () => Promise<Transaction[] | null>
  /** Test seam; defaults to `Date.now`. */
  now?: () => number
}

export function isPaylinkTransaction(tx: Transaction): tx is PaylinkTransaction {
  return (tx as PaylinkTransaction).emailPaymentAction !== undefined
}

export function paylinkAmountLabel(tx: PaylinkTransaction): string {
  return tx.token ? `${dollars(tx.token.amount)} ` : ""
}

/** Intended-recipient suffix, only for non-direct flavors where it's known. */
function recipientSuffix(tx: PaylinkTransaction): string {
  return tx.flavor !== "direct" && tx.to ? ` to ${tx.to}` : ""
}

function notificationInputForPaylinkClaim(
  tx: PaylinkTransaction,
  timestampMs: number,
): CreateAppNotificationInput {
  const target: PaylinkClaimedNotificationTarget = {
    type: "paylink.claimed",
    txHash: tx.txHash,
  }
  return {
    id: claimedNotificationId(tx.txHash),
    producer: PRODUCER_ID,
    domain: "paylink",
    sourceId: tx.txHash.toLowerCase(),
    title: "Paylink claimed",
    description: `Your ${paylinkAmountLabel(tx)}paylink${recipientSuffix(tx)} was claimed`,
    timestampMs,
    systemIcon: "checkmark.circle",
    severity: "success",
    target,
  }
}

export class PaylinkClaimedNotificationProducer implements NotificationProducer {
  readonly id = PRODUCER_ID

  private static instance: PaylinkClaimedNotificationProducer | null = null

  static getOrCreate(
    opts: PaylinkClaimedNotificationProducerOptions,
  ): PaylinkClaimedNotificationProducer {
    if (!PaylinkClaimedNotificationProducer.instance) {
      PaylinkClaimedNotificationProducer.instance = new PaylinkClaimedNotificationProducer(opts)
    }
    return PaylinkClaimedNotificationProducer.instance
  }

  static resetForTests(): void {
    PaylinkClaimedNotificationProducer.instance?.stop()
    PaylinkClaimedNotificationProducer.instance = null
  }

  private readonly opts: PaylinkClaimedNotificationProducerOptions
  private readonly handlePaylinkClaimed: (detail: { txHash: string }) => void
  private readonly handlePaylinkClaimDemoted: (detail: { txHash: string }) => void
  private subscribed = false
  private processChain: Promise<void> = Promise.resolve()
  private now: () => number

  constructor(opts: PaylinkClaimedNotificationProducerOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
    // Stable references so eventemitter3.off can remove by identity.
    this.handlePaylinkClaimed = ({ txHash }) => {
      this.enqueue(() => this.mintFromTxHash(txHash))
    }
    this.handlePaylinkClaimDemoted = ({ txHash }) => {
      this.enqueue(() => this.mintClaimReversed(txHash))
    }
  }

  /** Subscribe to `paylinkClaimed` / `paylinkClaimDemoted` and run startup reconciliation. Idempotent. */
  start(): void {
    if (this.subscribed) return
    this.subscribed = true
    globalEventEmitter.onPaylinkClaimed(this.handlePaylinkClaimed)
    globalEventEmitter.onPaylinkClaimDemoted(this.handlePaylinkClaimDemoted)
    this.enqueue(() => this.reconcile())
  }

  stop(): void {
    if (!this.subscribed) return
    this.subscribed = false
    globalEventEmitter.offPaylinkClaimed(this.handlePaylinkClaimed)
    globalEventEmitter.offPaylinkClaimDemoted(this.handlePaylinkClaimDemoted)
  }

  /** For test orchestration — drain pending enqueued work. */
  async flush(): Promise<void> {
    await this.processChain
  }

  private enqueue(task: () => Promise<void>): void {
    this.processChain = this.processChain.catch(() => undefined).then(task)
  }

  private async findPaylinkRow(txHash: string): Promise<PaylinkTransaction | null> {
    let transactions: Transaction[] | null
    try {
      transactions = await this.opts.accountTransactions()
    } catch (err) {
      logger.warn("[PaylinkClaimedNotificationProducer] account read failed:", err)
      return null
    }
    if (!transactions) return null
    return transactions.filter(isPaylinkTransaction).find((t) => t.txHash === txHash) ?? null
  }

  private async mintFromTxHash(txHash: string): Promise<void> {
    const row = await this.findPaylinkRow(txHash)
    if (!row) return
    await this.mintFromRow(row)
  }

  /**
   * Corrective notice: a reorg demote invalidated a claim we already
   * notified about. Gated on the claimed notification actually existing, so a
   * demote nobody was told about stays silent.
   */
  private async mintClaimReversed(txHash: string): Promise<void> {
    try {
      await this.opts.notificationStore.load()
      if (!this.opts.notificationStore.get(claimedNotificationId(txHash))) return
      await this.opts.notificationStore.createIfAbsent({
        id: `paylink:claim-reversed:${txHash.toLowerCase()}`,
        producer: PRODUCER_ID,
        domain: "paylink",
        sourceId: txHash.toLowerCase(),
        title: "Paylink claim reverted",
        description: "A network reorganization reverted a paylink claim we notified you about",
        timestampMs: this.now(),
        systemIcon: "arrow.uturn.backward",
        severity: "info",
        target: { type: "paylink.claimed", txHash },
      })
    } catch (err) {
      logger.warn("[PaylinkClaimedNotificationProducer] claim-reversed mint failed:", err)
    }
  }

  private async mintFromRow(tx: PaylinkTransaction): Promise<void> {
    if (!tx.txHash) return
    try {
      await this.opts.notificationStore.createIfAbsent(
        notificationInputForPaylinkClaim(tx, this.now()),
      )
    } catch (err) {
      logger.warn("[PaylinkClaimedNotificationProducer] createIfAbsent failed:", err)
    }
  }

  private async reconcile(): Promise<void> {
    let transactions: Transaction[] | null
    try {
      transactions = await this.opts.accountTransactions()
    } catch (err) {
      logger.warn("[PaylinkClaimedNotificationProducer] reconciliation read failed:", err)
      return
    }
    if (!transactions || transactions.length === 0) return

    const cutoff = this.now() - RECONCILIATION_WINDOW_MS
    const recentClaimed = transactions
      .filter(isPaylinkTransaction)
      .filter((tx) => tx.isClaimed && !!tx.txHash && tx.timestamp >= cutoff)

    for (const tx of recentClaimed) {
      await this.mintFromRow(tx)
    }
  }
}
