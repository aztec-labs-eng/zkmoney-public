import { expect, it, vi } from "vitest"
import { TxStatus, TxExecutionResult } from "@aztec/stdlib/tx"
import { provingProgress, ProvingStage } from "@obsidion/proving-progress"
import { trackSubmission } from "../../src/core/services/transactions/trackSubmission"

const hash = `0x${"11".repeat(32)}` as const
const receipt = (status: TxStatus, executionResult?: TxExecutionResult) => ({
  getTxReceipt: vi.fn(async () => ({ status, executionResult })),
})

it("reports nothing submitted when the boundary was never crossed", async () => {
  const submission = trackSubmission("op")
  try {
    expect(submission.txHash).toBeUndefined()
    expect(await submission.survived(receipt(TxStatus.SUCCESS) as never)).toBeNull()
  } finally {
    await submission.stop()
  }
})

it("survives a receipt that does not prove failure", async () => {
  const submission = trackSubmission("op")
  try {
    provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
    const node = receipt(TxStatus.PROVEN, TxExecutionResult.SUCCESS)
    expect(await submission.survived(node as never)).toBe(hash)
  } finally {
    await submission.stop()
  }
})

it.each([
  ["dropped", TxStatus.DROPPED, undefined],
  ["reverted", TxStatus.PROVEN, TxExecutionResult.REVERTED],
])("does not survive a %s receipt", async (_label, status, execution) => {
  const submission = trackSubmission("op")
  try {
    provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
    expect(await submission.survived(receipt(status, execution) as never)).toBeNull()
  } finally {
    await submission.stop()
  }
})

// The bug this exists for: an unreachable node is not evidence the transfer failed.
it("keeps the hash when the receipt lookup itself fails", async () => {
  const submission = trackSubmission("op")
  const node = {
    getTxReceipt: vi.fn(async () => {
      throw new Error("offline")
    }),
  }
  try {
    provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
    expect(await submission.survived(node as never)).toBe(hash)
  } finally {
    await submission.stop()
  }
})

it("ignores another operation's boundary", async () => {
  const submission = trackSubmission("op")
  try {
    provingProgress.emitStageStart(ProvingStage.Mining, "other", hash)
    expect(submission.txHash).toBeUndefined()
    expect(await submission.survived(receipt(TxStatus.PROVEN) as never)).toBeNull()
  } finally {
    await submission.stop()
  }
})

it("stamps the hash once, and a failed stamp never fails the send", async () => {
  const onSubmitted = vi.fn(async () => {
    throw new Error("storage down")
  })
  const submission = trackSubmission("op", onSubmitted)
  try {
    provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
    provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
    expect(onSubmitted).toHaveBeenCalledTimes(1)
    expect(onSubmitted).toHaveBeenCalledWith(hash)
    expect(await submission.survived(receipt(TxStatus.PROVEN) as never)).toBe(hash)
  } finally {
    await expect(submission.stop()).resolves.toBeUndefined()
  }
})

it("stops listening after stop", async () => {
  const onSubmitted = vi.fn()
  const submission = trackSubmission("op", onSubmitted)
  await submission.stop()
  provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
  expect(onSubmitted).not.toHaveBeenCalled()
  expect(submission.txHash).toBeUndefined()
})

// `tx-hash-saved` is what tells a UI a reload is safe, so it fires only once the write has landed.
it.each([
  ["a save that lands", async () => {}, [{ operationId: "op", txHash: hash }]],
  ["a save that fails", async () => Promise.reject(new Error("disk full")), []],
])("announces the hash as saved only after %s", async (_label, save, expected) => {
  const saved = vi.fn()
  provingProgress.on("tx-hash-saved", saved)
  const submission = trackSubmission("op", save)
  try {
    provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
    await submission.stop()
    expect(saved.mock.calls.map(([event]) => event)).toEqual(expected)
  } finally {
    provingProgress.off("tx-hash-saved", saved)
  }
})

it("announces nothing when the caller saves no hash", async () => {
  const saved = vi.fn()
  provingProgress.on("tx-hash-saved", saved)
  const submission = trackSubmission("op")
  try {
    provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
    await submission.stop()
    expect(saved).not.toHaveBeenCalled()
  } finally {
    provingProgress.off("tx-hash-saved", saved)
  }
})
