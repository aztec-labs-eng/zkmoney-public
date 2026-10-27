/**
 * Post-submit pending-record resolution. The polling loop probes each pending
 * record's receipt and terminalizes both the record and the persisted
 * TransactionStorage row; the expiry sweep checks the receipt of a record past `expiresAtMs`
 * once more, then fails it unless it mined.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { InMemoryPendingTxStore, QueueStatus, type PendingTxRecord } from "@obsidion/sdk"
import {
  AccountStorage,
  NetworkStorage,
  TransactionStorage,
  TxLifecycleService,
  type TxLifecycleEvent,
  type TxReceiptLike,
} from "../../../src/core"
import { TransactionTracker } from "../../../src/core/services/transactions/TransactionTracker"
import type { TokenInTxService } from "../../../src/types"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"
import { PendingTxStore } from "../../../src/core/services/pending-tx"
import type { CryptoProvider } from "../../../src/core/storages/CryptoProvider"
import { EncryptedStorageAdapter } from "../../../src/core/storages/EncryptedStorageAdapter"

const identityCrypto: CryptoProvider = {
  encrypt: async (p) => p,
  decrypt: async (c) => c,
  keyAvailable: () => true,
  onKeyChanged: () => () => {},
}

const TX = "0x" + "ab".repeat(32)
const QUEUE_ID = "q-1"

const resetSingletons = () => {
  ;(AccountStorage as unknown as { instance: AccountStorage | null }).instance = null
  ;(TransactionStorage as unknown as { instance: TransactionStorage | null }).instance = null
  ;(NetworkStorage as unknown as { instance: NetworkStorage | null }).instance = null
  ;(TransactionTracker as unknown as { instance: TransactionTracker | null }).instance = null
  TxLifecycleService.reset()
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

type ReceiptState = "pending" | "mined" | "reverted" | "dropped"

const receipt = (state: ReceiptState): TxReceiptLike => ({
  isPending: () => state === "pending",
  isMined: () => state === "mined" || state === "reverted",
  isDropped: () => state === "dropped",
  hasExecutionSucceeded: () => state === "mined",
})

/** Scripted node: one receipt state per hash, or a throw when scripted as `"throw"`. */
class FakeNode {
  private readonly script = new Map<string, ReceiptState | "throw">()
  calls = 0
  set(txHash: string, state: ReceiptState | "throw") {
    this.script.set(txHash, state)
  }
  async getTxReceipt(txHash: string): Promise<TxReceiptLike> {
    this.calls++
    const state = this.script.get(txHash) ?? "pending"
    if (state === "throw") throw new Error("rpc down")
    return receipt(state)
  }
}

const pendingRecord = (overrides: Partial<PendingTxRecord> = {}): PendingTxRecord => ({
  txHash: TX,
  submittedAt: Date.now(),
  expiresAtMs: Date.now() + 60_000,
  ...overrides,
})

const noopScheduler = {
  setInterval: () => ({}),
  clearInterval: () => {},
}

const setup = async () => {
  resetSingletons()
  const adapter = new InMemoryStorageAdapter()
  AccountStorage.get(adapter)
  const transactions = TransactionStorage.get(adapter)
  const pendingStore = new InMemoryPendingTxStore()
  const node = new FakeNode()
  const lifecycle = TxLifecycleService.get({
    pendingTxStore: pendingStore,
    node,
    scheduler: noopScheduler,
  })
  const events: TxLifecycleEvent[] = []
  lifecycle.subscribe((e) => events.push(e))
  return { transactions, pendingStore, node, lifecycle, events }
}

/** A synth row that already carries the real hash, as it does after submit. */
const seedRow = async (lifecycle: TxLifecycleService) => {
  await lifecycle.recordPreSubmitSendRow(QUEUE_ID, "op-1", {
    token: sampleToken(),
    recipient: "0xrecipient",
  })
  await lifecycle.patchTxHashForQueue(QUEUE_ID, TX)
}

