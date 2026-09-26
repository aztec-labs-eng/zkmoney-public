import type { PaylinkTransaction, Transaction } from "src/types"
import { TransactionStorage } from "../../storages/TransactionStorage"
import { getActiveNetworkId } from "../../activeNetworkId"
import { globalEventEmitter } from "../GlobalEventEmitter"
import { isRefundInFlight } from "./refundInFlight"
import { refundParamsFromRow } from "./refundParamsFromRow"
import type { ContractName, PaylinkService } from "@obsidion/sdk"
import { logger } from "src/utils/logger"

/**
 * Creator-side detection of off-device paylink claims.
 *
 * The on-chain primitive (`isPaylinkClaimed`) only proves the paylink note's
 * nullifier was SPENT — claim, refund-pre-claim, and refund-post-claim all spend
 * the same note. So a spent candidate is treated as a recipient claim ONLY when
 * no local refund signal is present. The candidate filter (and the serialized
 * write predicate) exclude rows that are already refunded or have a refund in
 * flight; completed refunds are excluded for free because the refund flow scrubs
 * the row's `paylink` (and a candidate must carry a decodable `paylink`).
 *
 * `isClaimed` is written monotonically and the `paylinkClaimed` event fires only
 * on the genuine unclaimed -> claimed transition (the serialized update returns
 * `true` exactly once). The one reverse path is `demotePaylinkClaim` (reorg),
 * which bumps the row's `reorgEpoch` so an in-flight sweep cannot re-flip it.
 * `reconcile()` drives it via a reverse leg over claimed rows: an UNSPENT read
 * on a previously-claimed row is unambiguous — every spend path (claim, refund,
 * cancel) consumes the same nullifier, so unspent means the claim reorged out.
 */

/** Maps a candidate row's `txHash` to whether its note is spent on-chain. */
export type CheckSpent = (rows: PaylinkTransaction[]) => Promise<Map<string, boolean>>

/** Storage surface the reconciler needs — satisfied by `TransactionStorage`. */
export interface ReconcilerStorage {
  getTransactions(): Promise<Transaction[]>
  updateTransaction(
    predicate: (tx: Transaction) => boolean,
    updater: (tx: Transaction) => void,
  ): Promise<boolean>
}

export interface PaylinkClaimReconcilerDeps {
  /** Injected on-chain spend check (one batched read per call). */
  checkSpent: CheckSpent
  /** Defaults to the `TransactionStorage` singleton. */
  storage?: ReconcilerStorage
  /** Active account at the time of the sweep; used to drop writes after a switch. */
  getActiveAccount?: () => string | undefined
}

function isPaylinkRow(tx: Transaction): tx is PaylinkTransaction {
  return (tx as PaylinkTransaction).emailPaymentAction !== undefined
}

/**
 * A creator PAY row eligible for a claim recheck: not already claimed/refunded/migrated,
 * not mid-refund (in this tab, or submitted before a reload: `refundTxHash`), still carrying the
 * refund material, and with a confirmed create `txHash`.
 */
function isCandidate(row: PaylinkTransaction): boolean {
  return (
    row.emailPaymentAction === "Pay To Email" &&
    !row.isClaimed &&
    !row.isRefunded &&
    !row.isMigrated &&
    !row.refundTxHash &&
    !!row.paylink &&
    !!row.fallbackSecret &&
    !!row.payToEmailSecret &&
    !!row.txHash &&
    !isRefundInFlight(row.payToEmailSecret)
  )
}

/** A claimed creator PAY row eligible for the reverse (reorg) recheck: still
 * carrying the material `checkSpent` needs and no refund/migration signal.
 * Ownership is positive: `checkSpent` reads the active chain, so a row from
 * another network (or an unstamped legacy row) would read unspent there and
 * be falsely demoted — once the active network is known, only its rows pass. */
function isClaimedRecheckCandidate(row: PaylinkTransaction): boolean {
  const activeNetworkId = getActiveNetworkId()
  return (
    row.emailPaymentAction === "Pay To Email" &&
    row.isClaimed === true &&
    !row.isRefunded &&
    !row.isMigrated &&
    !!row.paylink &&
    !!row.fallbackSecret &&
    !!row.txHash &&
    (activeNetworkId === undefined || row.networkId === activeNetworkId)
  )
}

