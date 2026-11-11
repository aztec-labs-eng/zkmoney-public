import { memoryBackend } from "../../src/engine/memoryBackend"
import { openDatabase } from "../../src/engine/database"
import { beforeEach, expect, it, vi } from "vitest"
import { TxStatus, TxExecutionResult } from "@aztec-labs/stdlib/tx"
import { ProvingStage } from "@obsidion/core/types"
import { createProver } from "../../src/engine/prover"
import { createWithdrawals, type Withdrawals } from "../../src/engine/withdrawals"
import { stampWithdrawal, trackWithdrawalSubmission } from "../../src/engine/withdrawalTracker"
import { createOperations } from "../../src/engine/operations"
import type { Database } from "../../src/engine/database"

const hash = `0x${"11".repeat(32)}` as const
const prover = createProver({ now: () => Date.now() })
/** The wallet's send reaching Mining with its hash, in its own turn. */
const mining = (operationId: string, txHash: string) =>
  prover.turn(async (progress) => progress.stage(ProvingStage.Mining, operationId, txHash))
let db: Database
let store: Withdrawals
beforeEach(async () => {
  db = openDatabase(memoryBackend())
  store = createWithdrawals({ db, now: () => Date.now() })
  await store.create({
    networkId: "0xnet",
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
    const monitor = trackWithdrawalSubmission(prover.progress, store, "test", "op")
    try {
      await mining("op", hash)
      const node = {
        getTxReceipt: vi.fn(async () => ({ status, executionResult: TxExecutionResult.REVERTED })),
      }
      expect(await monitor.recover(node as never)).toBeNull()
    } finally {
      monitor.stop()
    }
  },
)

it("keeps an ambiguous transport failure and ignores unrelated operations", async () => {
  const monitor = trackWithdrawalSubmission(prover.progress, store, "test", "op")
  const node = {
    getTxReceipt: vi.fn(async () => {
      throw new Error("offline")
    }),
  }
  try {
    await mining("unrelated", hash)
    expect(await monitor.recover(node as never)).toBeNull()
    await monitor.stamp(hash)
    await mining("op", hash)
    expect(await monitor.recover(node as never)).toMatchObject({
      phase: "submitting",
      l2TxHash: hash,
    })
  } finally {
    monitor.stop()
  }
  await mining("op", `0x${"33".repeat(32)}`)
  expect((await store.get("test"))?.l2TxHash).toBe(hash)
})

it("saves a burn's hash on its withdrawal and on the operation it names, in one write", async () => {
  const operations = createOperations({ db, now: () => Date.now() })
  await operations.begin({ operationId: "op", flow: "withdraw", summary: "Backup" })
  await store.apply("test", { type: "patch", fields: { operationId: "op" } })
  await stampWithdrawal({ db, withdrawals: store, operations }, "test", hash)
  expect((await store.get("test"))?.l2TxHash).toBe(hash)
  expect(operations.view.get().records).toMatchObject([{ state: "sent", txHash: hash }])
})

it("saves no hash when the withdrawal names no operation", async () => {
  const operations = createOperations({ db, now: () => Date.now() })
  await expect(
    stampWithdrawal({ db, withdrawals: store, operations }, "test", hash),
  ).rejects.toThrow()
  expect((await store.get("test"))?.l2TxHash).toBeUndefined()
})
