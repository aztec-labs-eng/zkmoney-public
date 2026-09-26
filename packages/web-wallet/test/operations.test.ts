/**
 * One path for every user transaction: an operation is tab-bound until its flow's record holds the
 * hash, and a reload settles it either way. A record from an earlier page that never got a hash
 * fails at once; one with a hash is left to the chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"
import { TransactionStorage, TxInFlightError, trackSubmission } from "@obsidion/front-core"
import { webStorage } from "../src/platform/storage/WebStorageAdapter"
import {
  currentOperation,
  getOperationStore,
  leavingLosesTransaction,
  runOperation,
  tabBoundOperation,
} from "../src/features/operations/operations"
import { userFlowActive } from "../src/features/provingGate"
import { recoverInterrupted } from "../src/features/operations/OperationsMount"
import { getWithdrawalStore } from "../src/features/withdraw/withdrawGateway"

const hash = `0x${"ab".repeat(32)}`
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("runOperation", () => {
  it("returns the flow's result even when the settle write fails, and stays unsettled", async () => {
    const store = getOperationStore()
    const result = await runOperation(
      { operationId: "op-full", flow: "send", summary: "$1 to @bob" },
      async () => {
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new Error("QuotaExceededError")
        })
        return "done"
      },
    )
    expect(result).toBe("done")
    expect(store.get("op-full")?.state).toBe("local")
  })

  it("is local until the flow's record holds the hash, then settles with the flow", async () => {
    const store = getOperationStore()
    let seen: string | undefined
    await runOperation(
      { operationId: "op-send", flow: "send", summary: "$25" },
      async () => {
        expect(store.get("op-send")?.state).toBe("local")
        const submission = trackSubmission("op-send", async () => {})
        provingProgress.emitStageStart(ProvingStage.Mining, "op-send", hash)
        await submission.stop()
        await flush()
        seen = store.get("op-send")?.state
        return hash
      },
      (h) => h,
    )
    expect(seen).toBe("sent")
    expect(store.get("op-send")).toMatchObject({ state: "settled", txHash: hash })
  })

  it("drops the record when nothing was sent", async () => {
    const cancelled = runOperation(
      { operationId: "op-c", flow: "send", summary: "$1" },
      async () => {
        throw new Error("Cancelled")
      },
    )
    await expect(cancelled).rejects.toThrow("Cancelled")
    expect(getOperationStore().get("op-c")).toBeNull()
  })

  it("drops the record when the flow failed before proving began", async () => {
    const failed = runOperation({ operationId: "op-r", flow: "send", summary: "$1" }, async () => {
      throw new Error("@bob is no longer registered")
    })
    await expect(failed).rejects.toThrow("no longer registered")
    expect(getOperationStore().get("op-r")).toBeNull()
  })

  it("fails a local operation with the flow's error once proving began", async () => {
    const failed = runOperation({ operationId: "op-f", flow: "send", summary: "$1" }, async () => {
      provingProgress.emitStageStart(ProvingStage.Simulating, "op-f")
      await flush()
      throw new Error("TEE unavailable")
    })
    await expect(failed).rejects.toThrow("TEE unavailable")
    expect(getOperationStore().get("op-f")).toMatchObject({
      state: "failed",
      error: "TEE unavailable",
    })
  })

  it("leaves a sent operation to the chain when the flow lost track of it", async () => {
    const store = getOperationStore()
    const lost = runOperation({ operationId: "op-l", flow: "send", summary: "$1" }, async () => {
      await store.markSent("op-l", hash)
      throw new TxInFlightError(hash, new Error("socket closed"))
    })
    await expect(lost).rejects.toBeInstanceOf(TxInFlightError)
    expect(store.get("op-l")?.state).toBe("sent")
    expect(store.unowned().map((r) => r.operationId)).toContain("op-l")
  })

  it("marks an in-flight operation sent even when the flow's hash write failed", async () => {
    const store = getOperationStore()
    const lost = runOperation({ operationId: "op-w", flow: "send", summary: "$1" }, async () => {
      const submission = trackSubmission("op-w", async () => {
        throw new Error("quota exceeded")
      })
      provingProgress.emitStageStart(ProvingStage.Mining, "op-w", hash)
      await submission.stop()
      throw new TxInFlightError(hash, new Error("socket closed"))
    })
    await expect(lost).rejects.toBeInstanceOf(TxInFlightError)
    expect(store.get("op-w")).toMatchObject({ state: "sent", txHash: hash })
    expect(store.unowned().map((r) => r.operationId)).toContain("op-w")
  })

  it("leaves a burn that may still land to the chain with the hash it was sent under", async () => {
    const store = getOperationStore()
    await runOperation({ operationId: "op-b", flow: "withdraw", summary: "$1" }, async (op) => {
      op.leaveToChain(hash)
      return "pending-record"
    })
    expect(store.get("op-b")).toMatchObject({ state: "sent", txHash: hash })
    expect(store.unowned().map((r) => r.operationId)).toContain("op-b")
  })

  it("fails a sent operation with the flow's error when the chain turned it down", async () => {
    const store = getOperationStore()
    const dropped = runOperation({ operationId: "op-d", flow: "send", summary: "$1" }, async () => {
      const submission = trackSubmission("op-d", async () => {})
      provingProgress.emitStageStart(ProvingStage.Mining, "op-d", hash)
      await submission.stop()
      await flush()
      expect(store.get("op-d")?.state).toBe("sent")
      throw new Error("The network dropped this payment")
    })
    await expect(dropped).rejects.toThrow("dropped this payment")
    expect(store.get("op-d")).toMatchObject({
      state: "failed",
      error: "The network dropped this payment",
    })
    expect(store.get("op-d")?.cause).toBeUndefined()
  })

  it("binds the tab to a live operation of any scope", async () => {
    const store = getOperationStore()
    await store.begin({
      operationId: "op-visitor",
      flow: "paylink-claim",
      summary: "$1",
      scope: "x",
    })
    try {
      expect(leavingLosesTransaction()).toBe(true)
    } finally {
      await store.remove("op-visitor")
    }
    expect(leavingLosesTransaction()).toBe(false)
  })

  it("holds the single-flight gate while it runs", async () => {
    let gated = false
    await runOperation({ operationId: "op-g", flow: "send", summary: "$1" }, async () => {
      gated = userFlowActive()
    })
    expect(gated).toBe(true)
    expect(userFlowActive()).toBe(false)
  })
})

describe("currentOperation", () => {
  it("is the outermost live operation; every live local record still binds the tab", async () => {
    const store = getOperationStore()
    let release!: () => void
    const parentDone = runOperation(
      { operationId: "parent", flow: "paylink-claim", summary: "$5 paylink" },
      () =>
        runOperation(
          { operationId: "child", flow: "deposit", summary: "Deposit address", parent: "parent" },
          () => new Promise<void>((resolve) => (release = resolve)),
        ),
    )
    await flush()
    await flush()
    const records = store.list()
    expect(records.find((r) => r.operationId === "child")?.parent).toBe("parent")
    expect(currentOperation(records)?.operationId).toBe("parent")
    // The child alone binds the tab once its parent stopped running.
    store.release("parent")
    expect(currentOperation(store.list())?.operationId).toBe("child")
    expect(tabBoundOperation(store.list())).toBeDefined()
    release()
    await parentDone
    expect(currentOperation(store.list())).toBeUndefined()
  })
})

describe("recoverInterrupted", () => {
  const pageLoadedAt = 10_000
  const now = 20_000

  it("fails a withdrawal a reload cut off before submit, and keeps one that was sent", async () => {
    const withdrawals = getWithdrawalStore()
    const seed = (localId: string, l2TxHash?: string) =>
      withdrawals.create({
        localId,
        recipient: `0x${"22".repeat(20)}`,
        recipientProvenance: "saved-recipient",
        amount: "12.1",
        tokenSymbol: "DAI",
        phase: "submitting",
        startTime: pageLoadedAt - 5_000,
        ...(l2TxHash ? { l2TxHash } : {}),
      } as Parameters<typeof withdrawals.create>[0])
    await seed("cut-off")
    await seed("sent", hash)
    await recoverInterrupted(pageLoadedAt, now)
    expect(withdrawals.get("cut-off")?.phase).toBe("failed")
    expect(withdrawals.get("sent")?.phase).toBe("submitting")
  })

  it("fails a send row and every operation from an earlier page, never this page's", async () => {
    const ops = getOperationStore()
    await ops.begin(
      { operationId: "old", flow: "send", summary: "$1", scope: null },
      pageLoadedAt - 1,
    )
    await ops.markProving("old")
    ops.release("old")
    await ops.begin(
      { operationId: "other-scope", flow: "paylink-claim", summary: "$1", scope: "acct" },
      pageLoadedAt - 1,
    )
    await ops.markProving("other-scope")
    ops.release("other-scope")
    await ops.begin(
      { operationId: "never-proved", flow: "send", summary: "$1", scope: null },
      pageLoadedAt - 1,
    )
    ops.release("never-proved")
    await ops.begin(
      { operationId: "new", flow: "send", summary: "$1", scope: null },
      pageLoadedAt + 1,
    )
    const rows = TransactionStorage.get(webStorage)
    await rows.addTokenTransaction(
      "send",
      { address: "0x1", name: "DAI", symbol: "DAI", decimals: 18, logo: "", price: 1, amount: 1 },
      "pending",
      undefined,
      "0x2",
      "old",
    )
    await rows.updateTransaction(
      (tx) => tx.queueId === "old",
      (tx) => void (tx.timestamp = pageLoadedAt - 1),
    )
    await recoverInterrupted(pageLoadedAt, now)
    expect(ops.get("old")).toMatchObject({ state: "failed", cause: "interrupted" })
    expect(ops.get("other-scope")).toMatchObject({ state: "failed", cause: "interrupted" })
    expect(ops.get("never-proved")).toBeNull()
    expect(ops.get("new")?.state).toBe("local")
    const row = (await rows.getTransactions()).find((tx) => tx.queueId === "old")
    expect(row?.status).toBe("failed")
  })

  const sendRow = async (queueId: string, txHash?: string) => {
    const rows = TransactionStorage.get(webStorage)
    await rows.addTokenTransaction(
      "send",
      { address: "0x1", name: "DAI", symbol: "DAI", decimals: 18, logo: "", price: 1, amount: 1 },
      "pending",
      txHash,
      "0x2",
      queueId,
    )
    await rows.updateTransaction(
      (tx) => tx.queueId === queueId,
      (tx) => void (tx.timestamp = pageLoadedAt - 1),
    )
    return async () => (await rows.getTransactions()).find((tx) => tx.queueId === queueId)
  }

  it("stamps a sent operation's hash onto the flow's records, so neither is failed", async () => {
    const ops = getOperationStore()
    await ops.begin({ operationId: "rep", flow: "send", summary: "$1", scope: null }, 1)
    await ops.markSent("rep", hash)
    ops.release("rep")
    const row = await sendRow("rep")
    const withdrawals = getWithdrawalStore()
    await withdrawals.create({
      localId: "rep-burn",
      operationId: "rep",
      recipient: `0x${"22".repeat(20)}`,
      recipientProvenance: "saved-recipient",
      amount: "1",
      tokenSymbol: "DAI",
      phase: "submitting",
      startTime: pageLoadedAt - 5_000,
    } as Parameters<typeof withdrawals.create>[0])
    await recoverInterrupted(pageLoadedAt, now)
    expect(await row()).toMatchObject({ status: "pending", txHash: hash })
    expect(withdrawals.get("rep-burn")).toMatchObject({ phase: "submitting", l2TxHash: hash })
    expect(ops.get("rep")?.state).toBe("sent")
  })

  it("sends, not fails, a local operation whose flow's record holds the hash", async () => {
    const ops = getOperationStore()
    await ops.begin({ operationId: "rep2", flow: "send", summary: "$1", scope: null }, 1)
    await ops.markProving("rep2")
    ops.release("rep2")
    const row = await sendRow("rep2", hash)
    await recoverInterrupted(pageLoadedAt, now)
    expect(ops.get("rep2")).toMatchObject({ state: "sent", txHash: hash })
    expect((await row())?.status).toBe("pending")
  })
})