const rowFor = async (transactions: TransactionStorage) =>
  (await transactions.getTransactions()).find((tx) => tx.txHash === TX)

describe("TxLifecycleService — pending-only resolution", () => {
  beforeEach(() => resetSingletons())
  afterEach(() => resetSingletons())

  it("mined receipt → pending-resolved success, record removed, row SUCCESS", async () => {
    const { transactions, pendingStore, node, lifecycle, events } = await setup()
    await seedRow(lifecycle)
    await pendingStore.create(pendingRecord())
    node.set(TX, "mined")

    await lifecycle.runPollingTick()

    expect(events).toEqual([{ type: "pending-resolved", txHash: TX, outcome: "success" }])
    expect(await pendingStore.get(TX)).toBeUndefined()
    expect((await rowFor(transactions))?.detailedStatus).toBe(QueueStatus.SUCCESS)
  })

  it("reverted receipt → pending-resolved reverted, row FAILED", async () => {
    const { transactions, pendingStore, node, lifecycle, events } = await setup()
    await seedRow(lifecycle)
    await pendingStore.create(pendingRecord())
    node.set(TX, "reverted")

    await lifecycle.runPollingTick()

    expect(events).toEqual([{ type: "pending-resolved", txHash: TX, outcome: "reverted" }])
    expect(await pendingStore.get(TX)).toBeUndefined()
    expect((await rowFor(transactions))?.detailedStatus).toBe(QueueStatus.FAILED)
  })

  it("dropped receipt → pending-resolved dropped, row FAILED", async () => {
    const { transactions, pendingStore, node, lifecycle, events } = await setup()
    await seedRow(lifecycle)
    await pendingStore.create(pendingRecord())
    node.set(TX, "dropped")

    await lifecycle.runPollingTick()

    expect(events).toEqual([{ type: "pending-resolved", txHash: TX, outcome: "dropped" }])
    expect(await pendingStore.get(TX)).toBeUndefined()
    expect((await rowFor(transactions))?.detailedStatus).toBe(QueueStatus.FAILED)
  })

  it("expiry sweep on a record past expiresAtMs → pending-expired, row FAILED", async () => {
    const { transactions, pendingStore, lifecycle, events } = await setup()
    await seedRow(lifecycle)
    const past = Date.now() - 10 * 60_000
    await pendingStore.create(pendingRecord({ submittedAt: past, expiresAtMs: past }))

    await lifecycle.runExpirySweep()

    expect(events).toEqual([{ type: "pending-expired", txHash: TX }])
    expect(await pendingStore.listExpired()).toHaveLength(0)
    expect((await rowFor(transactions))?.detailedStatus).toBe(QueueStatus.FAILED)
  })

  it("expiry sweep keeps a mined outcome: an expired record whose tx mined resolves success", async () => {
    const { transactions, pendingStore, node, lifecycle, events } = await setup()
    await seedRow(lifecycle)
    const past = Date.now() - 10 * 60_000
    await pendingStore.create(pendingRecord({ submittedAt: past, expiresAtMs: past }))
    node.set(TX, "mined")

    await lifecycle.runExpirySweep()

    expect(events).toEqual([{ type: "pending-resolved", txHash: TX, outcome: "success" }])
    expect(await pendingStore.listExpired()).toHaveLength(0)
    expect((await rowFor(transactions))?.detailedStatus).toBe(QueueStatus.SUCCESS)
  })

  it("expiry sweep leaves an expired record in place when the receipt probe fails", async () => {
    const { transactions, pendingStore, node, lifecycle, events } = await setup()
    await seedRow(lifecycle)
    const past = Date.now() - 10 * 60_000
    await pendingStore.create(pendingRecord({ submittedAt: past, expiresAtMs: past }))
    node.set(TX, "throw")

    await lifecycle.runExpirySweep()

    expect(events).toEqual([])
    expect(await pendingStore.listExpired()).toHaveLength(1)
    expect((await rowFor(transactions))?.detailedStatus).toBe(QueueStatus.PENDING)
  })

  it("still-pending receipt leaves the record and row untouched with no event", async () => {
    const { transactions, pendingStore, node, lifecycle, events } = await setup()
    await seedRow(lifecycle)
    await pendingStore.create(pendingRecord())
    node.set(TX, "pending")

    await lifecycle.runPollingTick()

    expect(events).toEqual([])
    expect(await pendingStore.get(TX)).toBeDefined()
    expect((await rowFor(transactions))?.detailedStatus).toBe(QueueStatus.PENDING)
  })

  it("node throw leaves the record and row untouched; the next tick retries", async () => {
    const { transactions, pendingStore, node, lifecycle, events } = await setup()
    await seedRow(lifecycle)
    await pendingStore.create(pendingRecord())
    node.set(TX, "throw")

    await lifecycle.runPollingTick()

    expect(events).toEqual([])
    expect(await pendingStore.get(TX)).toBeDefined()
    expect((await rowFor(transactions))?.detailedStatus).toBe(QueueStatus.PENDING)

    node.set(TX, "mined")
    await lifecycle.runPollingTick()

    expect(node.calls).toBe(2)
    expect(events).toEqual([{ type: "pending-resolved", txHash: TX, outcome: "success" }])
    expect((await rowFor(transactions))?.detailedStatus).toBe(QueueStatus.SUCCESS)
  })

  it("a record persisted before attach is picked up by resumeAll and resolves on the next tick", async () => {
    resetSingletons()
    const adapter = new InMemoryStorageAdapter()
    AccountStorage.get(adapter)
    const transactions = TransactionStorage.get(adapter)
    const pendingStore = new InMemoryPendingTxStore()
    await pendingStore.create(pendingRecord())
    const node = new FakeNode()
    node.set(TX, "mined")

    const lifecycle = TxLifecycleService.get({
      pendingTxStore: pendingStore,
      node,
      scheduler: noopScheduler,
    })
    await seedRow(lifecycle)
    const events: TxLifecycleEvent[] = []
    lifecycle.subscribe((e) => events.push(e))

    await lifecycle.resumeAll()
    await lifecycle.runPollingTick()

    expect(events).toEqual([{ type: "pending-resolved", txHash: TX, outcome: "success" }])
    expect(await pendingStore.get(TX)).toBeUndefined()
    expect((await rowFor(transactions))?.detailedStatus).toBe(QueueStatus.SUCCESS)
  })

  it("after a restart resumeAll hydrates the encrypted store and the persisted record resolves", async () => {
    resetSingletons()
    const adapter = new InMemoryStorageAdapter()
    AccountStorage.get(adapter)
    const transactions = TransactionStorage.get(adapter)
    const encrypted = new EncryptedStorageAdapter(adapter, identityCrypto)

    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    const before = PendingTxStore.get(encrypted)
    await before.load()
    await before.create(pendingRecord())

    // Restart: a fresh store singleton over the same persisted storage, never loaded by the caller.
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
    const pendingStore = PendingTxStore.get(encrypted)
    const node = new FakeNode()
    node.set(TX, "mined")
    const lifecycle = TxLifecycleService.get({ pendingTxStore: pendingStore, node, scheduler: noopScheduler })
    await seedRow(lifecycle)
    const events: TxLifecycleEvent[] = []
    lifecycle.subscribe((e) => events.push(e))

    await lifecycle.resumeAll()
    await lifecycle.runPollingTick()

    expect(node.calls).toBe(1)
    expect(events).toEqual([{ type: "pending-resolved", txHash: TX, outcome: "success" }])
    expect(await pendingStore.get(TX)).toBeUndefined()
    expect((await rowFor(transactions))?.detailedStatus).toBe(QueueStatus.SUCCESS)
    resetSingleton(PendingTxStore as unknown as { instance: PendingTxStore | null })
  })
})
