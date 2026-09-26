import { beforeEach, expect, it, vi } from "vitest"
import { TxStatus, TxExecutionResult } from "@aztec/stdlib/tx"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"
import { OperationStore } from "../../src/core/services/operations/OperationStore"

const hash = `0x${"11".repeat(32)}`
let memory: Map<string, string>
let store: OperationStore
let writesFail = false

beforeEach(() => {
  memory = new Map()
  writesFail = false
  OperationStore.reset()
  store = OperationStore.get({
    getItem: async (k: string) => memory.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      if (writesFail) throw new Error("QuotaExceededError")
      memory.set(k, v)
    },
    removeItem: async (k: string) => void memory.delete(k),
    clear: async () => memory.clear(),
  } as never)
})

const begin = (operationId: string, scope: string | null = "acct", startedAt = 1_000) =>
  store.begin({ operationId, flow: "send", summary: "$25 to @alice", scope }, startedAt)

const flush = () => new Promise((r) => setTimeout(r, 0))

it("moves to sent only when the flow's record holds the hash", async () => {
  await begin("op")
  expect(store.get("op")?.state).toBe("local")
  provingProgress.emitTxHashSaved("op", hash)
  await flush()
  expect(store.get("op")).toMatchObject({ state: "sent", txHash: hash })
})

it("stamps when proving began from the first stage event under the record's id", async () => {
  await begin("op")
  expect(store.get("op")?.provingStartedAt).toBeUndefined()
  provingProgress.emitStageStart(ProvingStage.Simulating, "other-op")
  provingProgress.emitStageStart(ProvingStage.Simulating, "op")
  await flush()
  const first = store.get("op")?.provingStartedAt
  expect(first).toBeTypeOf("number")
  provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
  await flush()
  expect(store.get("op")?.provingStartedAt).toBe(first)
})

it("drops, rather than fails, a record from an earlier page that never began proving", async () => {
  await begin("read-only", "acct", 1_000)
  await store.failInterrupted(2_000, 6_000)
  expect(store.get("read-only")).toBeNull()
})

it("fails every local record from an earlier page, whatever its scope", async () => {
  await begin("old", "acct", 1_000)
  await begin("visitor", null, 1_500)
  await begin("mine", "acct", 5_000)
  await store.markProving("old", 1_100)
  await store.markProving("visitor", 1_600)
  await store.failInterrupted(2_000, 6_000)
  expect(store.get("old")).toMatchObject({ state: "failed", cause: "interrupted", scope: "acct" })
  expect(store.get("old")?.error).toBeUndefined()
  expect(store.get("visitor")).toMatchObject({ state: "failed", cause: "interrupted", scope: null })
  expect(store.get("mine")?.state).toBe("local")
})

it("keeps the parent a child operation runs inside", async () => {
  await store.begin({ operationId: "child", flow: "deposit", summary: "x", scope: null, parent: "root" })
  expect(store.get("child")?.parent).toBe("root")
})

it("stops listening for saved hashes once reset", async () => {
  await begin("op")
  const old = store
  OperationStore.reset()
  provingProgress.emitTxHashSaved("op", hash)
  await flush()
  expect(old.get("op")?.state).toBe("local")
})

it("keeps the first outcome when a late hash save races the end", async () => {
  await begin("op")
  await Promise.all([store.settle("op", hash), store.markSent("op", hash)])
  expect(store.get("op")?.state).toBe("settled")
})

it("owns an operation only once its record is written", async () => {
  const pending = begin("op")
  expect(store.isLive("op")).toBe(false)
  await pending
  expect(store.isLive("op")).toBe(true)
})

it("never fails a sent record at boot: the chain decides it", async () => {
  await begin("op", "acct", 1_000)
  await store.markSent("op", hash)
  await store.failInterrupted(2_000)
  expect(store.get("op")?.state).toBe("sent")
})

