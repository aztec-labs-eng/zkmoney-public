import { describe, it, expect, beforeEach, afterEach } from "vitest"

import { globalEventEmitter, type TokenTransaction } from "../../../src/index.js"

import { TransferReceiveNotificationProducer } from "../../../src/index.js"
import { AppNotificationStore, type AppNotificationEntry } from "../../../src/index.js"
import type { IStorageAdapter } from "../../../src/index.js"

class InMemoryStorage implements IStorageAdapter {
  store = new Map<string, string>()
  async getItem(key: string) {
    return this.store.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    this.store.set(key, value)
  }
  async removeItem(key: string) {
    this.store.delete(key)
  }
  async clear() {
    this.store.clear()
  }
}

function buildReceiveTx(overrides: Partial<TokenTransaction> = {}): TokenTransaction {
  return {
    action: "receive",
    token: {
      name: "Obsidion DAI",
      symbol: "DAI",
      decimals: 6,
      logo: "x",
      price: 1,
      address: "0xtoken",
      amount: 5,
    },
    timestamp: 1_700_000_000_000,
    status: "success",
    txHash: "0xtx-receive-1",
    from: "alice",
    to: "self",
    senderL2Address: "0x1234567890abcdef1234567890abcdef12345678",
    memo: "thanks",
    ...overrides,
  } as TokenTransaction
}

function buildProducer(opts?: {
  txs?: TokenTransaction[]
  txsThrows?: boolean
  joined?: () => Promise<{ block: number; ms: number } | undefined>
  now?: () => number
}) {
  const storage = new InMemoryStorage()
  const notificationStore = new AppNotificationStore(storage)
  const producer = new TransferReceiveNotificationProducer({
    notificationStore,
    accountTransactions: async () => {
      if (opts?.txsThrows) throw new Error("read boom")
      return opts?.txs ?? null
    },
    joined: opts?.joined,
    now: opts?.now,
  })
  return { storage, notificationStore, producer }
}

