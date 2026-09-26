import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueueStatus } from "@obsidion/sdk"
import { AccountStorage, NetworkStorage, TransactionStorage } from "../../src/core"
import { TransactionTracker } from "../../src/core/services/transactions/TransactionTracker"
import type { Transaction, TokenInTxService } from "../../src/types"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"

const resetSingletons = () => {
  ;(AccountStorage as unknown as { instance: AccountStorage | null }).instance = null
  ;(TransactionStorage as unknown as { instance: TransactionStorage | null }).instance = null
  ;(NetworkStorage as unknown as { instance: NetworkStorage | null }).instance = null
  ;(TransactionTracker as unknown as { instance: TransactionTracker | null }).instance = null
}

const setup = () => {
  resetSingletons()
  const adapter = new InMemoryStorageAdapter()
  AccountStorage.get(adapter)
  const transactions = TransactionStorage.get(adapter)
  return { adapter, transactions }
}

const sampleToken = (overrides: Partial<TokenInTxService> = {}): TokenInTxService => ({
  name: "DAI",
  decimals: 6,
  logo: "https://example.com/dai.png",
  price: 1,
  symbol: "DAI",
  address: "0xtoken",
  amount: 5,
  hasUnknownAmount: false,
  ...overrides,
})

describe("TransactionStorage — async-send synth-row API", () => {
  beforeEach(() => {
    resetSingletons()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("addPreSubmitTokenTransaction", () => {
    it("persists a Pending row with empty txHash, queueId, operationId, and PENDING detailedStatus", async () => {
      const { transactions } = setup()

      await transactions.addPreSubmitTokenTransaction(
        "queue-1",
        "send_1_1000",
        sampleToken(),
        "0xrecipient",
      )

      const txs = await transactions.getTransactions()
      expect(txs).toHaveLength(1)
      expect(txs[0]).toMatchObject({
        action: "send",
        status: "pending",
        txHash: "",
        queueId: "queue-1",
        operationId: "send_1_1000",
        detailedStatus: QueueStatus.PENDING,
        kind: "send",
        to: "0xrecipient",
      })
    })

    it("can persist multiple synth rows distinguished by queueId", async () => {
      const { transactions } = setup()

      await transactions.addPreSubmitTokenTransaction("q-1", "op-1", sampleToken(), "0xa")
      await transactions.addPreSubmitTokenTransaction("q-2", "op-2", sampleToken(), "0xb")

      const txs = await transactions.getTransactions()
      expect(txs).toHaveLength(2)
      expect(txs[0].queueId).toBe("q-1")
      expect(txs[1].queueId).toBe("q-2")
    })
  })

  describe("patchTxHashForQueue", () => {
    it("writes a real txHash onto a synth row keyed by queueId", async () => {
      const { transactions } = setup()
      await transactions.addPreSubmitTokenTransaction("q-1", "op-1", sampleToken(), "0xr")

      const ok = await transactions.patchTxHashForQueue("q-1", "0xrealhash")

      expect(ok).toBe(true)
      const txs = await transactions.getTransactions()
      expect(txs[0].txHash).toBe("0xrealhash")
      expect(txs[0].queueId).toBe("q-1")
    })

    it("returns false when no synth row matches queueId", async () => {
      const { transactions } = setup()

      const ok = await transactions.patchTxHashForQueue("nonexistent", "0xhash")

      expect(ok).toBe(false)
    })

    it("does not overwrite an already-set txHash", async () => {
      const { transactions } = setup()
      await transactions.addPreSubmitTokenTransaction("q-1", "op-1", sampleToken(), "0xr")
      await transactions.patchTxHashForQueue("q-1", "0xfirsthash")

      const ok = await transactions.patchTxHashForQueue("q-1", "0xsecondhash")

      // The predicate `!tx.txHash || tx.txHash === ""` excludes already-patched rows.
      expect(ok).toBe(false)
      const txs = await transactions.getTransactions()
      expect(txs[0].txHash).toBe("0xfirsthash")
    })
  })

  describe("patchDetailedStatusForQueue", () => {
    it("writes detailedStatus onto a synth row", async () => {
      const { transactions } = setup()
      await transactions.addPreSubmitTokenTransaction("q-1", "op-1", sampleToken(), "0xr")

      const ok = await transactions.patchDetailedStatusForQueue("q-1", QueueStatus.PROVING)

      expect(ok).toBe(true)
      const txs = await transactions.getTransactions()
      expect(txs[0].detailedStatus).toBe(QueueStatus.PROVING)
    })

    it("returns false when queueId doesn't match any row", async () => {
      const { transactions } = setup()

      const ok = await transactions.patchDetailedStatusForQueue("nonexistent", QueueStatus.MINING)

      expect(ok).toBe(false)
    })
  })

  describe("updateByTxHash empty-hash guard", () => {
    it("returns false for empty txHash without matching synth rows", async () => {
      const { transactions } = setup()
      // Synth rows have txHash === "" — guard prevents matching them.
      await transactions.addPreSubmitTokenTransaction("q-1", "op-1", sampleToken(), "0xr")
      await transactions.addPreSubmitTokenTransaction("q-2", "op-2", sampleToken(), "0xr2")

      const ok = await transactions.updateByTxHash("", QueueStatus.SUCCESS)

      expect(ok.matched).toBe(false)
      // Both synth rows still pending — their detailedStatus is unchanged.
      const txs = await transactions.getTransactions()
      expect(txs[0].detailedStatus).toBe(QueueStatus.PENDING)
      expect(txs[1].detailedStatus).toBe(QueueStatus.PENDING)
      expect(txs[0].status).toBe("pending")
      expect(txs[1].status).toBe("pending")
    })
  })

  describe("monotonicity guard — CANCELLED stays final", () => {
    it("updateTransactionCompletion(FAILED) is a no-op once row is CANCELLED", async () => {
      const { transactions } = setup()
      await transactions.addPreSubmitTokenTransaction("q-1", "op-1", sampleToken(), "0xr")

      await transactions.updateTransactionCompletion("q-1", QueueStatus.CANCELLED)
      const beforeFailedAttempt = (await transactions.getTransactions())[0]
      expect(beforeFailedAttempt.detailedStatus).toBe(QueueStatus.CANCELLED)

      // queueId is reset to undefined on completion, so this no-op
      // returns immediately because queueId match fails. Use updateByTxHash
      // — but the row had no txHash, so there's nothing for FAILED to land
      // on. That's exactly the protection the empty-hash guard provides:
      // a stale wallet-side `completeTransaction(queueId, FAILED)` cannot
      // bring the CANCELLED row back to FAILED via either path.
      await transactions.updateTransactionCompletion("q-1", QueueStatus.FAILED)

      const txs = await transactions.getTransactions()
      expect(txs[0].detailedStatus).toBe(QueueStatus.CANCELLED)
    })

    it("PENDING → FAILED is allowed (no monotonicity protection)", async () => {
      const { transactions } = setup()
      await transactions.addPreSubmitTokenTransaction("q-1", "op-1", sampleToken(), "0xr")

      await transactions.updateTransactionCompletion("q-1", QueueStatus.FAILED)

      const txs = await transactions.getTransactions()
      expect(txs[0].detailedStatus).toBe(QueueStatus.FAILED)
      expect(txs[0].status).toBe("failed")
    })
  })
})

describe("TransactionStorage — failInterruptedSends", () => {
  const NOW = 1_700_000_000_000
  const HOUR = 60 * 60 * 1000

  beforeEach(() => {
    resetSingletons()
  })

  it("fails only hashless pending rows older than the timeout", async () => {
    const { transactions } = setup()
    const dateNow = vi.spyOn(Date, "now")
    dateNow.mockReturnValue(NOW - 2 * HOUR)
    await transactions.addPreSubmitTokenTransaction("stale", "op-stale", sampleToken(), "0xa")
    dateNow.mockReturnValue(NOW - 60_000)
    await transactions.addPreSubmitTokenTransaction("fresh", "op-fresh", sampleToken(), "0xb")
    dateNow.mockReturnValue(NOW - 2 * HOUR)
    await transactions.addPreSubmitTokenTransaction("mined", "op-mined", sampleToken(), "0xc")
    await transactions.updateTransaction(
      (tx) => tx.queueId === "mined",
      (tx) => {
        tx.txHash = "0xhash"
      },
    )
    dateNow.mockRestore()

    const failed = await transactions.failInterruptedSends(NOW)

    expect(failed.map((tx) => tx.queueId)).toEqual(["stale"])
    const byQueue = Object.fromEntries(
      (await transactions.getTransactions()).map((tx) => [tx.queueId, tx]),
    )
    expect(byQueue.stale).toMatchObject({
      status: "failed",
      detailedStatus: QueueStatus.FAILED,
      error: expect.stringMatching(/interrupted/),
    })
    expect(byQueue.fresh.status).toBe("pending")
    expect(byQueue.mined.status).toBe("pending")
  })

  it("is idempotent", async () => {
    const { transactions } = setup()
    vi.spyOn(Date, "now").mockReturnValue(NOW - 2 * HOUR)
    await transactions.addPreSubmitTokenTransaction("stale", "op", sampleToken(), "0xa")
    vi.restoreAllMocks()
    await transactions.failInterruptedSends(NOW)
    expect(await transactions.failInterruptedSends(NOW)).toEqual([])
  })
})