it.each([
  ["included", { status: TxStatus.PROPOSED, executionResult: TxExecutionResult.SUCCESS, blockNumber: 7 }, "settled"],
  ["dropped", { status: TxStatus.DROPPED }, "failed"],
  ["reverted", { status: TxStatus.PROVEN, executionResult: TxExecutionResult.REVERTED, blockNumber: 7 }, "failed"],
  ["pending", { status: TxStatus.PENDING }, "sent"],
])("resolves an unowned sent record from a %s receipt", async (_label, receipt, state) => {
  await begin("op")
  await store.markSent("op", hash)
  store.release("op")
  await store.resolveSent({ getTxReceipt: vi.fn(async () => receipt) } as never)
  expect(store.get("op")?.state).toBe(state)
  if (state === "failed") expect(store.get("op")?.cause).toBe("dropped")
})

it("leaves a sent record to the flow that still owns it", async () => {
  await begin("op")
  await store.markSent("op", hash)
  const getTxReceipt = vi.fn(async () => ({ status: TxStatus.DROPPED }))
  await store.resolveSent({ getTxReceipt } as never)
  expect(getTxReceipt).not.toHaveBeenCalled()
  expect(store.get("op")?.state).toBe("sent")
})

it("leaves a sent record with no hash to the flow whose reads end it", async () => {
  await begin("op")
  await store.markSent("op")
  store.release("op")
  const getTxReceipt = vi.fn(async () => ({ status: TxStatus.DROPPED }))
  await store.resolveSent({ getTxReceipt } as never)
  expect(getTxReceipt).not.toHaveBeenCalled()
  await store.failInterrupted(2_000)
  expect(store.get("op")?.state).toBe("sent")
})

it("keeps a record when the node is unreachable", async () => {
  await begin("op")
  await store.markSent("op", hash)
  store.release("op")
  await store.resolveSent({ getTxReceipt: vi.fn(async () => Promise.reject(new Error("down"))) } as never)
  expect(store.get("op")?.state).toBe("sent")
})

it("keeps the first outcome and drops ended records past retention", async () => {
  await begin("op")
  await store.settle("op", hash, 10_000)
  await store.fail("op", "late", 11_000)
  expect(store.get("op")?.state).toBe("settled")
  await store.failInterrupted(0, 10_000 + 29 * 24 * 60 * 60 * 1000)
  expect(store.get("op")?.state).toBe("settled")
  await store.failInterrupted(0, 10_000 + 31 * 24 * 60 * 60 * 1000)
  expect(store.get("op")).toBeNull()
})

it("marks endings read and cleared, leaving running operations and other scopes alone", async () => {
  await begin("done")
  await store.settle("done", hash, 2_000)
  await begin("running")
  await begin("other", "acct-b")
  await store.settle("other", hash, 2_000)
  await store.markRead(["done", "running"], 3_000)
  expect(store.get("done")?.readAt).toBe(3_000)
  expect(store.get("running")?.readAt).toBeUndefined()
  await store.dismissEnded("acct", 4_000)
  expect(store.get("done")).toMatchObject({ readAt: 3_000, dismissedAt: 4_000 })
  expect(store.get("running")?.dismissedAt).toBeUndefined()
  expect(store.get("other")?.dismissedAt).toBeUndefined()
  await store.dismiss("other", 5_000)
  expect(store.get("other")).toMatchObject({ readAt: 5_000, dismissedAt: 5_000 })
})

it("survives a reload: the next store reads what this one wrote", async () => {
  await begin("op")
  OperationStore.reset()
  const next = OperationStore.get({
    getItem: async (k: string) => memory.get(k) ?? null,
    setItem: async (k: string, v: string) => void memory.set(k, v),
    removeItem: async (k: string) => void memory.delete(k),
  } as never)
  await next.load()
  expect(next.get("op")?.state).toBe("local")
  expect(next.isLive("op")).toBe(false)
})

it("never reads as sent when the hash write did not land", async () => {
  await begin("op")
  writesFail = true
  provingProgress.emitTxHashSaved("op", hash)
  await flush()
  expect(store.get("op")?.state).toBe("local")
  expect(memory.get("@obsidion/operations")).not.toContain('"sent"')
})

it("refuses to begin an operation it cannot record", async () => {
  writesFail = true
  await expect(begin("op")).rejects.toThrow("QuotaExceededError")
  expect(store.get("op")).toBeNull()
})
