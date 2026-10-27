/**
 * WalletSyncCoordinator — the one owner of the wallet's chain view. It drives the
 * `TransferEventScanner` (the only loop that syncs PXE) and, on every synced tick, reads the
 * private balances at the same anchor and writes them to `BalanceStorage`: Main's token, and any
 * other the source reads (Savings' shares). The UI renders from that store; nothing else in the
 * app syncs PXE to read a balance.
 *
 * Every "refresh now" in the app funnels into `tickNow`: pull-to-refresh and `loadAssets` through
 * the static `refresh()`, a send or withdrawal terminalising through the store watches below. The
 * watches diff terminal keys so pending-row progress writes never trigger a sync, and skip receive
 * rows because those are written by the tick itself. A write that moves the balance but no
 * `Transfer` event (a claimed deposit) uses `refreshBalance()` instead, which never waits behind a
 * scan pass.
 *
 * Its first published balance settles `bootPriority`'s notes stage; its first pass to reach head,
 * the history stage.
 */

import { type WalletBalanceRead, type WalletSyncSource, TokenActionEnum } from "@obsidion/sdk"
import type { Transaction } from "../../../types/transactions"
import type { WithdrawalRecord } from "../bridge/types"
import { globalEventEmitter } from "../GlobalEventEmitter"
import { bootPriority, type BootPriority } from "./bootPriority"
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
/** Balance-only reads before falling back to a full pass; a concurrent sync can move the anchor. */
const BALANCE_READ_ATTEMPTS = 3

export interface WalletSyncCoordinatorOptions
  extends Omit<TransferEventScannerOptions, "onSynced" | "onCaughtUp"> {
  source: WalletSyncSource
  balance: {
    store: {
      /** False when a newer read is already stored; `strict` rejects a refused write. */
      updateBalance(
        scope: string,
        token: string,
        balance: bigint,
        anchor?: number,
        opts?: { strict?: boolean; readAt?: number },
      ): Promise<boolean>
    }
    scope: string
    /** Main's token: the balance every snapshot must carry, and the one boot waits for. */
    tokenAddress: string
  }
  /** Terminal send rows trigger a refresh. */
  transactions?: { getTransactions(): Promise<Transaction[]> }
  /** Withdrawals live in their own store; a record leaving `submitting` triggers a refresh. */
  withdrawals?: {
    list(): readonly WithdrawalRecord[]
    onListChanged(listener: (records: readonly WithdrawalRecord[]) => void): () => void
  }
  boot?: Pick<BootPriority, "notesSynced" | "historyReplayed">
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

  /** The balance alone at a fresh anchor; without a running coordinator, same as `refresh()`. */
  static refreshBalance(): Promise<void> {
    const active = WalletSyncCoordinator.active
    if (!active) return WalletSyncCoordinator.refresh()
    return active.readBalanceCoalesced().then(
      () => {},
      () => active.tickNow(),
    )
  }

  /**
   * The balance alone, read after every pass already in flight has published, so a deposit imported
   * before the call is in it. True only once that read is stored durably: failed reads fall back to
   * a full pass, which refreshes the view but confirms nothing, and with no running coordinator
   * nothing is read.
   */
  static async confirmBalance(): Promise<boolean> {
    const active = WalletSyncCoordinator.active
    if (!active) return false
    await active.scanner.drained()
    try {
      return await active.readBalanceCoalesced()
    } catch {
      await active.tickNow()
      return false
    }
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
  private balanceRead: Promise<boolean> | null = null
  private balanceReadQueued: Promise<boolean> | null = null
  private readonly boot: Pick<BootPriority, "notesSynced" | "historyReplayed">

  constructor(options: WalletSyncCoordinatorOptions) {
    const { balance, transactions, withdrawals, boot, ...scannerOptions } = options
    this.opts = options
    this.boot = boot ?? bootPriority
    this.scanner = new TransferEventScanner({
      ...scannerOptions,
      onSynced: async (anchor, read) => {
        await this.writeBalances(read, anchor)
        this.boot.notesSynced()
      },
      onCaughtUp: () => this.boot.historyReplayed(),
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

  /**
   * One read in flight plus one trailing, so a burst of claims costs at most two reads. A caller
   * joins only a read that has not started, so its read always begins after the call.
   */
  private readBalanceCoalesced(): Promise<boolean> {
    if (this.balanceReadQueued) return this.balanceReadQueued
    if (!this.balanceRead) return (this.balanceRead = this.runBalanceRead())
    this.balanceReadQueued = this.balanceRead
      .catch(() => {})
      .then(() => {
        this.balanceReadQueued = null
        return (this.balanceRead = this.runBalanceRead())
      })
    return this.balanceReadQueued
  }

  private runBalanceRead(): Promise<boolean> {
    return this.readBalanceNow().finally(() => {
      this.balanceRead = null
    })
  }

  private async writeBalances(
    { balances, readAt }: Partial<WalletBalanceRead> = {},
    anchor: number,
    opts?: { strict?: boolean },
  ): Promise<boolean> {
    const { store, scope, tokenAddress } = this.opts.balance
    if (balances?.[tokenAddress] === undefined)
      throw new Error("Wallet snapshot omitted its balance")
    let stored = false
    for (const [token, value] of Object.entries(balances)) {
      const wrote = await store.updateBalance(scope, token, value, anchor, {
        ...opts,
        readAt: readAt?.[token],
      })
      if (token === tokenAddress) stored = wrote
    }
    return stored
  }

  /** Whether Main's balance was stored, not passed over for a newer read. */
  private async readBalanceNow(): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        const { anchorBlock, ...read } = await this.opts.source.readBalanceSnapshot()
        return await this.writeBalances(read, anchorBlock, { strict: true })
      } catch (err) {
        if (attempt >= BALANCE_READ_ATTEMPTS) throw err
      }
    }
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
