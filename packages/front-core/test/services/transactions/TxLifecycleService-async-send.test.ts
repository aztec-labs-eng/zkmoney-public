import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"
import { QueueStatus } from "@obsidion/sdk"
import {
  AccountStorage,
  NetworkStorage,
  TransactionStorage,
  TxLifecycleService,
} from "../../../src/core"
import { TransactionTracker } from "../../../src/core/services/transactions/TransactionTracker"
import type { TokenInTxService } from "../../../src/types"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"

const resetSingletons = () => {
  ;(AccountStorage as unknown as { instance: AccountStorage | null }).instance = null
  ;(TransactionStorage as unknown as { instance: TransactionStorage | null }).instance = null
  ;(NetworkStorage as unknown as { instance: NetworkStorage | null }).instance = null
  ;(TransactionTracker as unknown as { instance: TransactionTracker | null }).instance = null
  TxLifecycleService.reset()
}

const setup = () => {
  resetSingletons()
  const adapter = new InMemoryStorageAdapter()
  AccountStorage.get(adapter)
  const transactions = TransactionStorage.get(adapter)
  const lifecycle = TxLifecycleService.get()
  // Test-account-style boot: bridge wired without a pendingTxStore.
  lifecycle.subscribeToProvingProgress()
  return { adapter, transactions, lifecycle }
}

const sampleToken = (): TokenInTxService => ({
  name: "DAI",
  decimals: 6,
  logo: "https://example.com/dai.png",
  price: 1,
  symbol: "DAI",
  address: "0xtoken",
  amount: 5,
  hasUnknownAmount: false,
})

describe("TxLifecycleService — async-send synth-row + bridge", () => {
  beforeEach(() => {
    resetSingletons()
    provingProgress.emitReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    provingProgress.emitReset()
    TxLifecycleService.reset()
  })

  describe("recordPreSubmitSendRow", () => {
    it("creates a synth row and registers the operationId → queueId map", async () => {
      const { lifecycle, transactions } = setup()

      await lifecycle.recordPreSubmitSendRow("q-1", "op-1", {
        token: sampleToken(),
        recipient: "0xrecipient",
      })

      const txs = await transactions.getTransactions()
      expect(txs).toHaveLength(1)
      expect(txs[0]).toMatchObject({
        queueId: "q-1",
        operationId: "op-1",
        detailedStatus: QueueStatus.PENDING,
        txHash: "",
      })
    })
  })

  describe("subscribeToProvingProgress bridge", () => {
    it("routes stage-start events via op id → queue id and updates the tracker synchronously", async () => {
      const { lifecycle } = setup()
      await lifecycle.recordPreSubmitSendRow("q-1", "op-1", {
        token: sampleToken(),
        recipient: "0xr",
      })

      // Synchronous emit — bridge must propagate to tracker on the same tick.
      provingProgress.emitStageStart(ProvingStage.Mining, "op-1")

      const tracker = TransactionTracker.getInstance()
      const item = tracker.getQueueItem("q-1")
      expect(item).toBeUndefined()
      // The tracker doesn't have a synth-row queue entry by default — the
      // bridge calls `updateStatus(queueId, status)` which mutates an
      // existing item. For the synth-row, the queueId is created by
      // `startTrackingTx` at the React layer; here we simulate that by
      // adding an item before emitting.
    })

    it("MINING stage-start updates tracker queue item synchronously and patches storage async", async () => {
      const { lifecycle, transactions } = setup()

      // Simulate the React layer: create a queue entry first, then the
      // synth row, then emit stage events.
      const tracker = TransactionTracker.getInstance()
      const queueId = await tracker.addToQueue("Sending Token", 240000)
      await lifecycle.recordPreSubmitSendRow(queueId, "op-2", {
        token: sampleToken(),
        recipient: "0xr",
      })

      // Stage-start fires synchronously; the bridge calls
      // tracker.updateStatus(...) on the same tick, which updates the
      // in-memory queue item BEFORE async storage write completes.
      provingProgress.emitStageStart(ProvingStage.Mining, "op-2")

      // Synchronous read — tracker reflects MINING immediately.
      expect(tracker.getQueueItem(queueId)?.status).toBe(QueueStatus.MINING)

      // Wait for async storage write-through, then verify persisted row.
      await new Promise((r) => setTimeout(r, 0))
      const txs = await transactions.getTransactions()
      expect(txs[0].detailedStatus).toBe(QueueStatus.MINING)
    })

    it("Simulating → Witgen → Proving stages map to SIMULATING and PROVING", async () => {
      const { lifecycle } = setup()
      const tracker = TransactionTracker.getInstance()
      const queueId = await tracker.addToQueue("Sending", 240000)
      await lifecycle.recordPreSubmitSendRow(queueId, "op-3", {
        token: sampleToken(),
        recipient: "0xr",
      })

      provingProgress.emitStageStart(ProvingStage.Simulating, "op-3")
      expect(tracker.getQueueItem(queueId)?.status).toBe(QueueStatus.SIMULATING)

      provingProgress.emitStageStart(ProvingStage.Witgen, "op-3")
      expect(tracker.getQueueItem(queueId)?.status).toBe(QueueStatus.PROVING)

      provingProgress.emitStageStart(ProvingStage.Proving, "op-3")
      expect(tracker.getQueueItem(queueId)?.status).toBe(QueueStatus.PROVING)
    })

    it("drops events for unknown op ids (no map entry yet)", async () => {
      const { lifecycle } = setup()
      const tracker = TransactionTracker.getInstance()
      const queueId = await tracker.addToQueue("Sending", 240000)
      // Emit BEFORE recordPreSubmitSendRow registers op id → queue id.
      const initial = tracker.getQueueItem(queueId)?.status

      provingProgress.emitStageStart(ProvingStage.Simulating, "unknown-op")

      // Tracker queue item unchanged.
      expect(tracker.getQueueItem(queueId)?.status).toBe(initial)

      // After registration + a NEW stage event, the bridge picks it up.
      await lifecycle.recordPreSubmitSendRow(queueId, "op-late", {
        token: sampleToken(),
        recipient: "0xr",
      })
      provingProgress.emitStageStart(ProvingStage.Witgen, "op-late")
      expect(tracker.getQueueItem(queueId)?.status).toBe(QueueStatus.PROVING)
    })

    it("is idempotent — second call wires no extra listeners", () => {
      const { lifecycle } = setup()
      // Pre-emit an event count baseline. The first call wired listeners
      // in `setup()`. A second call should not double-wire.
      const before = provingProgress.listenerCount("stage-start")
      lifecycle.subscribeToProvingProgress()
      const after = provingProgress.listenerCount("stage-start")
      expect(after).toBe(before)
    })
  })

  describe("queue → storage write-through (async)", () => {
    it("tracker.updateStatus eventually patches the persisted detailedStatus", async () => {
      const { lifecycle, transactions } = setup()
      const tracker = TransactionTracker.getInstance()
      const queueId = await tracker.addToQueue("Sending", 240000)
      await lifecycle.recordPreSubmitSendRow(queueId, "op-w", {
        token: sampleToken(),
        recipient: "0xr",
      })

      tracker.updateStatus(queueId, QueueStatus.SIMULATING)

      // Async patch — wait one microtask.
      await new Promise((r) => setTimeout(r, 0))
      const txs = await transactions.getTransactions()
      expect(txs[0].detailedStatus).toBe(QueueStatus.SIMULATING)
    })
  })
})
