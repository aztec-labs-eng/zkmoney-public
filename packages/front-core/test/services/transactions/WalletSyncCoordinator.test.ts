import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IStorageAdapter } from "../../../src/core/storages/adapter"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"
import { globalEventEmitter } from "../../../src/core/services/GlobalEventEmitter"
import { WalletSyncCoordinator } from "../../../src/core/services/transactions/WalletSyncCoordinator"
import { TRANSFER_SCAN_CATCH_UP_TIMEOUT_MS } from "../../../src/core/services/transactions/TransferEventScanner"
import { BalanceStorage } from "../../../src/core/storages/BalanceStorage"
import type { ScannedTransferEvent } from "@obsidion/sdk"
import { fakeIncomingTokenTx, makeScheduler } from "../../utils/xmtpReceiveFixtures"

const ME = "0x" + "aa".repeat(32)

function memStorage(): IStorageAdapter {
  const m = new Map<string, string>()
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => void m.set(k, v),
    removeItem: async (k) => void m.delete(k),
    clear: async () => m.clear(),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function harness(opts: { head?: () => number; balance?: () => bigint } = {}) {
  const writes: { scope: string; token: string; balance: bigint; anchor?: number }[] = []
  const txs: { status: string; action?: string; txHash: string; timestamp: number }[] = []
  const withdrawalListeners = new Set<(r: readonly WithdrawalRecord[]) => void>()
  const listIncoming = vi.fn(async (): Promise<ScannedTransferEvent[]> => [])
  const readBalance = vi.fn(async () => opts.balance?.() ?? 0n)
  const source = {
    headBlock: vi.fn(async () => opts.head?.() ?? 100),
    blockTimestampMs: async (b: number) => b * 1000,
    anchorBlock: vi.fn(async () => 100),
    listIncoming,
    readSnapshot: vi.fn(async () => ({
      events: await listIncoming(),
      balance: await readBalance(),
      anchorBlock: 100,
    })),
    readBalanceSnapshot: vi.fn(async () => ({ balance: await readBalance(), anchorBlock: 101 })),
  }
  const transactions = { getTransactions: vi.fn(async () => txs as never) }
  const tags = { resolveL2: vi.fn(async (): Promise<null> => null) }
  const balanceStore = {
    updateBalance: vi.fn(
      async (scope: string, token: string, balance: bigint, anchor?: number) =>
        void writes.push({ scope, token, balance, anchor }),
    ),
  }
  const scheduler = makeScheduler()
  const boot = { notesSynced: vi.fn() }
  const coordinator = new WalletSyncCoordinator({
    source,
    storage: memStorage(),
    transactionStore: {
      hasTxHash: async () => false,
      addIncomingTokenTransaction: async (input) => ({
        tx: fakeIncomingTokenTx(input),
        inserted: true,
      }),
    },
    tags,
    contacts: { findByL2Address: async () => null },
    token: { address: "0xtok", symbol: "DAI", decimals: 18 },
    balance: {
      store: balanceStore,
      scope: "net:me",
      tokenAddress: "0xtok",
    },
    transactions,
    withdrawals: {
      list: () => [],
      onListChanged: (l) => {
        withdrawalListeners.add(l)
        return () => withdrawalListeners.delete(l)
      },
    },
    scheduler,
    boot,
  })
  const ctx = { accountAddress: ME, accountTag: "me", networkId: "net" }
  return {
    boot,
    coordinator,
    ctx,
    writes,
    txs,
    listIncoming,
    readBalance,
    scheduler,
    withdrawalListeners,
    source,
    transactions,
    tags,
    balanceStore,
  }
}

/** Fires the debounce and lets the resulting tick settle. */
const flushRefresh = async () => {
  await vi.advanceTimersByTimeAsync(600)
}

describe("WalletSyncCoordinator", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("reads the balance on the synced tick and writes it with the anchor; UI never fetches", async () => {
    const h = harness({ balance: () => 42n })
    await h.coordinator.start(h.ctx)
    expect(h.readBalance).toHaveBeenCalledTimes(1)
    expect(h.writes).toEqual([{ scope: "net:me", token: "0xtok", balance: 42n, anchor: 100 }])
    h.coordinator.stop()
  })

  it("refresh() ticks the active coordinator", async () => {
    const h = harness()
    await h.coordinator.start(h.ctx)
    await WalletSyncCoordinator.refresh()
    expect(h.readBalance).toHaveBeenCalledTimes(2)
    h.coordinator.stop()
  })

  it("refresh() before any coordinator started settles after the next start's first tick", async () => {
    let settled = false
    const early = WalletSyncCoordinator.refresh().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBe(false)

    const h = harness({ balance: () => 7n })
    await h.coordinator.start(h.ctx)
    await early
    expect(settled).toBe(true)
    expect(h.writes).toHaveLength(1) // the balance was really read before the caller resumed
    h.coordinator.stop()
  })

  it("refresh() with no coordinator ever starting gives up after the wait cap", async () => {
    let settled = false
    void WalletSyncCoordinator.refresh().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(settled).toBe(true)
  })

  it("a new terminal send triggers one debounced refresh; pending progress and receives do not", async () => {
    const h = harness()
    await h.coordinator.start(h.ctx)
    expect(h.readBalance).toHaveBeenCalledTimes(1)

    h.txs.push({ status: "pending", txHash: "0x1", timestamp: 1 })
    globalEventEmitter.emitTransactionsUpdated()
    await flushRefresh()
    expect(h.readBalance).toHaveBeenCalledTimes(1)

    // The tick's own receive insert must not re-trigger the tick.
    h.txs.push({ status: "success", action: "receive", txHash: "0x2", timestamp: 2 })
    globalEventEmitter.emitTransactionsUpdated()
    await flushRefresh()
    expect(h.readBalance).toHaveBeenCalledTimes(1)

    h.txs[0].status = "success"
    globalEventEmitter.emitTransactionsUpdated()
    globalEventEmitter.emitTransactionsUpdated() // race legs collapse into one refresh
    await flushRefresh()
    expect(h.readBalance).toHaveBeenCalledTimes(2)
    h.coordinator.stop()
  })

  it("a withdrawal leaving `submitting` triggers a refresh", async () => {
    const h = harness()
    await h.coordinator.start(h.ctx)
    const record = { localId: "wdraw_1", phase: "l2_mined" } as WithdrawalRecord
    h.withdrawalListeners.forEach((l) => l([record]))
    await flushRefresh()
    expect(h.readBalance).toHaveBeenCalledTimes(2)
    h.coordinator.stop()
  })

  it("stop() drops the store watches and the pending refresh", async () => {
    const h = harness()
    await h.coordinator.start(h.ctx)
    h.txs.push({ status: "success", txHash: "0x1", timestamp: 1 })
    globalEventEmitter.emitTransactionsUpdated()
    h.coordinator.stop()
    await flushRefresh()
    globalEventEmitter.emitTransactionsUpdated()
    await flushRefresh()
    expect(h.readBalance).toHaveBeenCalledTimes(1)
  })

  it("discards a timed-out snapshot even after a newer balance is persisted", async () => {
    const h = harness()
    const late = deferred<bigint>()
    const entered = deferred<void>()
    h.readBalance.mockImplementationOnce(() => {
      entered.resolve()
      return late.promise
    })
    h.readBalance.mockResolvedValue(20n)
    const storage = BalanceStorage.get(memStorage())
    h.balanceStore.updateBalance.mockImplementation((scope, token, value, anchor) =>
      storage.updateBalance(scope, token, value, anchor),
    )
    const started = h.coordinator.start(h.ctx)
    await entered.promise
    // A cursorless first pass is a catch-up, so its read gets the longer bound.
    await vi.advanceTimersByTimeAsync(TRANSFER_SCAN_CATCH_UP_TIMEOUT_MS + 1)
    await started
    await h.coordinator.tickNow()
    expect(await storage.getBalance("net:me", "0xtok")).toBe(20n)
    late.resolve(100n)
    await vi.advanceTimersByTimeAsync(0)
    expect(await storage.getBalance("net:me", "0xtok")).toBe(20n)
    expect(h.balanceStore.updateBalance).toHaveBeenCalledTimes(1)
    h.coordinator.stop()
  })

  it("does not publish an in-flight snapshot after stop", async () => {
    const h = harness()
    const late = deferred<bigint>()
    const entered = deferred<void>()
    h.readBalance.mockImplementationOnce(() => {
      entered.resolve()
      return late.promise
    })
    const started = h.coordinator.start(h.ctx)
    await entered.promise
    h.coordinator.stop()
    late.resolve(100n)
    await started
    expect(h.writes).toEqual([])
  })

  it("does not restart or subscribe after stop during baseline hydration", async () => {
    const h = harness()
    const baseline = deferred<never>()
    h.transactions.getTransactions.mockImplementationOnce(() => baseline.promise)
    const started = h.coordinator.start(h.ctx)
    h.coordinator.stop()
    baseline.resolve([] as never)
    await started
    expect(h.source.readSnapshot).not.toHaveBeenCalled()
    expect(h.withdrawalListeners.size).toBe(0)
    expect(h.scheduler.pendingCount()).toBe(0)
  })

  it("publishes balance even when transfer attribution fails", async () => {
    const h = harness({ balance: () => 7n })
    h.listIncoming.mockResolvedValue([
      {
        from: "0xother",
        to: ME,
        txHash: "0xtx",
        amount: "7",
        blockNumber: 100,
        senderTag: "alice",
      },
    ])
    h.tags.resolveL2.mockRejectedValue(new Error("registry unavailable"))
    await h.coordinator.start(h.ctx)
    expect(h.writes).toEqual([{ scope: "net:me", token: "0xtok", balance: 7n, anchor: 100 }])
    h.coordinator.stop()
  })

  it("uses the snapshot anchor rather than the pre-sync anchor", async () => {
    const h = harness()
    h.source.anchorBlock.mockResolvedValue(90)
    await h.coordinator.start(h.ctx)
    expect(h.writes[0].anchor).toBe(100)
    h.coordinator.stop()
  })

  it("forces a shared full pass when refresh arrives during the head read", async () => {
    const h = harness()
    const head = deferred<number>()
    const entered = deferred<void>()
    h.source.headBlock.mockImplementationOnce(() => {
      entered.resolve()
      return head.promise
    })
    const started = h.coordinator.start(h.ctx)
    await entered.promise
    const first = WalletSyncCoordinator.refresh()
    const second = WalletSyncCoordinator.refresh()
    head.resolve(100)
    await Promise.all([started, first, second])
    expect(h.source.readSnapshot).toHaveBeenCalledTimes(2)
    expect(h.writes).toHaveLength(2)
    h.coordinator.stop()
  })

  it("settles the boot notes stage on its first published balance only", async () => {
    const h = harness({ balance: () => 5n })
    h.source.headBlock.mockRejectedValueOnce(new Error("node down"))
    await h.coordinator.start(h.ctx)
    expect(h.writes).toEqual([])
    expect(h.boot.notesSynced).not.toHaveBeenCalled()
    await h.coordinator.tickNow()
    expect(h.writes).toHaveLength(1)
    expect(h.boot.notesSynced).toHaveBeenCalled()
    h.coordinator.stop()
  })

  it("refreshBalance reads the balance alone and writes it with its anchor", async () => {
    let balance = 5n
    const h = harness({ balance: () => balance })
    await h.coordinator.start(h.ctx)
    balance = 9n
    await WalletSyncCoordinator.refreshBalance()
    expect(h.source.readSnapshot).toHaveBeenCalledTimes(1)
    expect(h.writes.at(-1)).toEqual({ scope: "net:me", token: "0xtok", balance: 9n, anchor: 101 })
    h.coordinator.stop()
  })

  it("refreshBalance coalesces a burst into one read in flight plus one trailing", async () => {
    const h = harness({ balance: () => 4n })
    await h.coordinator.start(h.ctx)
    await Promise.all([1, 2, 3, 4].map(() => WalletSyncCoordinator.refreshBalance()))
    expect(h.source.readBalanceSnapshot).toHaveBeenCalledTimes(2)
    h.coordinator.stop()
  })

  it("refreshBalance retries a failed read before falling back to a full pass", async () => {
    const h = harness({ balance: () => 3n })
    await h.coordinator.start(h.ctx)
    h.source.readBalanceSnapshot.mockRejectedValueOnce(new Error("PXE anchor changed"))
    await WalletSyncCoordinator.refreshBalance()
    expect(h.source.readBalanceSnapshot).toHaveBeenCalledTimes(2)
    expect(h.source.readSnapshot).toHaveBeenCalledTimes(1)

    h.source.readBalanceSnapshot.mockRejectedValue(new Error("PXE anchor changed"))
    await WalletSyncCoordinator.refreshBalance()
    expect(h.source.readSnapshot).toHaveBeenCalledTimes(2)
    h.coordinator.stop()
  })
})
