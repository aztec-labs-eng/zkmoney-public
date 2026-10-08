import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ActivityItem,
  BridgeActivityItem,
  SIPADepositRecord,
  SipaProcessingState,
  WithdrawalRecord,
} from "../../../src/index.js"
import {
  AppNotificationStore,
  BridgeNotificationProducer,
  NotificationProducerRegistry,
  reorgNotificationInput,
  STUCK_SWEEP_MS,
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
  let storage: InMemoryStorageAdapter
  let notifications: AppNotificationStore
  let producer: BridgeNotificationProducer

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    feed = new FakeBridgeFeed()
    storage = new InMemoryStorageAdapter()
    notifications = new AppNotificationStore(storage)
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

  it("names a full-precision sweep amount in dollars, at cents", async () => {
    producer.start()

    feed.emit([sipaDeposit({ amount: "99.732114451234567891", tokenSymbol: "USDC" })])
    await producer.flush()

    expect(notifications.list()).toEqual([expect.objectContaining({ description: "$99.73 arrived" })])
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
        description: "$10 returned to your wallet",
        severity: "success",
      }),
    ])
  })

  describe("ETH sent to a deposit address", () => {
    const ETH = {
      tokenAddress: "0x0000000000000000000000000000000000000000",
      tokenSymbol: "ETH",
      tokenDecimals: 18,
    } as const

    it.each([
      ["0.05", "0.05 ETH"],
      ["0.123456789123456789", "0.12346 ETH"],
      // One wei: dollars would round it to "$0.00".
      ["0.000000000000000001", "<0.00001 ETH"],
    ])("names a recovery of %s in ETH", async (amount, figure) => {
      producer.start()
      feed.emit([sipaDeposit({ ...ETH, phase: "recovered", amount })])
      await producer.flush()

      const description = `${figure} returned to your wallet`
      expect(notifications.list()).toEqual([
        expect.objectContaining({ title: "Deposit recovered", description }),
      ])
      const reloaded = new AppNotificationStore(storage)
      await reloaded.load()
      expect(reloaded.list()).toEqual([expect.objectContaining({ description })])
    })
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
      expect.arrayContaining(["$4 sent to Ethereum", "$9.65 arrived"]),
    )
  })

  it("creates a success notification for a done withdrawal (sent to Ethereum)", async () => {
    producer.start()

    feed.emit([withdrawal({ phase: "done" })])
    await producer.flush()

    expect(notifications.list()).toEqual([
      expect.objectContaining({
        id: "bridge:withdrawal:withdraw-local-id:done",
        title: "Withdrawal complete",
        description: "$4 sent to Ethereum",
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
        description: "$4 · Releasing to Ethereum",
        pending: true,
      },
    ])
  })

  // The front shows a burn that has not mined as its own operation, with whether the tab may close.
  it("mints no live row for a rebuilt withdrawal until the tracker sees its L1 release", async () => {
    producer.start()
    feed.emit([withdrawal({ phase: "l2_mined", rebuilt: true, endTime: undefined })])
    await producer.flush()
    expect(notifications.list()).toEqual([])
    feed.emit([withdrawal({ phase: "finalizing_l1", rebuilt: true, endTime: undefined })])
    await producer.flush()
    expect(notifications.list()).toEqual([])
    feed.emit([withdrawal({ phase: "swapping", rebuilt: true, endTime: undefined })])
    await producer.flush()
    expect(notifications.list().map((e) => e.pending)).toEqual([true])
  })

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
      const real = new BridgeNotificationProducer(
        ActivityFeed.get(sipa, withdrawals),
        notifications,
        {
          liveRows: true,
        },
      )
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

  describe("a fresh-address withdrawal", () => {
    const GROUP_ID = `0x${"c3".repeat(16)}` as const
    const leg = (
      groupLeg: "gas" | "funds",
      phase: WithdrawalRecord["phase"],
      overrides: Partial<WithdrawalRecord> = {},
    ) =>
      withdrawal({
        localId: `wdraw_${groupLeg}`,
        groupId: GROUP_ID,
        groupLeg,
        amount: groupLeg === "gas" ? "2.5" : "5",
        phase,
        endTime: undefined,
        ...overrides,
      })

    it("shows one live row for the group, none per leg, until the pair settles", async () => {
      producer.start()
      feed.emit([leg("gas", "submitting")])
      await producer.flush()
      expect(notifications.list()).toEqual([])

      feed.emit([leg("gas", "awaiting_proven"), leg("funds", "submitting")])
      await producer.flush()
      expect(notifications.list()).toEqual([
        expect.objectContaining({
          id: `bridge:withdrawal-group:${GROUP_ID}:inflight`,
          description: "$7.50 · Releasing to Ethereum",
          pending: true,
          target: expect.objectContaining({ sourceId: "wdraw_funds" }),
        }),
      ])

      feed.emit([leg("gas", "swapping"), leg("funds", "l2_mined")])
      await producer.flush()
      expect(notifications.list()).toMatchObject([
        { description: "$7.50 · Releasing to Ethereum" },
      ])

      feed.emit([leg("gas", "done", { endTime: 1_200 }), leg("funds", "done", { endTime: 1_100 })])
      await producer.flush()
      expect(notifications.list().filter((e) => !e.dismissedAt)).toEqual([
        expect.objectContaining({
          id: `bridge:withdrawal-group:${GROUP_ID}:done`,
          description: "$7.50 sent to Ethereum",
          timestampMs: 1_200,
          target: expect.objectContaining({ sourceId: "wdraw_funds" }),
        }),
      ])
    })

    it("reports failed by the failed leg once the other leg has settled", async () => {
      const failed = leg("funds", "failed", { endTime: 1_150, error: "Burn rejected" })
      producer.start()
      feed.emit([leg("gas", "l2_mined"), failed])
      await producer.flush()
      expect(notifications.list().filter((e) => !e.pending)).toEqual([])

      feed.emit([leg("gas", "done", { endTime: 1_100 }), failed])
      await producer.flush()
      expect(notifications.list().filter((e) => !e.dismissedAt)).toEqual([
        expect.objectContaining({
          id: `bridge:withdrawal-group:${GROUP_ID}:failed:wdraw_funds`,
          description: "Burn rejected",
          target: expect.objectContaining({ sourceId: "wdraw_funds" }),
        }),
      ])
    })

    it("reports a recovered group by what came back", async () => {
      producer.start()
      feed.emit([
        leg("gas", "recovered", { endTime: 1_100 }),
        leg("funds", "done", { endTime: 1_200 }),
      ])
      await producer.flush()
      expect(notifications.list()).toMatchObject([
        {
          id: `bridge:withdrawal-group:${GROUP_ID}:done`,
          title: "Withdrawal recovered",
          description: "$2.50 returned to your wallet",
        },
      ])
    })

    it("reports a recovered gas leg that no funds leg followed", async () => {
      producer.start()
      feed.emit([leg("gas", "recovered", { endTime: 1_100 })])
      await producer.flush()
      expect(notifications.list()).toMatchObject([
        { title: "Withdrawal recovered", description: "$2.50 returned to your wallet" },
      ])
    })

    it("gates the group's report on the startup baseline", async () => {
      producer.start()
      feed.emit([leg("gas", "done", { endTime: 900 }), leg("funds", "done", { endTime: 950 })])
      await producer.flush()
      expect(notifications.list()).toEqual([])
    })

    it("loses the failed entry of a funds leg once the funds are sent again", async () => {
      const failedId = `bridge:withdrawal-group:${GROUP_ID}:failed:wdraw_funds`
      const gas = leg("gas", "done", { startTime: 1_000, endTime: 1_100 })
      const first = leg("funds", "failed", { startTime: 1_000, endTime: 1_150 })
      const again = (phase: WithdrawalRecord["phase"], endTime?: number) =>
        leg("funds", phase, { localId: "wdraw_funds_2", startTime: 2_000, endTime })
      producer.start()
      feed.emit([gas, first])
      await producer.flush()
      expect(notifications.list().filter((e) => !e.dismissedAt)).toMatchObject([
        { id: failedId, title: "Withdrawal failed" },
      ])

      feed.emit([gas, first, again("l2_mined")])
      await producer.flush()
      expect(notifications.get(failedId)).toBeNull()
      expect(notifications.list().filter((e) => !e.dismissedAt)).toMatchObject([
        { id: `bridge:withdrawal-group:${GROUP_ID}:inflight`, pending: true },
      ])

      feed.emit([gas, first, again("done", 2_500)])
      await producer.flush()
      expect(notifications.list().filter((e) => !e.dismissedAt)).toMatchObject([
        { id: `bridge:withdrawal-group:${GROUP_ID}:done`, title: "Withdrawal complete" },
      ])
    })

    it("loses its failed entry and shows its live row once the failed leg is live again", async () => {
      const failedId = `bridge:withdrawal-group:${GROUP_ID}:failed:wdraw_gas`
      const funds = leg("funds", "done", { endTime: 1_200 })
      producer.start()
      feed.emit([leg("gas", "l2_mined"), leg("funds", "l2_mined")])
      await producer.flush()
      feed.emit([leg("gas", "failed", { endTime: 1_100 }), funds])
      await producer.flush()
      expect(notifications.list().filter((e) => !e.dismissedAt)).toMatchObject([
        { id: failedId, title: "Withdrawal failed" },
      ])

      feed.emit([leg("gas", "l2_mined"), funds])
      await producer.flush()
      expect(notifications.get(failedId)).toBeNull()
      expect(notifications.list().filter((e) => !e.dismissedAt)).toMatchObject([
        {
          id: `bridge:withdrawal-group:${GROUP_ID}:inflight`,
          title: "Withdrawal in progress",
          pending: true,
        },
      ])

      feed.emit([leg("gas", "done", { endTime: 1_300 }), funds])
      await producer.flush()
      expect(notifications.list().filter((e) => !e.dismissedAt)).toMatchObject([
        { id: `bridge:withdrawal-group:${GROUP_ID}:done`, title: "Withdrawal complete" },
      ])
    })

    it("touches no entry but the recovered leg's", async () => {
      const remaining = `bridge:withdrawal-group:${GROUP_ID}:remaining`
      const kept = [
        remaining,
        "bridge:withdrawal:other-done:done",
        "bridge:withdrawal:other:failed",
      ]
      const others = [
        withdrawal({ localId: "other", phase: "failed" }),
        withdrawal({ localId: "other-done", phase: "done" }),
      ]
      producer.start()
      feed.emit([leg("gas", "failed", { endTime: 1_100 }), ...others])
      await producer.flush()
      // The wallet's own entry for a funds leg that did not go out.
      await notifications.createIfAbsent({
        id: remaining,
        sourceId: remaining,
        producer: "bridge",
        domain: "bridge",
        title: "Funds not sent",
        description: "Send the funds to finish",
        timestampMs: 1_100,
        systemIcon: "exclamationmark.triangle.fill",
        severity: "error",
        target: { type: "bridge.txDetail", bridgeKind: "withdrawal", sourceId: "wdraw_gas" },
      })
      const before = kept.map((id) => notifications.get(id))
      expect(before).not.toContain(null)

      feed.emit([leg("gas", "l2_mined"), ...others])
      await producer.flush()
      expect(kept.map((id) => notifications.get(id))).toEqual(before)
      expect(
        notifications
          .list()
          .map((e) => e.id)
          .sort(),
      ).toEqual([...kept, `bridge:withdrawal-group:${GROUP_ID}:inflight`].sort())
    })

    it("keeps the failed entry of a group whose records name no leg, and writes nothing", async () => {
      const failedId = `bridge:withdrawal-group:${GROUP_ID}:failed:wdraw_first`
      const records = [
        withdrawal({ localId: "wdraw_first", groupId: GROUP_ID, phase: "done" }),
        withdrawal({ localId: "wdraw_second", groupId: GROUP_ID, phase: "failed", startTime: 950 }),
      ]
      producer.start()
      feed.emit(records)
      await producer.flush()
      await notifications.dismiss(failedId, 1_050)
      const writes = vi.spyOn(storage, "setItem")

      feed.emit([...records])
      await producer.flush()
      expect(notifications.get(failedId)).toMatchObject({ dismissedAt: 1_050 })
      expect(writes).not.toHaveBeenCalled()
    })
  })

  describe("a withdrawal that failed and is no longer failed", () => {
    const FAILED_ID = "bridge:withdrawal:withdraw-local-id:failed"
    const LIVE_ID = "bridge:withdrawal:withdraw-local-id:inflight"
    const live = (phase: WithdrawalRecord["phase"] = "l2_mined") =>
      withdrawal({ phase, endTime: undefined })
    const shown = () => notifications.list().filter((e) => !e.dismissedAt)

    it("loses its failed entry and shows its live row", async () => {
      producer.start()
      feed.emit([live()])
      await producer.flush()
      feed.emit([withdrawal({ phase: "failed" })])
      await producer.flush()
      expect(shown()).toMatchObject([{ id: FAILED_ID, title: "Withdrawal failed" }])

      feed.emit([live()])
      await producer.flush()
      expect(notifications.get(FAILED_ID)).toBeNull()
      expect(shown()).toMatchObject([
        { id: LIVE_ID, title: "Withdrawal in progress", pending: true },
      ])
    })

    it("loses its failed entry when it settled before the producer saw it live", async () => {
      producer.start()
      feed.emit([withdrawal({ phase: "failed" })])
      await producer.flush()
      feed.emit([withdrawal({ phase: "done", endTime: 1_300 })])
      await producer.flush()
      expect(notifications.get(FAILED_ID)).toBeNull()
      expect(shown()).toMatchObject([{ title: "Withdrawal complete" }])
    })

    it("retires a failed entry left by an earlier page load on the first pass", async () => {
      producer.start()
      feed.emit([live()])
      await producer.flush()
      feed.emit([withdrawal({ phase: "failed" })])
      await producer.flush()
      producer.stop()

      const reloadedStore = new AppNotificationStore(storage)
      const reloaded = new BridgeNotificationProducer(feed, reloadedStore, { liveRows: true })
      feed.emit([live()])
      reloaded.start()
      await reloaded.flush()
      reloaded.stop()
      expect(reloadedStore.get(FAILED_ID)).toBeNull()
      expect(reloadedStore.list().filter((e) => !e.dismissedAt)).toMatchObject([
        { id: LIVE_ID, pending: true },
      ])
    })

    it("loses its failed entry on a client that shows no live rows", async () => {
      const quiet = new BridgeNotificationProducer(feed, notifications)
      quiet.start()
      feed.emit([withdrawal({ phase: "failed" })])
      await quiet.flush()
      feed.emit([live()])
      await quiet.flush()
      quiet.stop()
      expect(notifications.list()).toEqual([])
    })

    it("leaves a live row that is on display as it is", async () => {
      producer.start()
      feed.emit([live()])
      await producer.flush()
      feed.emit([withdrawal({ phase: "failed" })])
      await producer.flush()
      await notifications.upsert({
        ...notifications.get(LIVE_ID)!,
        dismissedAt: undefined,
        description: "$4 · Swapping",
      })
      const removed = vi.spyOn(notifications, "remove")

      feed.emit([live("swapping")])
      await producer.flush()
      expect(removed.mock.calls).toEqual([[FAILED_ID]])
      expect(notifications.get(LIVE_ID)).toMatchObject({ read: true })
    })

    it("keeps its failed entry while it is still failed", async () => {
      producer.start()
      feed.emit([withdrawal({ phase: "failed" })])
      await producer.flush()
      await notifications.markRead(FAILED_ID, 1_050)

      feed.emit([withdrawal({ phase: "failed" })])
      await producer.flush()
      expect(shown()).toMatchObject([{ id: FAILED_ID, read: true, readAt: 1_050 }])
    })

    it("removes nothing for a row that never failed; its producer's next assertion shows it again", async () => {
      producer.start()
      feed.emit([live()])
      await producer.flush()
      await notifications.dismiss(LIVE_ID, 1_050)
      const removed = vi.spyOn(notifications, "remove")

      feed.emit([live("awaiting_proven")])
      await producer.flush()
      expect(removed).not.toHaveBeenCalled()
      expect(notifications.get(LIVE_ID)).toMatchObject({ pending: true })
      expect(notifications.get(LIVE_ID)?.dismissedAt).toBeUndefined()
    })

    it('loses a stored "Payment failed" for its burn; a payment, a claim and a failed withdrawal keep theirs', async () => {
      const PAYMENT = `0x${"0a".repeat(32)}` as const
      const FAILED_BURN = `0x${"0b".repeat(32)}` as const
      // A claim that funds a registration shares its transaction with the registration's burn.
      const CLAIM = `0x${"0c".repeat(32)}` as const
      for (const txHash of [L2_HASH, PAYMENT, FAILED_BURN, CLAIM]) {
        const alert = reorgNotificationInput({ type: "failed", txHash, reorgEpoch: 1 }, 1_000)
        await notifications.createIfAbsent(alert!)
      }

      producer.start()
      feed.emit([
        live(),
        withdrawal({ localId: "still-failed", l2TxHash: FAILED_BURN }),
        withdrawal({ localId: "reg", l2TxHash: CLAIM, intent: "registration", phase: "l2_mined" }),
      ])
      await producer.flush()
      const alerts = notifications.list().filter((e) => e.title === "Payment failed")
      expect(alerts.map((e) => e.sourceId).sort()).toEqual([PAYMENT, FAILED_BURN, CLAIM])
    })

    it("reports a later failure anew", async () => {
      producer.start()
      feed.emit([withdrawal({ phase: "failed" })])
      await producer.flush()
      await notifications.dismiss(FAILED_ID)
      feed.emit([live()])
      await producer.flush()

      feed.emit([withdrawal({ phase: "failed", endTime: 1_300, error: "Burn reverted" })])
      await producer.flush()
      expect(shown()).toMatchObject([
        { id: FAILED_ID, description: "Burn reverted", timestampMs: 1_300, read: false },
      ])
    })
  })

  it("tracks an in-flight deposit live and retires the row once it settles", async () => {
    producer.start()

    feed.emit([sipaDeposit({ phase: "broadcast", endTime: undefined })])
    await producer.flush()
    expect(notifications.list()).toMatchObject([
      { title: "Deposit in progress", description: "$10 · Receiving", pending: true },
    ])

    feed.emit([sipaDeposit({ phase: "pendingClaim", endTime: undefined })])
    await producer.flush()
    expect(notifications.list()).toMatchObject([
      { description: "$10 · Crediting", pending: true },
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
      { description: "$9.65 · Receiving", pending: true },
    ])

    feed.emit([sipaDeposit({ phase: "sweeping", endTime: undefined, fee: undefined })])
    await producer.flush()
    expect(notifications.list()).toMatchObject([
      { description: "$10 · Receiving", pending: true },
    ])
  })

  it("says why a deposit waits for its sweep and updates the same row in place", async () => {
    producer.start()
    const waiting = (processing: SipaProcessingState): BridgeActivityItem => ({
      kind: "bridge.sipaDeposit",
      record: sipaDeposit({ phase: "sweeping", endTime: undefined }).record as SIPADepositRecord,
      processing,
    })
    const short: SipaProcessingState = {
      reason: {
        kind: "capacity",
        requiredAtomic: 2n,
        availableAtomic: 1n,
        refill: { status: "unknown" },
        decimals: 18,
        observedAt: 1,
      },
      blocker: { kind: "capacity", observedAt: 1 },
    }

    // A confirmed blocker is said at once, even on a fresh deposit.
    feed.emit([waiting(short)])
    await producer.flush()
    const [row] = notifications.list()
    expect(row).toMatchObject({ description: "$10 · Waiting for capacity", pending: true })

    // Past the stuck clock, enough capacity reads as processing: the same live row changes, and
    // nothing announces success.
    vi.setSystemTime(900 + STUCK_SWEEP_MS)
    feed.emit([
      waiting({ reason: { kind: "processing", availableAtomic: 5n, decimals: 18, observedAt: 2 } }),
    ])
    await producer.flush()
    expect(notifications.list()).toMatchObject([
      { id: row.id, description: "$10 · Waiting for processing", pending: true },
    ])

    for (const [reason, label] of [
      [{ kind: "checking" }, "Checking status"],
      [{ kind: "unavailable", cause: "capacity-unread" }, "Receiving"],
    ] as const) {
      feed.emit([waiting({ reason })])
      await producer.flush()
      expect(notifications.list()).toMatchObject([{ id: row.id, description: `$10 · ${label}` }])
    }
  })

  it("keeps a fresh healthy deposit's phase wording rather than a delay reason", async () => {
    producer.start()
    for (const reason of [
      { kind: "processing", availableAtomic: 5n, decimals: 18, observedAt: 1 },
      {
        kind: "unavailable",
        cause: "amount-unknown",
        availableAtomic: 5n,
        decimals: 18,
        observedAt: 1,
      },
      { kind: "unavailable", cause: "capacity-unread" },
      { kind: "checking" },
    ] as const) {
      feed.emit([
        {
          kind: "bridge.sipaDeposit",
          record: sipaDeposit({ phase: "sweeping", endTime: undefined })
            .record as SIPADepositRecord,
          processing: { reason },
        },
      ])
      await producer.flush()
      expect(notifications.list()).toMatchObject([
        { description: "$10 · Receiving", pending: true },
      ])
    }
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

  it("retires a stored deposit row once the feed carries only a registration deposit", async () => {
    // A live row minted for the registration deposit before RegistrationNotificationProducer took
    // it over. This producer now excludes that deposit, so nothing else would retire the row.
    const staleId = `bridge:sipaDeposit:${SIPA_ADDRESS.toLowerCase()}:inflight`
    await notifications.upsert({
      id: staleId,
      producer: "bridge",
      domain: "bridge",
      sourceId: staleId,
      title: "Deposit in progress",
      description: "$10.00 · Sweeping",
      timestampMs: 900,
      systemIcon: "arrow.down.left",
      severity: "info",
      pending: true,
      target: {
        type: "bridge.txDetail",
        bridgeKind: "deposit",
        sourceId: SIPA_ADDRESS.toLowerCase(),
      },
    })

    producer.start()
    feed.emit([sipaDeposit({ intent: "registration", phase: "claimed" })])
    await producer.flush()

    expect(notifications.list().find((e) => e.id === staleId)?.dismissedAt).toBeDefined()
    // The registration deposit's own story is the other producer's; this one adds nothing for it.
    expect(notifications.list().filter((e) => !e.dismissedAt)).toEqual([])
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

  it("still notifies a reorg-dropped withdrawal that failed before the startup baseline", async () => {
    producer.start()

    feed.emit([withdrawal({ phase: "failed", endTime: 999, droppedBurn: true })])
    await producer.flush()

    expect(notifications.list()).toHaveLength(1)
    expect(notifications.list()[0].title).toBe("Withdrawal failed")
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
