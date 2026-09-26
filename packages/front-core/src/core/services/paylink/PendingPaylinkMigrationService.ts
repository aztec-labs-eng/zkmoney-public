/**
 * PendingPaylinkMigrationService — the intra-rollup migration's deferred lane for paylinks it
 * cannot move. A creator paylink inside its claim window has no refund path (the contract asserts
 * chain time is past `until_claimable`), so the residual probe hands every still-escrowed historic
 * paylink to `recordPending` and `reconcile` re-derives each record from its row and chain time on
 * every boot. A `claimable`
 * record mints one "reclaim" notification (idempotent by id, so a failed mint retries next boot);
 * the reclaim itself is the ordinary post-expiry refund, after which the returned balance is a
 * plain residual for the migration.
 */

import type { PaylinkTransaction, Transaction } from "src/types/transactions"
import { logger } from "src/utils/logger"
import {
  AppNotificationStore,
  type CreateAppNotificationInput,
} from "../notifications/AppNotificationStore"
import {
  isPaylinkTransaction,
  paylinkAmountLabel,
} from "../notifications/PaylinkClaimedNotificationProducer"
import {
  PendingPaylinkMigrationStore,
  type PendingPaylinkMigrationRecord,
} from "./PendingPaylinkMigrationStore"
import { getActiveNetworkId } from "../../activeNetworkId"
import type { CheckSpent } from "./PaylinkClaimReconciler"
import { paylinkRefundEligibility } from "./refundParamsFromRow"

export const PAYLINK_MIGRATION_PRODUCER_ID = "paylinkMigration"

export function paylinkReclaimableNotificationId(txHash: string): string {
  return `paylink:reclaimable:${txHash.toLowerCase()}`
}

export interface PendingPaylinkMigrationServiceDeps {
  store: PendingPaylinkMigrationStore
  notificationStore: AppNotificationStore
  /** Active account's `transactions[]` — the rows the records re-derive from. */
  accountTransactions: () => Promise<Transaction[] | null>
  /**
   * On-chain nullifier read, consulted once before a reclaim notice: a claim that landed in the
   * window but has not reached the row yet must not be announced as reclaimable. Until it is
   * available no notice is minted; records still advance.
   */
  checkSpent?: CheckSpent
  /** Test seam; defaults to `Date.now`. */
  now?: () => number
}

function reclaimableNotification(
  row: PaylinkTransaction,
  timestampMs: number,
): CreateAppNotificationInput {
  return {
    id: paylinkReclaimableNotificationId(row.txHash),
    producer: PAYLINK_MIGRATION_PRODUCER_ID,
    domain: "paylink",
    sourceId: row.txHash.toLowerCase(),
    title: "Paylink ready to reclaim",
    description: `Your ${paylinkAmountLabel(
      row,
    )}paylink on the retired deployment expired unclaimed. Reclaim it to migrate the funds`,
    timestampMs,
    systemIcon: "clock.arrow.circlepath",
    severity: "info",
    target: { type: "paylink.reclaimable", txHash: row.txHash },
  }
}

export class PendingPaylinkMigrationService {
  private readonly now: () => number

  constructor(private readonly deps: PendingPaylinkMigrationServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Still-escrowed rows the residual probe attributed to a retired deployment, whatever their window state. */
  async recordPending(rows: PaylinkTransaction[]): Promise<void> {
    const { store } = this.deps
    await store.load()
    const nowMs = this.now()
    for (const row of rows) {
      if (!row.txHash || row.untilClaimable == null) continue
      // A live record is never pulled back by a stale probe. A resolved one is re-opened: a claim
      // demotion can put the escrow back in play.
      const existing = store.get(row.txHash)
      if (existing && existing.status !== "resolved") continue
      await store.set({
        txHash: row.txHash,
        untilClaimable: row.untilClaimable,
        tokenAddress: row.tokenAddress,
        networkId: getActiveNetworkId(),
        flavor: row.flavor,
        status: "waiting",
        detectedAtMs: nowMs,
        updatedAtMs: nowMs,
      })
    }
  }

  /**
   * Re-derive every unresolved record from its row and `nowSec` (chain-tip seconds, never the wall
   * clock — the contract gates on block time). Returns the full list for the caller's UI.
   */
  async reconcile(nowSec: number): Promise<PendingPaylinkMigrationRecord[]> {
    const { store, notificationStore } = this.deps
    await store.load()
    let transactions: Transaction[] | null
    try {
      transactions = await this.deps.accountTransactions()
    } catch (err) {
      logger.warn("[PendingPaylinkMigrationService] account read failed:", err)
      return store.list()
    }
    if (!transactions) return store.list()
    const rowsByHash = new Map(
      transactions.filter(isPaylinkTransaction).map((row) => [row.txHash?.toLowerCase(), row]),
    )

    const activeNetworkId = getActiveNetworkId()
    for (const record of store.list()) {
      if (record.status === "resolved") continue
      // Another network's escrow: this chain's clock and nullifier tree say nothing about it.
      if (
        activeNetworkId !== undefined &&
        record.networkId !== undefined &&
        record.networkId !== activeNetworkId
      ) {
        continue
      }
      const row = rowsByHash.get(record.txHash.toLowerCase())
      const next = row ? this.derive(record, row, nowSec) : this.resolved(record, "unavailable")
      if (next.status !== record.status) await store.set(next)
      // Minted from state, not from the transition, so a mint that failed or was cut off retries.
      if (next.status === "claimable" && row) await this.notify(next, row)
    }
    return store.list()
  }

  private async notify(
    record: PendingPaylinkMigrationRecord,
    row: PaylinkTransaction,
  ): Promise<void> {
    const { store, notificationStore, checkSpent } = this.deps
    await notificationStore.load()
    if (notificationStore.get(paylinkReclaimableNotificationId(row.txHash))) return
    // No check, no notice: the entry is fire-once, so it must never precede the nullifier read.
    if (!checkSpent) return
    let spent: boolean | undefined
    try {
      spent = (await checkSpent([row])).get(row.txHash)
    } catch (err) {
      logger.warn("[PendingPaylinkMigrationService] spent check failed:", err)
    }
    // Unknown: no notice this run; the next reconcile asks again.
    if (spent === undefined) return
    // Every spend path consumes the same nullifier; with no local refund signal it was a claim.
    if (spent) {
      await store.set(this.resolved(record, "claimed"))
      return
    }
    try {
      await notificationStore.createIfAbsent(reclaimableNotification(row, this.now()))
    } catch (err) {
      logger.warn("[PendingPaylinkMigrationService] notification mint failed:", err)
    }
  }

  private derive(
    record: PendingPaylinkMigrationRecord,
    row: PaylinkTransaction,
    nowSec: number,
  ): PendingPaylinkMigrationRecord {
    const { eligible, reason } = paylinkRefundEligibility(row, nowSec)
    if (eligible) return { ...record, status: "claimable", updatedAtMs: this.now() }
    if (reason === "within-window") return record
    return this.resolved(record, reason ?? "unavailable")
  }

  private resolved(
    record: PendingPaylinkMigrationRecord,
    resolvedReason: NonNullable<PendingPaylinkMigrationRecord["resolvedReason"]>,
  ): PendingPaylinkMigrationRecord {
    return { ...record, status: "resolved", resolvedReason, updatedAtMs: this.now() }
  }
}
