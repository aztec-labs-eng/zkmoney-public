/**
 * ActivityFeed — Unified subscribe-able stream of activity items.
 *
 * The Activity tab and linked-wallet detail screen need one chronological feed
 * across multiple domains. The bridge sources are SIPA deposits and L2→L1
 * withdrawals; paylink, P2P, and request sources can be added by widening
 * ActivityItem instead of introducing parallel feeds that every consumer must
 * subscribe to.
 *
 * Eventually-consistent by construction — each store persists independently
 * via single-key IStorageAdapter writes. Snapshot consistency within a single
 * render is not required by any current consumer.
 */

import type { SIPADepositRecord, SIPADepositStore } from "../deposits/SIPADepositStore"
import { isStuckSweep, STUCK_SWEEP_MS } from "../deposits/sipaStuck"
import type { WithdrawalRecord } from "./types"
import type { WithdrawalStorage } from "./WithdrawalStorage"
import { logger } from "src/utils/logger"

export type BridgeActivityItem =
  | { kind: "bridge.sipaDeposit"; record: SIPADepositRecord }
  | { kind: "bridge.withdrawal"; record: WithdrawalRecord }

export type TransferActivityItem = {
  kind: "p2p" | "paylink" | "request"
  startTime: number
  endTime?: number
  sourceId: string
}

export type ActivityItem = BridgeActivityItem | TransferActivityItem

export type BridgeItem = BridgeActivityItem

type ChangedListener = (items: ActivityItem[]) => void

export class ActivityFeed {
  private static instance: ActivityFeed | null = null
  private sipaDeposits: SIPADepositStore
  private withdrawals: WithdrawalStorage | null
  private changedListeners = new Set<ChangedListener>()
  private unsubSipaDeposits: (() => void) | null = null
  private unsubWithdrawals: (() => void) | null = null
  /** Fires when a deposit hidden behind its own withdrawal has sat long enough to need the user. */
  private wake: ReturnType<typeof setTimeout> | null = null

  private constructor(sipaDeposits: SIPADepositStore, withdrawals: WithdrawalStorage | null) {
    this.sipaDeposits = sipaDeposits
    this.withdrawals = withdrawals
  }

  /**
   * Singleton accessor. The first call must supply the SIPA deposit store;
   * the withdrawal store is an additive second source (callers not yet wired
   * for it keep the SIPA-only feed). Subsequent calls return the same instance
   * regardless of arguments.
   */
  static get(sipaDeposits?: SIPADepositStore, withdrawals?: WithdrawalStorage): ActivityFeed {
    if (!ActivityFeed.instance) {
      if (!sipaDeposits) {
        throw new Error("First call to ActivityFeed.get() requires the SIPADepositStore")
      }
      ActivityFeed.instance = new ActivityFeed(sipaDeposits, withdrawals ?? null)
    }
    return ActivityFeed.instance
  }

  /**
   * Returns the merged list newest-first. Every store is read at call time, so
   * this is always up to date with whatever each store has persisted.
   */
  list(): ActivityItem[] {
    const now = Date.now()
    const withdrawals = this.withdrawals?.list() ?? []
    const hidden = this.sipaDeposits
      .list()
      .filter((record) => hiddenBehindOwnWithdrawal(record, withdrawals, now))
    this.wakeFor(hidden, now)
    const items: ActivityItem[] = [
      ...this.sipaDeposits
        .list()
        .filter((record) => !hidden.includes(record))
        .map<ActivityItem>((record) => ({ kind: "bridge.sipaDeposit", record })),
      ...withdrawals.map<ActivityItem>((record) => ({ kind: "bridge.withdrawal", record })),
    ]
    items.sort((a, b) => itemStartTime(b) - itemStartTime(a))
    return items
  }

  /**
   * A hidden deposit still sweeping surfaces on its own once its sweep has stalled; no store write
   * marks that moment, so the feed re-emits when the earliest such clock runs out.
   */
  private wakeFor(hidden: readonly SIPADepositRecord[], now: number): void {
    if (this.wake) clearTimeout(this.wake)
    this.wake = null
    const due = hidden
      .filter((r) => (r.phase === "sweeping" || r.phase === "broadcast") && !r.sweepTxHash)
      .map((r) => r.startTime + STUCK_SWEEP_MS)
    if (due.length === 0 || this.changedListeners.size === 0) return
    this.wake = setTimeout(() => this.emit(), Math.max(0, Math.min(...due) - now))
  }

  /**
   * Subscribe to feed changes. Fires when any store emits onListChanged.
   * Returns an unsubscribe function; the aggregator stays lazily connected to
   * the stores for the lifetime of the process.
   */
  onChanged(listener: ChangedListener): () => void {
    this.changedListeners.add(listener)
    this.ensureSubscribed()
    return () => {
      this.changedListeners.delete(listener)
    }
  }

  private ensureSubscribed(): void {
    if (!this.unsubSipaDeposits) {
      this.unsubSipaDeposits = this.sipaDeposits.onListChanged(() => this.emit())
    }
    if (!this.unsubWithdrawals && this.withdrawals) {
      this.unsubWithdrawals = this.withdrawals.onListChanged(() => this.emit())
    }
  }

  private emit(): void {
    const snapshot = this.list()
    for (const listener of this.changedListeners) {
      try {
        listener(snapshot)
      } catch (err) {
        logger.warn("[ActivityFeed] listener error:", err)
      }
    }
  }
}

export const BridgeActivityFeed = ActivityFeed

/**
 * A SIPA this wallet funded with its own burn (a paylink-paid registration) reads as one story:
 * the withdrawal row. The deposit record stays off the feed only while it needs nothing from the
 * user; a failed or recoverable deposit, a sweep that has stalled, or one whose funding burn
 * failed, surfaces so its error and recovery actions are reachable. The hidden record still drives
 * the claim in the background.
 */
function hiddenBehindOwnWithdrawal(
  record: SIPADepositRecord,
  withdrawals: readonly WithdrawalRecord[],
  now: number,
): boolean {
  if (record.phase === "failed" || record.phase === "recoverable") return false
  if (isStuckSweep(record, now)) return false
  const sipa = record.sipaAddress.toLowerCase()
  // A migration's arrival is a row of its own: the move is two legs, and the arrival ends it.
  const funding = withdrawals.filter(
    (w) => w.recipient.toLowerCase() === sipa && w.intent !== "migration",
  )
  return funding.length > 0 && funding.some((w) => w.phase !== "failed")
}

export function itemStartTime(item: ActivityItem): number {
  if ("record" in item) return item.record.startTime
  return item.startTime
}

export function itemEndTime(item: ActivityItem): number | undefined {
  if ("record" in item) return item.record.endTime
  return item.endTime
}

export function isBridgeActivityItem(item: ActivityItem): item is BridgeActivityItem {
  return item.kind === "bridge.sipaDeposit" || item.kind === "bridge.withdrawal"
}

export function bridgeItemStartTime(item: BridgeActivityItem): number {
  return item.record.startTime
}

export function bridgeItemEndTime(item: BridgeActivityItem): number | undefined {
  return item.record.endTime
}