/**
 * Monotonic migrated flip for a row whose escrow the migration exited and whose refund landed on
 * L1. Same serialized shape as the claim flip: the predicate re-checks live state inside the
 * storage mutex, so a claim/refund that won the race aborts it. Emits NO `paylinkClaimed`.
 * Returns `true` exactly once, on the genuine transition.
 */
export async function markPaylinkMigrated(
  txHash: string,
  storage: ReconcilerStorage = TransactionStorage.get(),
): Promise<boolean> {
  return storage.updateTransaction(
    (tx) =>
      isPaylinkRow(tx) && tx.txHash === txHash && !tx.isMigrated && !tx.isClaimed && !tx.isRefunded,
    (tx) => {
      ;(tx as PaylinkTransaction).isMigrated = true
    },
  )
}

/**
 * Reorg demote for a claimed paylink — the ONLY writer allowed to flip
 * `isClaimed` back to `false`. Bumps the row's `reorgEpoch` so a sweep that
 * read the row pre-demote cannot re-flip it; a fresh reconcile re-checks chain
 * and re-claims if the claim survived the reorg. Returns `true` on the genuine
 * claimed -> unclaimed transition, which also emits `paylinkClaimDemoted` so the
 * notification layer can issue a corrective notice.
 */
export async function demotePaylinkClaim(
  txHash: string,
  storage: ReconcilerStorage = TransactionStorage.get(),
  /** When set, the demote only lands if the row's epoch still matches — the
   * reverse leg's stale-observation fence. */
  expectedEpoch?: number,
): Promise<boolean> {
  const demoted = await storage.updateTransaction(
    (tx) =>
      isPaylinkRow(tx) &&
      tx.txHash === txHash &&
      tx.isClaimed === true &&
      (expectedEpoch === undefined || (tx.reorgEpoch ?? 0) === expectedEpoch),
    (tx) => {
      const row = tx as PaylinkTransaction
      row.isClaimed = false
      row.reorgEpoch = (row.reorgEpoch ?? 0) + 1
    },
  )
  if (demoted) globalEventEmitter.emitPaylinkClaimDemoted({ txHash })
  return demoted
}

export class PaylinkClaimReconciler {
  private readonly checkSpent: CheckSpent
  private readonly storage: ReconcilerStorage
  private readonly getActiveAccount?: () => string | undefined

  constructor(deps: PaylinkClaimReconcilerDeps) {
    this.checkSpent = deps.checkSpent
    this.storage = deps.storage ?? TransactionStorage.get()
    this.getActiveAccount = deps.getActiveAccount
  }

  /** Sweep all creator PAY rows — forward (claim detection) plus the reverse
   * reorg recheck over claimed rows. Never throws. */
  public async reconcile(): Promise<void> {
    try {
      const all = await this.storage.getTransactions()
      const rows = all.filter(isPaylinkRow)
      await this.settleSubmittedRefunds(rows, all)
      await this.reconcileCandidates(
        rows.filter(isCandidate),
        rows.filter(isClaimedRecheckCandidate),
      )
    } catch (error) {
      logger.warn("[PaylinkClaimReconciler] reconcile failed:", error)
    }
  }

  /**
   * A refund's hash lands on the creator row at submit; its own row settles on the chain like any
   * other. This carries that outcome back, so a refund whose tab closed mid-flight still reads as
   * refunded — or as refundable again if it was dropped.
   */
  private async settleSubmittedRefunds(
    rows: PaylinkTransaction[],
    all: Transaction[],
  ): Promise<void> {
    for (const row of rows) {
      if (!row.refundTxHash || row.isRefunded || row.isMigrated) continue
      const refund = all.find((tx) => tx !== row && tx.txHash === row.refundTxHash)
      if (!refund || refund.status === "pending") continue
      const landed = refund.status === "success"
      await this.storage.updateTransaction(
        (tx) =>
          isPaylinkRow(tx) &&
          tx.txHash === row.txHash &&
          tx.refundTxHash === row.refundTxHash &&
          !tx.isRefunded,
        (tx) => {
          const ptx = tx as PaylinkTransaction
          if (landed) {
            ptx.isRefunded = true
            ptx.paylink = undefined
          } else {
            ptx.refundTxHash = undefined
          }
        },
      )
    }
  }

