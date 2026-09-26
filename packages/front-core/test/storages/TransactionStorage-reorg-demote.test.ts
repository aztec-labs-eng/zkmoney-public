import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueueStatus } from "@obsidion/sdk"
import { AccountStorage, NetworkStorage, TransactionStorage } from "../../src/core"
import { TransactionTracker } from "../../src/core/services/transactions/TransactionTracker"
import type { TokenInTxService } from "../../src/types"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"

vi.mock("@aztec/aztec.js/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aztec/aztec.js/node")>()
  return { ...actual, createAztecNodeClient: vi.fn() }
})

const TX = "0x" + "ab".repeat(32)

const resetSingletons = () => {
  ;(AccountStorage as unknown as { instance: AccountStorage | null }).instance = null
  ;(TransactionStorage as unknown as { instance: TransactionStorage | null }).instance = null
  ;(NetworkStorage as unknown as { instance: NetworkStorage | null }).instance = null
}

const setup = () => {
  resetSingletons()
  const adapter = new InMemoryStorageAdapter()
  AccountStorage.get(adapter)
  const transactions = TransactionStorage.get(adapter)
  return { adapter, transactions }
}

const sampleToken = (): TokenInTxService => ({
  name: "ETH",
  decimals: 18,
  logo: "https://example.com/eth.png",
  price: 1000,
  symbol: "ETH",
  address: "0xtoken",
  amount: 1,
  hasUnknownAmount: false,
})

const stubTracker = () => {
  ;(TransactionTracker as unknown as { instance: unknown }).instance = null
  const tracker = TransactionTracker.getInstance()
  vi.spyOn(tracker, "getQueue").mockReturnValue([])
}

/** Seed one send row, confirm it via updateByTxHash(SUCCESS), stamp anchors. */
async function seedConfirmed(transactions: TransactionStorage, queueId = "q-1") {
  await transactions.addTokenTransaction("send", sampleToken(), "pending", TX, "0xr", queueId)
  await transactions.updateTransaction(
    (tx) => tx.txHash === TX,
    (tx) => {
      tx.blockNumber = 42
      tx.blockHash = "0xblock42"
    },
  )
  await transactions.updateByTxHash(TX, QueueStatus.SUCCESS, 1111)
}

describe("TransactionStorage — reorg demote + epoch guard", () => {
  beforeEach(() => {
    resetSingletons()
    stubTracker()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("demoteByTxHash reverses a confirmed row to pending, bumps epoch, clears terminal marks, keeps anchors", async () => {
    const { transactions } = setup()
    await seedConfirmed(transactions)

    const result = await transactions.demoteByTxHash(TX)
    expect(result.matched).toBe(true)
    expect(result.reorgEpoch).toBe(1)

    const [tx] = await transactions.getTransactions()
    expect(tx.status).toBe("pending")
    expect(tx.detailedStatus).toBe(QueueStatus.PENDING)
    expect(tx.endTime).toBeUndefined()
    expect(tx.reorgEpoch).toBe(1)
    // anchors preserved
    expect(tx.blockNumber).toBe(42)
    expect(tx.blockHash).toBe("0xblock42")
  })

  it("demote then stale SUCCESS (no epoch) via updateByTxHash → stays demoted", async () => {
    const { transactions } = setup()
    await seedConfirmed(transactions)
    await transactions.demoteByTxHash(TX)

    await transactions.updateByTxHash(TX, QueueStatus.SUCCESS, 2222)

    const [tx] = await transactions.getTransactions()
    expect(tx.status).toBe("pending")
    expect(tx.detailedStatus).toBe(QueueStatus.PENDING)
    expect(tx.reorgEpoch).toBe(1)
  })

  it("demote then confirm with matching epoch → confirmed", async () => {
    const { transactions } = setup()
    await seedConfirmed(transactions)
    const { reorgEpoch } = await transactions.demoteByTxHash(TX)

    await transactions.updateByTxHash(TX, QueueStatus.SUCCESS, 3333, reorgEpoch)

    const [tx] = await transactions.getTransactions()
    expect(tx.status).toBe("success")
    expect(tx.detailedStatus).toBe(QueueStatus.SUCCESS)
    expect(tx.endTime).toBe(3333)
    expect(tx.reorgEpoch).toBe(1)
  })

  it("repeat demote keeps incrementing the epoch", async () => {
    const { transactions } = setup()
    await seedConfirmed(transactions)
    await transactions.demoteByTxHash(TX)
    await transactions.updateByTxHash(TX, QueueStatus.SUCCESS, 3333, 1)
    const second = await transactions.demoteByTxHash(TX)
    expect(second.reorgEpoch).toBe(2)
    await transactions.updateByTxHash(TX, QueueStatus.SUCCESS, 4444, 1) // stale epoch
    const [tx] = await transactions.getTransactions()
    expect(tx.status).toBe("pending")
  })

  it("terminal variant lands failed immediately with epoch bump and endTime", async () => {
    const { transactions } = setup()
    await seedConfirmed(transactions)

    const result = await transactions.demoteByTxHash(TX, { terminal: "failed" })
    expect(result.matched).toBe(true)

    const [tx] = await transactions.getTransactions()
    expect(tx.status).toBe("failed")
    expect(tx.detailedStatus).toBe(QueueStatus.FAILED)
    expect(tx.endTime).toBeDefined()
    expect(tx.reorgEpoch).toBe(1)
  })

  it("demoteByTxHash on an unknown hash is a no-op", async () => {
    const { transactions } = setup()
    const result = await transactions.demoteByTxHash("0x" + "ff".repeat(32))
    expect(result.matched).toBe(false)
  })

  it("epoch guard blocks updateTransactionCompletion and patchDetailedStatusForQueue without epoch after demote", async () => {
    const { transactions } = setup()
    // patchDetailedStatusForQueue keeps queueId on terminal writes, so the
    // queue-keyed writers can still find the row post-demote.
    await transactions.addTokenTransaction("send", sampleToken(), "pending", TX, "0xr", "q-keep")
    await transactions.patchDetailedStatusForQueue("q-keep", QueueStatus.SUCCESS)
    await transactions.demoteByTxHash(TX)

    await transactions.updateTransactionCompletion("q-keep", QueueStatus.SUCCESS, 5555)
    let [tx] = await transactions.getTransactions()
    expect(tx.status).toBe("pending")

    await transactions.patchDetailedStatusForQueue("q-keep", QueueStatus.SUCCESS)
    ;[tx] = await transactions.getTransactions()
    expect(tx.status).toBe("pending")

    await transactions.patchSynthRowAtMining("q-keep", QueueStatus.MINING, TX)
    ;[tx] = await transactions.getTransactions()
    expect(tx.detailedStatus).toBe(QueueStatus.PENDING)

    // Matching epoch goes through.
    await transactions.updateTransactionCompletion("q-keep", QueueStatus.SUCCESS, 6666, 1)
    ;[tx] = await transactions.getTransactions()
    expect(tx.status).toBe("success")
  })

  it("regression: SUCCESS after CANCELLED is still blocked", async () => {
    const { transactions } = setup()
    await transactions.addTokenTransaction("send", sampleToken(), "pending", TX, "0xr", "q-c")
    await transactions.updateTransactionCompletion("q-c", QueueStatus.CANCELLED, 100)
    await transactions.updateByTxHash(TX, QueueStatus.SUCCESS, 200)
    const [tx] = await transactions.getTransactions()
    expect(tx.detailedStatus).toBe(QueueStatus.CANCELLED)
    expect(tx.status).toBe("failed")
  })
})
