import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ActivityItem,
  BridgeActivityItem,
  SIPADepositRecord,
  WithdrawalRecord,
} from "../../../src/index.js"
import {
  AppNotificationStore,
  BridgeNotificationProducer,
  NotificationProducerRegistry,
} from "../../../src/index.js"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { resetSingleton } from "../../__test-helpers__/resetSingleton"
import { ActivityFeed } from "../../../src/core/services/bridge/BridgeActivityFeed"
import { WithdrawalStorage } from "../../../src/core/services/bridge/WithdrawalStorage"
import { SIPADepositStore } from "../../../src/core/services/deposits/SIPADepositStore"

const SIPA_ADDRESS = "0x00000000000000000000000000000000000000Aa"
const WALLET_ADDRESS = "0x0000000000000000000000000000000000000002"
const WITHDRAWAL_RECIPIENT = "0x0000000000000000000000000000000000000003"
const L2_HASH = "0x0000000000000000000000000000000000000000000000000000000000000004"

class FakeBridgeFeed {
  private listeners = new Set<(items: ActivityItem[]) => void>()
  private items: ActivityItem[] = []

  list(): ActivityItem[] {
    return this.items
  }

  onChanged(listener: (items: ActivityItem[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(items: ActivityItem[]): void {
    this.items = items
    for (const listener of this.listeners) listener(items)
  }

  listenerCount(): number {
    return this.listeners.size
  }
}

function sipaDeposit(overrides: Partial<SIPADepositRecord> = {}): BridgeActivityItem {
  return {
    kind: "bridge.sipaDeposit",
    record: {
      sipaAddress: SIPA_ADDRESS,
      recipientL2Address: "0x" + "11".repeat(32),
      messageSecret: "0x" + "22".repeat(32),
      recipientHash: "0x" + "33".repeat(32),
      recoveryAddress: "0x0000000000000000000000000000000000000009",
      inboxIndex: 7,
      l1ChainId: 11155111,
      amount: "10",
      tokenSymbol: "DAI",
      walletAddress: WALLET_ADDRESS,
      phase: "claimed",
      startTime: 900,
      endTime: 1_100,
      ...overrides,
    } as SIPADepositRecord,
  }
}

function withdrawal(overrides: Partial<WithdrawalRecord> = {}): BridgeActivityItem {
  return {
    kind: "bridge.withdrawal",
    record: {
      localId: "withdraw-local-id",
      l2TxHash: L2_HASH,
      recipient: WITHDRAWAL_RECIPIENT,
      recipientProvenance: "saved-recipient",
      amount: "4",
      tokenSymbol: "DAI",
      phase: "failed",
      startTime: 900,
      endTime: 1_100,
      ...overrides,
    } as WithdrawalRecord,
  }
}

describe("BridgeNotificationProducer (SIPA — the only bridge source)", () => {
  let feed: FakeBridgeFeed
  let notifications: AppNotificationStore
  let producer: BridgeNotificationProducer

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    feed = new FakeBridgeFeed()
    notifications = new AppNotificationStore(new InMemoryStorageAdapter())
    producer = new BridgeNotificationProducer(feed, notifications, { liveRows: true })
  })

  afterEach(() => {
    producer.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("creates one unread success notification for a fresh claimed deposit", async () => {
    producer.start()

    feed.emit([sipaDeposit({ phase: "claimed" })])
    await producer.flush()

    expect(notifications.list()).toEqual([
      expect.objectContaining({
        id: `bridge:sipaDeposit:${SIPA_ADDRESS.toLowerCase()}:7:done`,
        producer: "bridge",
        domain: "bridge",
        title: "Deposit complete",
        read: false,
        target: {
          type: "bridge.txDetail",
          bridgeKind: "deposit",
          sourceId: SIPA_ADDRESS.toLowerCase(),
        },
      }),
    ])
  })

  it("rounds a full-precision sweep amount to cents in the description", async () => {
    producer.start()

    feed.emit([sipaDeposit({ amount: "99.732114451234567891", tokenSymbol: "USDC" })])
    await producer.flush()

    expect(notifications.list()).toEqual([
      expect.objectContaining({ description: "99.73 USDC arrived" }),
    ])
  })

  it("creates a recovered notification with its own title", async () => {
    producer.start()

    // A recovery returns the whole balance, so the push names the gross, not a net no fee came off.
    feed.emit([
      sipaDeposit({
        phase: "recovered",
        fee: "250000000000000000",
        fpcFundingCut: "250000000000000000",
      }),
    ])
    await producer.flush()

    expect(notifications.list()).toEqual([
      expect.objectContaining({
        id: `bridge:sipaDeposit:${SIPA_ADDRESS.toLowerCase()}:7:done`,
        title: "Deposit recovered",
        description: "10 DAI returned to your wallet",
        severity: "success",
      }),
    ])
  })

  it("creates one unread failure notification for a fresh failed deposit", async () => {
    producer.start()

    feed.emit([sipaDeposit({ phase: "failed" })])
    await producer.flush()

    expect(notifications.list()).toEqual([
      expect.objectContaining({
        id: `bridge:sipaDeposit:${SIPA_ADDRESS.toLowerCase()}:7:failed`,
        title: "Deposit failed",
        severity: "error",
      }),
    ])
  })

  it("names the withdrawal's burn and what a deposit credits", async () => {
    producer.start()

    feed.emit([
      withdrawal({
        phase: "done",
        rawAmount: "4000000000000000000",
        relayerTip: "100000000000000000",
        fpcFundingCut: "250000000000000000",
      }),
      sipaDeposit({ fee: "350000000000000000", fpcFundingCut: "250000000000000000" }),
    ])
    await producer.flush()

    expect(notifications.list().map((n) => n.description)).toEqual(
      expect.arrayContaining(["4 DAI sent to L1", "9.65 DAI arrived"]),
    )
  })

  it("creates a success notification for a done withdrawal (sent to L1)", async () => {
    producer.start()

    feed.emit([withdrawal({ phase: "done" })])
    await producer.flush()

    expect(notifications.list()).toEqual([
      expect.objectContaining({
        id: "bridge:withdrawal:withdraw-local-id:done",
        title: "Withdrawal complete",
        description: "4 DAI sent to L1",
        severity: "success",
        target: {
          type: "bridge.txDetail",
          bridgeKind: "withdrawal",
          sourceId: "withdraw-local-id",
          l2TxHash: L2_HASH,
        },
      }),
    ])
  })

  it("creates a failure notification for a pre-mine failed withdrawal", async () => {
    producer.start()

    feed.emit([withdrawal({ phase: "failed" })])
    await producer.flush()

    expect(notifications.list()).toEqual([
      expect.objectContaining({
        id: "bridge:withdrawal:withdraw-local-id:failed",
        title: "Withdrawal failed",
        severity: "error",
      }),
    ])
  })

  it("fires no TERMINAL notification for a post-mine non-terminal (delayed) withdrawal", async () => {
    producer.start()

    // A `delayed` presentation is DERIVED from a non-terminal phase, so the producer never sees a
    // terminal phase — a false "Withdrawal failed" push on safe on-chain funds is a worse trust hit
    // than the live row it gets instead.
    feed.emit([withdrawal({ phase: "awaiting_proven", endTime: undefined })])
    await producer.flush()

    expect(notifications.list()).toMatchObject([
      {
        title: "Withdrawal in progress",
        description: "4 DAI · Releasing to Ethereum",
        pending: true,
      },
    ])
  })

  // The front shows a burn that has not mined as its own operation, with whether the tab may close.
  it("mints no live row for a withdrawal before its burn mines", async () => {
    producer.start()
    feed.emit([withdrawal({ phase: "submitting", endTime: undefined })])
    await producer.flush()
    expect(notifications.list()).toEqual([])
  })

  // A migration's exit pays its own new-deployment SIPA: one move, reported once, as a move.
  describe("a migration", () => {
    const exit = (phase: WithdrawalRecord["phase"]) =>
      withdrawal({ phase, intent: "migration", recipient: SIPA_ADDRESS, endTime: 1_100 })

    it("shows one live move while the exit releases", async () => {
      producer.start()
      feed.emit([exit("awaiting_proven")])
      await producer.flush()
      expect(notifications.list()).toMatchObject([
        { title: "Moving funds", description: "$4 · Leaving old network", pending: true },
      ])
    })

    it("shows no live row for an arrival whose burn dropped before it was funded", async () => {
      producer.start()
      const unfunded = sipaDeposit({
        phase: "broadcast",
        amount: "0",
        inboxIndex: undefined,
        endTime: undefined,
      })
      feed.emit([exit("failed"), unfunded])
      await producer.flush()
      expect(notifications.list().filter((e) => e.pending)).toEqual([])
    })

    it("reports the arrival as the move's end, not the exit as a withdrawal", async () => {
      producer.start()
      feed.emit([exit("done"), sipaDeposit({ phase: "claimed", endTime: 1_200 })])
      await producer.flush()
      const titles = notifications.list().map((e) => e.title)
      expect(titles).toContain("Migration complete")
      expect(notifications.list().map((e) => e.description)).toContain("$10 arrived")
      expect(titles).not.toContain("Withdrawal complete")
      expect(titles).not.toContain("Deposit complete")
    })

    it("walks the real feed from leaving to arriving to complete, one live row at a time", async () => {
      resetSingleton(ActivityFeed as unknown as { instance: ActivityFeed | null })
      resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
      resetSingleton(WithdrawalStorage as unknown as { instance: WithdrawalStorage | null })
      const sipa = SIPADepositStore.get(new InMemoryStorageAdapter())
      const withdrawals = WithdrawalStorage.get(new InMemoryStorageAdapter())
      await Promise.all([sipa.load(), withdrawals.load()])
      const real = new BridgeNotificationProducer(ActivityFeed.get(sipa, withdrawals), notifications, {
        liveRows: true,
      })
      const pending = () =>
        notifications
          .list()
          .filter((e) => e.pending && !e.dismissedAt)
          .map((e) => e.description)
      const { record: deposit } = sipaDeposit({
        phase: "resolved",
        amount: "0",
        inboxIndex: undefined,
        endTime: undefined,
      })
      const { phase: _, ...fallback } = deposit
      real.start()
      try {
        await withdrawals.create(exit("awaiting_proven").record as WithdrawalRecord)
        await sipa.upsert(deposit.sipaAddress, { phase: "resolved" }, fallback)
        await real.flush()
        expect(pending()).toEqual(["$4 · Leaving old network"])

        // Published and discovered, still unfunded: the exit's row alone says where the funds are.
        await sipa.upsert(deposit.sipaAddress, { phase: "broadcast", amount: "0" }, fallback)
        await real.flush()
        expect(pending()).toEqual(["$4 · Leaving old network"])

        await withdrawals.patch("withdraw-local-id", { phase: "done", endTime: 1_100 })
        await sipa.upsert(deposit.sipaAddress, { phase: "sweeping", amount: "4" }, fallback)
        await real.flush()
        expect(pending()).toEqual(["$4 · Arriving on new network"])

        await sipa.upsert(deposit.sipaAddress, { phase: "claimed", endTime: 1_200 }, fallback)
        await real.flush()
        expect(pending()).toEqual([])
        expect(notifications.list().map((e) => e.title)).toContain("Migration complete")
      } finally {
        real.stop()
      }
    })
  })

  it("tracks an in-flight deposit live and retires the row once it settles", async () => {
    producer.start()

    feed.emit([sipaDeposit({ phase: "broadcast", endTime: undefined })])
    await producer.flush()
    expect(notifications.list()).toMatchObject([
      { title: "Deposit in progress", description: "10 DAI · Deposit detected", pending: true },
    ])

    feed.emit([sipaDeposit({ phase: "sweeping", endTime: undefined })])
    await producer.flush()
    expect(notifications.list()).toMatchObject([
      { description: "10 DAI · Moving into the pool", pending: true },
    ])

    feed.emit([sipaDeposit({ phase: "claimed", endTime: Date.now() })])
    await producer.flush()
    // The live row is dismissed (hidden, not deleted) as the settled one takes its place.
    expect(notifications.list().filter((e) => !e.dismissedAt)).toMatchObject([
      { title: "Deposit complete" },
    ])
  })

  it("names an in-flight deposit's net once the fee is read, its gross until then", async () => {
    producer.start()

    feed.emit([
      sipaDeposit({
        phase: "sweeping",
        endTime: undefined,
        fee: "350000000000000000",
        fpcFundingCut: "250000000000000000",
      }),
    ])
    await producer.flush()
    expect(notifications.list()).toMatchObject([
      { description: "9.65 DAI · Moving into the pool", pending: true },
    ])

    feed.emit([sipaDeposit({ phase: "sweeping", endTime: undefined, fee: undefined })])
    await producer.flush()
    expect(notifications.list()).toMatchObject([
      { description: "10 DAI · Moving into the pool", pending: true },
    ])
  })

  it("retires the live row when its record disappears from a loaded feed", async () => {
    producer.start()

    feed.emit([
      sipaDeposit({ phase: "claimed" }),
      withdrawal({ phase: "l2_mined", endTime: undefined }),
    ])
    await producer.flush()
    expect(notifications.list().filter((e) => e.pending && !e.dismissedAt)).toHaveLength(1)

    feed.emit([sipaDeposit({ phase: "claimed" })])
    await producer.flush()
    expect(notifications.list().filter((e) => e.pending && !e.dismissedAt)).toEqual([])
  })

  it("retires the last live row when a previously populated feed becomes empty", async () => {
    producer.start()
    feed.emit([withdrawal({ phase: "l2_mined", endTime: undefined })])
    await producer.flush()

    feed.emit([])
    await producer.flush()

    expect(notifications.list().filter((e) => !e.dismissedAt)).toHaveLength(0)
  })

  it("keeps restored live rows while the initial feed is empty", async () => {
    producer.start()
    feed.emit([withdrawal({ phase: "l2_mined", endTime: undefined })])
    await producer.flush()
    producer.stop()
    feed.emit([])
    const reloaded = new BridgeNotificationProducer(feed, notifications, { liveRows: true })
    reloaded.start()
    await reloaded.flush()
    expect(notifications.list().filter((e) => !e.dismissedAt)).toHaveLength(1)
    reloaded.stop()
  })

  it("retires a live row left behind by an earlier page load", async () => {
    producer.start()
    feed.emit([withdrawal({ phase: "l2_mined", endTime: undefined })])
    await producer.flush()
    producer.stop()

    // Same store, new producer: the survivor set is read off the store, not remembered in memory.
    const reloaded = new BridgeNotificationProducer(feed, notifications, { liveRows: true })
    reloaded.start()
    feed.emit([withdrawal({ phase: "done" })])
    await reloaded.flush()
    reloaded.stop()

    expect(notifications.list().filter((e) => e.pending && !e.dismissedAt)).toEqual([])
  })

  it("mints no live row unless the client opts in", async () => {
    const optedOut = new BridgeNotificationProducer(feed, notifications)
    optedOut.start()

    feed.emit([withdrawal({ phase: "awaiting_proven", endTime: undefined })])
    await optedOut.flush()

    expect(notifications.list()).toEqual([])
    optedOut.stop()
  })

  it("ignores phases with nothing in flight (unfunded, parked)", async () => {
    producer.start()

    feed.emit([sipaDeposit({ phase: "resolved", endTime: undefined })])
    await producer.flush()
    expect(notifications.list()).toEqual([])

    feed.emit([sipaDeposit({ phase: "recoverable", endTime: undefined })])
    await producer.flush()
    expect(notifications.list()).toEqual([])
  })

  it("warns and skips terminal records without endTime", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    producer.start()

    feed.emit([sipaDeposit({ phase: "claimed", endTime: undefined })])
    await producer.flush()

    expect(notifications.list()).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      "[BridgeNotificationProducer] terminal bridge record missing endTime:",
      expect.objectContaining({ kind: "bridge.sipaDeposit", phase: "done" }),
    )
  })

  it("does not create notifications for terminal records older than the startup baseline", async () => {
    producer.start()

    feed.emit([sipaDeposit({ phase: "claimed", endTime: 999 })])
    await producer.flush()

    expect(notifications.list()).toEqual([])
  })

  it("dedupes repeated feed snapshots by stable source event id", async () => {
    producer.start()
    const item = sipaDeposit({ phase: "claimed" })

    feed.emit([item])
    feed.emit([item])
    await producer.flush()

    expect(notifications.list()).toHaveLength(1)
  })

  it("notifies per inbox index so a re-used SIPA notifies once per completed deposit", async () => {
    producer.start()

    feed.emit([
      sipaDeposit({ phase: "claimed", inboxIndex: 7 }),
      sipaDeposit({ phase: "claimed", inboxIndex: 9 }),
    ])
    await producer.flush()

    expect(
      notifications
        .list()
        .map((n) => n.id)
        .sort(),
    ).toEqual([
      `bridge:sipaDeposit:${SIPA_ADDRESS.toLowerCase()}:7:done`,
      `bridge:sipaDeposit:${SIPA_ADDRESS.toLowerCase()}:9:done`,
    ])
  })

  it("starts idempotently", async () => {
    producer.start()
    producer.start()

    expect(feed.listenerCount()).toBe(1)

    feed.emit([sipaDeposit({ phase: "claimed" })])
    await producer.flush()

    expect(notifications.list()).toHaveLength(1)
  })

  it("can stop and restart without leaking feed listeners", async () => {
    producer.start()
    producer.stop()
    producer.start()

    expect(feed.listenerCount()).toBe(1)

    feed.emit([sipaDeposit({ phase: "claimed" })])
    await producer.flush()

    expect(notifications.list()).toHaveLength(1)
  })

  it("runs through the producer registry", async () => {
    const registry = new NotificationProducerRegistry()
    registry.register(producer)
    registry.start()

    feed.emit([sipaDeposit({ phase: "claimed" })])
    await registry.flush()

    expect(notifications.list()[0]).toEqual(
      expect.objectContaining({
        id: `bridge:sipaDeposit:${SIPA_ADDRESS.toLowerCase()}:7:done`,
      }),
    )

    registry.stop()
    expect(feed.listenerCount()).toBe(0)
  })
})