  /** Recheck a single row by `txHash` (the detail-open / tap path). Never throws. */
  public async reconcileTxHash(txHash: string): Promise<void> {
    try {
      const row = (await this.storage.getTransactions())
        .filter(isPaylinkRow)
        .find((r) => r.txHash === txHash && isCandidate(r))
      if (row) await this.reconcileCandidates([row])
    } catch (error) {
      logger.warn("[PaylinkClaimReconciler] reconcileTxHash failed:", txHash, error)
    }
  }

  private async reconcileCandidates(
    candidates: PaylinkTransaction[],
    claimedRows: PaylinkTransaction[] = [],
  ): Promise<void> {
    if (candidates.length === 0 && claimedRows.length === 0) return
    const accountAtStart = this.getActiveAccount?.()
    // Epoch snapshot BEFORE the async spent check: a reorg demote landing
    // mid-sweep makes this sweep's observation stale for that row.
    const allRows = [...candidates, ...claimedRows]
    const epochAtRead = new Map(allRows.map((r) => [r.txHash, r.reorgEpoch ?? 0]))

    let spent: Map<string, boolean>
    try {
      spent = await this.checkSpent(allRows)
    } catch (error) {
      // Best-effort: a failed batched read leaves every row unchanged.
      logger.warn("[PaylinkClaimReconciler] checkSpent failed:", error)
      return
    }

    for (const row of candidates) {
      if (spent.get(row.txHash) !== true) continue
      // Account-switch guard: an in-flight sweep must not write to a row after
      // the active account changed out from under it.
      if (accountAtStart !== undefined && this.getActiveAccount?.() !== accountAtStart) return
      try {
        // The serialized update re-checks the live row, so a refund that started
        // between the read and this write (the claim-vs-refund race) aborts the
        // flip. Returns `true` only on the genuine unclaimed -> claimed transition.
        const flipped = await this.storage.updateTransaction(
          (tx) =>
            isPaylinkRow(tx) &&
            tx.txHash === row.txHash &&
            !tx.isClaimed &&
            !tx.isRefunded &&
            !tx.isMigrated &&
            (tx.reorgEpoch ?? 0) === epochAtRead.get(row.txHash) &&
            !isRefundInFlight(tx.payToEmailSecret ?? ""),
          (tx) => {
            ;(tx as PaylinkTransaction).isClaimed = true
          },
        )
        if (flipped) globalEventEmitter.emitPaylinkClaimed({ txHash: row.txHash })
      } catch (error) {
        logger.warn("[PaylinkClaimReconciler] row flip failed:", row.txHash, error)
      }
    }

    // Reverse leg: only an explicit UNSPENT read demotes — a missing entry
    // means the check didn't cover the row (per-row failure upstream).
    for (const row of claimedRows) {
      if (spent.get(row.txHash) !== false) continue
      if (accountAtStart !== undefined && this.getActiveAccount?.() !== accountAtStart) return
      try {
        await demotePaylinkClaim(row.txHash, this.storage, epochAtRead.get(row.txHash))
      } catch (error) {
        console.warn("[PaylinkClaimReconciler] row demote failed:", row.txHash, error)
      }
    }
  }
}

/**
 * `CheckSpent` over `PaylinkService.isPaylinkClaimed`: one nullifier read per row, sequential
 * to avoid overlapping node RPC. A failed row is left out of the map (unknown, never "unspent")
 * so one bad row can't trigger a false claim demote.
 */
export function checkSpentViaPaylinkService(
  paylinkService: Pick<PaylinkService, "isPaylinkClaimed">,
): CheckSpent {
  return async (rows) => {
    const result = new Map<string, boolean>()
    for (const row of rows) {
      try {
        const params = await refundParamsFromRow(row)
        if (!params) continue
        const spent = await paylinkService.isPaylinkClaimed(params)
        result.set(row.txHash, spent)
      } catch (err) {
        logger.warn("[PaylinkClaimReconciler] checkSpent row failed:", row.txHash, err)
      }
    }
    return result
  }
}