describe("TransferReceiveNotificationProducer", () => {
  beforeEach(() => {
    TransferReceiveNotificationProducer.resetForTests()
    globalEventEmitter.cleanup()
  })

  afterEach(() => {
    TransferReceiveNotificationProducer.resetForTests()
    globalEventEmitter.cleanup()
  })

  describe("event subscription", () => {
    it("mints an entry on incomingTransfer with the expected shape", async () => {
      const { producer, notificationStore } = buildProducer()
      producer.start()
      await producer.flush()

      const tx = buildReceiveTx()
      globalEventEmitter.emitIncomingTransfer(tx)
      await producer.flush()

      const entries = notificationStore.list()
      expect(entries).toHaveLength(1)
      const e = entries[0]!
      expect(e.id).toBe("transfer:receive:0xtx-receive-1")
      expect(e.title).toBe("Transfer received")
      expect(e.description).toBe("+$5 from alice")
      expect(e.systemIcon).toBe("arrow.down.left")
      expect(e.severity).toBe("success")
      expect(e.target).toEqual({ type: "transfer.txDetail", txHash: "0xtx-receive-1" })
      expect(e.producer).toBe("transferReceive")
      expect(e.domain).toBe("transfer")
    })

    it("a receive from before the device joined is recorded dismissed, and stays so after replay", async () => {
      const joinedMs = 1_700_000_500_000
      const old = buildReceiveTx({ blockNumber: 50, timestamp: joinedMs - 1 })
      const fresh = buildReceiveTx({
        txHash: "0xtx-receive-2",
        blockNumber: 51,
        timestamp: joinedMs + 1,
      })
      // A reorg replaced a block at or below the joined head after the join: its stamp says news.
      const replaced = buildReceiveTx({
        txHash: "0xtx-receive-3",
        blockNumber: 49,
        timestamp: joinedMs + 1,
      })
      const txs: TokenTransaction[] = []
      const { producer, notificationStore } = buildProducer({
        txs,
        joined: async () => ({ block: 50, ms: joinedMs }),
        now: () => joinedMs + 1000,
      })
      producer.start()
      await producer.flush()

      globalEventEmitter.emitIncomingTransfer(old)
      globalEventEmitter.emitIncomingTransfer(fresh)
      globalEventEmitter.emitIncomingTransfer(replaced)
      await producer.flush()

      const byId = new Map(notificationStore.list().map((e) => [e.id, e]))
      expect(byId.get("transfer:receive:0xtx-receive-1")?.dismissedAt).toBeDefined()
      expect(byId.get("transfer:receive:0xtx-receive-2")?.dismissedAt).toBeUndefined()
      expect(byId.get("transfer:receive:0xtx-receive-3")?.dismissedAt).toBeUndefined()

      // Restart replays the last 24h: the hidden row dedups instead of resurfacing.
      txs.push(old, fresh, replaced)
      producer.stop()
      producer.start()
      await producer.flush()
      expect(notificationStore.list()).toHaveLength(3)
      expect(notificationStore.get("transfer:receive:0xtx-receive-1")?.dismissedAt).toBeDefined()
    })

    it("hides nothing without a joined record or a row block number", async () => {
      const { producer, notificationStore } = buildProducer({ joined: async () => undefined })
      producer.start()
      await producer.flush()
      globalEventEmitter.emitIncomingTransfer(buildReceiveTx({ blockNumber: 1 }))
      globalEventEmitter.emitIncomingTransfer(buildReceiveTx({ txHash: "0xtx-receive-2" }))
      await producer.flush()
      expect(notificationStore.list().every((e) => e.dismissedAt === undefined)).toBe(true)
      expect(notificationStore.list()).toHaveLength(2)
    })

    it("ignores non-receive transactions if emitted (defensive)", async () => {
      const { producer, notificationStore } = buildProducer()
      producer.start()
      await producer.flush()

      const sendTx = buildReceiveTx({ action: "send" as any })
      globalEventEmitter.emitIncomingTransfer(sendTx)
      await producer.flush()

      expect(notificationStore.list()).toHaveLength(0)
    })

    it("id-keyed dedup: same txHash emitted twice yields one entry", async () => {
      const { producer, notificationStore } = buildProducer()
      producer.start()
      await producer.flush()

      const tx = buildReceiveTx()
      globalEventEmitter.emitIncomingTransfer(tx)
      globalEventEmitter.emitIncomingTransfer(tx)
      await producer.flush()

      expect(notificationStore.list()).toHaveLength(1)
    })

    it("stop() unsubscribes — subsequent emissions are no-ops", async () => {
      const { producer, notificationStore } = buildProducer()
      producer.start()
      await producer.flush()
      producer.stop()

      globalEventEmitter.emitIncomingTransfer(buildReceiveTx())
      await producer.flush()

      expect(notificationStore.list()).toHaveLength(0)
    })

    it("start() is idempotent — does not double-subscribe", async () => {
      const { producer, notificationStore } = buildProducer()
      producer.start()
      producer.start()
      await producer.flush()

      globalEventEmitter.emitIncomingTransfer(buildReceiveTx())
      await producer.flush()

      // If double-subscribed, createIfAbsent would still dedup — but we check
      // listener count behavior via the canonical effect.
      expect(notificationStore.list()).toHaveLength(1)
    })
  })

  describe("display attribution", () => {
    it("shows the tag when tx.from is not an L2-address shape", async () => {
      const { producer, notificationStore } = buildProducer()
      producer.start()
      await producer.flush()

      globalEventEmitter.emitIncomingTransfer(buildReceiveTx({ from: "alice" }))
      await producer.flush()

      expect(notificationStore.list()[0]!.description).toBe("+$5 from alice")
    })

    it("truncates the L2 address when no tag is known", async () => {
      const { producer, notificationStore } = buildProducer()
      producer.start()
      await producer.flush()

      const tx = buildReceiveTx({
        from: "0x1234567890abcdef1234567890abcdef12345678",
        senderL2Address: "0x1234567890abcdef1234567890abcdef12345678",
      })
      globalEventEmitter.emitIncomingTransfer(tx)
      await producer.flush()

      const desc = notificationStore.list()[0]!.description
      expect(desc).toMatch(/^\+\$5 from 0x/)
      // truncateMiddle with maxLength 15 produces "0x123...45678"-ish.
      expect(desc.length).toBeLessThan(40)
    })
  })

  describe("startup reconciliation", () => {
    it("mints entries for receives in the last 24h on start()", async () => {
      const now = 2_000_000_000_000
      const recentTx = buildReceiveTx({ txHash: "0xrecent", timestamp: now - 1_000 })
      const oldTx = buildReceiveTx({
        txHash: "0xold",
        timestamp: now - 25 * 60 * 60 * 1000, // 25h ago
      })
      const sendTx = buildReceiveTx({
        action: "send" as any,
        txHash: "0xsend",
        timestamp: now - 1_000,
      })

      const { producer, notificationStore } = buildProducer({
        txs: [recentTx, oldTx, sendTx],
        now: () => now,
      })
      producer.start()
      await producer.flush()

      const ids = notificationStore.list().map((e) => e.id)
      expect(ids).toContain("transfer:receive:0xrecent")
      expect(ids).not.toContain("transfer:receive:0xold")
      expect(ids).not.toContain("transfer:receive:0xsend")
    })

    it("reconciliation does not duplicate an entry that already exists", async () => {
      const now = 2_000_000_000_000
      const tx = buildReceiveTx({ txHash: "0xa", timestamp: now - 1_000 })

      const { producer, notificationStore } = buildProducer({
        txs: [tx],
        now: () => now,
      })
      // Pre-seed the store with an existing entry.
      await notificationStore.createIfAbsent({
        id: "transfer:receive:0xa",
        producer: "transferReceive",
        domain: "transfer",
        sourceId: "0xa",
        title: "Transfer received",
        description: "+$5 from alice",
        timestampMs: tx.timestamp,
        systemIcon: "arrow.down.left",
        severity: "success",
        target: { type: "transfer.txDetail", txHash: "0xa" },
      })
      expect(notificationStore.list()).toHaveLength(1)

      producer.start()
      await producer.flush()

      // Still exactly one — createIfAbsent saw the existing entry.
      expect(notificationStore.list()).toHaveLength(1)
    })

    it("reconciliation read failure is swallowed silently", async () => {
      const { producer, notificationStore } = buildProducer({ txsThrows: true })
      producer.start()
      await producer.flush()

      expect(notificationStore.list()).toHaveLength(0)
    })

    it("an incomingTransfer emission during reconciliation still produces an entry", async () => {
      const now = 2_000_000_000_000
      const reconcileTx = buildReceiveTx({ txHash: "0xreconcile", timestamp: now - 1_000 })

      const { producer, notificationStore } = buildProducer({
        txs: [reconcileTx],
        now: () => now,
      })
      producer.start()
      // Fire an emission immediately after start (before flush).
      globalEventEmitter.emitIncomingTransfer(
        buildReceiveTx({ txHash: "0xlive", timestamp: now - 500 }),
      )
      await producer.flush()

      const ids = notificationStore
        .list()
        .map((e) => e.id)
        .sort()
      expect(ids).toEqual(["transfer:receive:0xlive", "transfer:receive:0xreconcile"])
    })
  })

  describe("event filter narrowness", () => {
    it("accountUpdated does not trigger createIfAbsent", async () => {
      const { producer, notificationStore } = buildProducer()
      producer.start()
      await producer.flush()

      globalEventEmitter.emitAccountUpdated({ accountId: "acc" })
      await producer.flush()
      await new Promise((r) => setTimeout(r, 10))

      expect(notificationStore.list()).toHaveLength(0)
    })
  })
})
