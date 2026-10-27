import { describe, it, expect, beforeEach, afterEach } from "vitest"

import { globalEventEmitter, type PaylinkTransaction } from "../../../src/index.js"
import type { IStorageAdapter } from "../../../src/index.js"

import { PaylinkClaimedNotificationProducer } from "../../../src/index.js"
import { AppNotificationStore, type AppNotificationEntry } from "../../../src/index.js"

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

const NOW = 1_700_000_100_000

function paylinkRow(overrides: Partial<PaylinkTransaction> = {}): PaylinkTransaction {
  return {
    action: "Pay To Email",
    emailPaymentAction: "Pay To Email",
    flavor: "email",
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
    txHash: "0xpay-1",
    to: "alice@x.com",
    paylink: "https://x/#frag",
    fallbackSecret: "0xtag",
    fromClaimable: 1000,
    untilClaimable: 2000,
    isClaimed: true,
    ...overrides,
  } as PaylinkTransaction
}

function build(opts: { txs?: PaylinkTransaction[]; throws?: boolean } = {}) {
  const store = new AppNotificationStore(new InMemoryStorage())
  const producer = new PaylinkClaimedNotificationProducer({
    notificationStore: store,
    accountTransactions: async () => {
      if (opts.throws) throw new Error("read boom")
      return opts.txs ?? null
    },
    now: () => NOW,
  })
  return { store, producer }
}

afterEach(() => {
  PaylinkClaimedNotificationProducer.resetForTests()
})

describe("PaylinkClaimedNotificationProducer", () => {
  it("mints one notification on a paylinkClaimed event (amount + recipient copy)", async () => {
    const { store, producer } = build({ txs: [paylinkRow({ isClaimed: false })] })
    producer.start()
    await producer.flush()
    globalEventEmitter.emitPaylinkClaimed({ txHash: "0xpay-1" })
    await producer.flush()
    producer.stop()

    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe("Paylink claimed")
    expect(list[0].description).toBe("Your $5 paylink to alice@x.com was claimed")
    expect(list[0].target).toEqual({ type: "paylink.claimed", txHash: "0xpay-1" })
  })

  it("omits the recipient for a direct paylink", async () => {
    const { store, producer } = build({
      txs: [paylinkRow({ isClaimed: false, flavor: "direct", to: undefined })],
    })
    producer.start()
    await producer.flush()
    globalEventEmitter.emitPaylinkClaimed({ txHash: "0xpay-1" })
    await producer.flush()
    producer.stop()
    expect(store.list()[0].description).toBe("Your $5 paylink was claimed")
  })

  it("dedups repeated events for the same paylink (fire-once)", async () => {
    const { store, producer } = build({ txs: [paylinkRow({ isClaimed: false })] })
    producer.start()
    await producer.flush()
    globalEventEmitter.emitPaylinkClaimed({ txHash: "0xpay-1" })
    globalEventEmitter.emitPaylinkClaimed({ txHash: "0xpay-1" })
    await producer.flush()
    producer.stop()
    expect(store.list()).toHaveLength(1)
  })

  it("does nothing for an event whose row is not found", async () => {
    const { store, producer } = build({ txs: [] })
    producer.start()
    await producer.flush()
    globalEventEmitter.emitPaylinkClaimed({ txHash: "0xmissing" })
    await producer.flush()
    producer.stop()
    expect(store.list()).toHaveLength(0)
  })

  it("startup reconciliation surfaces a recently-claimed row", async () => {
    const { store, producer } = build({ txs: [paylinkRow({ isClaimed: true })] })
    producer.start()
    await producer.flush()
    producer.stop()
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].target).toEqual({ type: "paylink.claimed", txHash: "0xpay-1" })
  })

  it("mints one corrective notice when a demote invalidates a sent claimed notification", async () => {
    const { store, producer } = build({ txs: [paylinkRow({ isClaimed: false })] })
    producer.start()
    await producer.flush()
    globalEventEmitter.emitPaylinkClaimed({ txHash: "0xpay-1" })
    await producer.flush()
    globalEventEmitter.emitPaylinkClaimDemoted({ txHash: "0xpay-1" })
    globalEventEmitter.emitPaylinkClaimDemoted({ txHash: "0xpay-1" })
    await producer.flush()
    producer.stop()

    const list = store.list()
    expect(list).toHaveLength(2)
    const corrective = list.find((n) => n.id === "paylink:claim-reversed:0xpay-1")
    expect(corrective?.title).toBe("Paylink claim reverted")
    expect(corrective?.target).toEqual({ type: "paylink.claimed", txHash: "0xpay-1" })
  })

  it("a demote with no prior claimed notification stays silent", async () => {
    const { store, producer } = build({ txs: [] })
    producer.start()
    await producer.flush()
    globalEventEmitter.emitPaylinkClaimDemoted({ txHash: "0xpay-1" })
    await producer.flush()
    producer.stop()
    expect(store.list()).toHaveLength(0)
  })

  it("start() is idempotent (single subscription)", async () => {
    const { store, producer } = build({ txs: [paylinkRow({ isClaimed: false })] })
    producer.start()
    producer.start()
    await producer.flush()
    globalEventEmitter.emitPaylinkClaimed({ txHash: "0xpay-1" })
    await producer.flush()
    producer.stop()
    expect(store.list()).toHaveLength(1)
  })
})
