/**
 * WalletSyncCoordinator — the one owner of the wallet's chain view. It drives the
 * `TransferEventScanner` (the only loop that syncs PXE) and, on every synced tick, reads the
 * private balance at the same anchor and writes it to `BalanceStorage`. The UI renders from that
 * store; nothing else in the app syncs PXE to read a balance.
 *
 * Every "refresh now" in the app funnels into `tickNow`: pull-to-refresh and `loadAssets` through
 * the static `refresh()`, a send or withdrawal terminalising through the store watches below. The
 * watches diff terminal keys so pending-row progress writes never trigger a sync, and skip receive
 * rows because those are written by the tick itself.
 */

import { type WalletSyncSource, TokenActionEnum } from "@obsidion/sdk"
import type { Transaction } from "../../../types/transactions"
import type { WithdrawalRecord } from "../bridge/types"
import { globalEventEmitter } from "../GlobalEventEmitter"
import {
  TransferEventScanner,
  type TransferEventScannerOptions,
  type TransferScanContext,
} from "./TransferEventScanner"
import { logger } from "src/utils/logger"

const LOG_PREFIX = "[WalletSyncCoordinator]"
/** Collapses a burst of refresh requests (e.g. several terminal writes) into one refresh. */
const REFRESH_DEBOUNCE_MS = 500
/** Longest a `refresh()` issued before any coordinator started will wait for one. */
const REFRESH_WAIT_MS = 60_000

export interface WalletSyncCoordinatorOptions
  extends Omit<TransferEventScannerOptions, "onSynced"> {
  source: WalletSyncSource
  balance: {
    store: {
      updateBalance(scope: string, token: string, balance: bigint, anchor?: number): Promise<void>
    }
    scope: string
    tokenAddress: string
  }
  /** Terminal send rows trigger a refresh. */
  transactions?: { getTransactions(): Promise<Transaction[]> }
  /** Withdrawals live in their own store; a record leaving `submitting` triggers a refresh. */
  withdrawals?: {
    list(): readonly WithdrawalRecord[]
    onListChanged(listener: (records: readonly WithdrawalRecord[]) => void): () => void
  }
}

export class WalletSyncCoordinator {
  // ponytail: one active coordinator per process (one wallet at a time); key by account if that changes
  private static active: WalletSyncCoordinator | null = null
  private static pending: { promise: Promise<void>; settle: () => void } | null = null

  /**
   * Sync now through the running coordinator. With none mounted yet (cold start, mount still
   * building) the promise settles after the next `start()` completes its first tick, or after
   * `REFRESH_WAIT_MS` so a caller's spinner can never hang on a coordinator that never comes.
   */
  static refresh(): Promise<void> {
    if (WalletSyncCoordinator.active) return WalletSyncCoordinator.active.tickNow()
    if (!WalletSyncCoordinator.pending) {
      let resolve!: () => void
      const promise = new Promise<void>((r) => (resolve = r))
      const timer = setTimeout(() => WalletSyncCoordinator.settlePending(), REFRESH_WAIT_MS)
      WalletSyncCoordinator.pending = {
        promise,
        settle: () => {
          clearTimeout(timer)
          resolve()
        },
      }
    }
    return WalletSyncCoordinator.pending.promise
  }

  private static settlePending(): void {
    const pending = WalletSyncCoordinator.pending
    WalletSyncCoordinator.pending = null
    pending?.settle()
  }

  private readonly opts: WalletSyncCoordinatorOptions
  private readonly scanner: TransferEventScanner
  private seenTerminal: Set<string> | null = null
  private seenAdvanced: Set<string> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void)[] = []
  private generation = 0

  constructor(options: WalletSyncCoordinatorOptions) {
    const { balance, transactions, withdrawals, ...scannerOptions } = options
    this.opts = options
    this.scanner = new TransferEventScanner({
      ...scannerOptions,
      onSynced: async (anchor, value) => {
        if (value === undefined) throw new Error("Wallet snapshot omitted its balance")
        await balance.store.updateBalance(balance.scope, balance.tokenAddress, value, anchor)
      },
    })
  }

  async start(context: TransferScanContext): Promise<void> {
    this.stop()
    const generation = this.generation
    if (this.opts.transactions) {
      const onTransactionsUpdated = () => void this.checkTransactions()
      globalEventEmitter.onTransactionsUpdated(onTransactionsUpdated)
      this.unsubscribe.push(() => globalEventEmitter.offTransactionsUpdated(onTransactionsUpdated))
      await this.checkTransactions() // baseline; never refreshes
      if (generation !== this.generation) return
    }
    if (this.opts.withdrawals) {
      this.seenAdvanced = advancedKeys(this.opts.withdrawals.list())
      this.unsubscribe.push(
        this.opts.withdrawals.onListChanged((records) =>
          this.diff("seenAdvanced", advancedKeys(records)),
        ),
      )
    }
    try {
      const started = this.scanner.start(context)
      WalletSyncCoordinator.active = this
      await started
    } finally {
      if (generation === this.generation) WalletSyncCoordinator.settlePending()
    }
  }

  stop(): void {
    this.generation++
    this.scanner.stop()
    for (const off of this.unsubscribe.splice(0)) off()
    this.seenTerminal = null
    this.seenAdvanced = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    if (WalletSyncCoordinator.active === this) WalletSyncCoordinator.active = null
  }

  tickNow(): Promise<void> {
    return this.scanner.tickNow()
  }

  private async checkTransactions(): Promise<void> {
    const generation = this.generation
    let txs: Transaction[]
    try {
      txs = await this.opts.transactions!.getTransactions()
    } catch {
      return
    }
    if (generation !== this.generation) return
    this.diff("seenTerminal", terminalKeys(txs))
  }

  /** Refreshes when `current` holds a key the previous snapshot lacked; the first call only baselines. */
  private diff(field: "seenTerminal" | "seenAdvanced", current: Set<string>): void {
    const previous = this[field]
    this[field] = current
    if (!previous) return
    for (const key of current) {
      if (!previous.has(key)) return this.scheduleRefresh()
    }
  }

  private scheduleRefresh(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      this.tickNow().catch((err) => logger.warn(`${LOG_PREFIX} refresh failed:`, err))
    }, REFRESH_DEBOUNCE_MS)
  }
}

function terminalKeys(txs: Transaction[]): Set<string> {
  const out = new Set<string>()
  for (const tx of txs) {
    if (tx.status === "pending") continue
    if ("action" in tx && tx.action === TokenActionEnum.RECEIVE) continue
    out.add(tx.txHash || tx.queueId || String(tx.timestamp))
  }
  return out
}

function advancedKeys(records: readonly WithdrawalRecord[]): Set<string> {
  const out = new Set<string>()
  for (const r of records) if (r.phase !== "submitting") out.add(r.l2TxHash || r.localId)
  return out
}
