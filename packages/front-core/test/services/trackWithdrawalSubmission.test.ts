import { beforeEach, expect, it, vi } from "vitest"
import { TxStatus, TxExecutionResult } from "@aztec/stdlib/tx"
import { provingProgress, ProvingStage } from "@obsidion/proving-progress"
import { WithdrawalStorage } from "../../src/core/services/bridge/WithdrawalStorage"
import { trackWithdrawalSubmission } from "../../src/core/services/bridge/WithdrawalTrackingService"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../__test-helpers__/resetSingleton"

const hash = `0x${"11".repeat(32)}` as const
let store: WithdrawalStorage
beforeEach(async () => {
  resetSingleton(WithdrawalStorage as unknown as { instance: WithdrawalStorage | null })
  store = WithdrawalStorage.get(new InMemoryStorageAdapter())
  await store.create({
    localId: "test",
    recipient: `0x${"22".repeat(20)}`,
    recipientProvenance: "saved-recipient",
    amount: "1",
    tokenSymbol: "DAI",
    source: "paylink",
    phase: "submitting",
    startTime: Date.now(),
  })
})

it.each([TxStatus.DROPPED, TxStatus.PROVEN])(
  "does not recover unsuccessful receipt %s as pending",
  async (status) => {
    const monitor = trackWithdrawalSubmission(store, "test", "op")
    try {
      provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
      const node = {
        getTxReceipt: vi.fn(async () => ({ status, executionResult: TxExecutionResult.REVERTED })),
      }
      expect(await monitor.recover(node as never)).toBeNull()
    } finally {
      await monitor.stop()
    }
  },
)

it("keeps an ambiguous transport failure and ignores unrelated operations", async () => {
  const monitor = trackWithdrawalSubmission(store, "test", "op")
  const node = {
    getTxReceipt: vi.fn(async () => {
      throw new Error("offline")
    }),
  }
  try {
    provingProgress.emitStageStart(ProvingStage.Mining, "unrelated", hash)
    expect(await monitor.recover(node as never)).toBeNull()
    provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
    expect(await monitor.recover(node as never)).toMatchObject({
      phase: "submitting",
      l2TxHash: hash,
    })
  } finally {
    await monitor.stop()
  }
  provingProgress.emitStageStart(ProvingStage.Mining, "op", `0x${"33".repeat(32)}`)
  expect(store.get("test")?.l2TxHash).toBe(hash)
})

it("does not fail a mined burn when persisting the broadcast hash fails", async () => {
  const patch = vi.spyOn(store, "patch").mockRejectedValueOnce(new Error("Storage unavailable"))
  const monitor = trackWithdrawalSubmission(store, "test", "op")
  provingProgress.emitStageStart(ProvingStage.Mining, "op", hash)
  await expect(monitor.stop()).resolves.toBeUndefined()
  patch.mockRestore()
})
