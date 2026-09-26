import { afterEach, describe, expect, it, vi } from "vitest"

import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"
import { AppNotificationStore } from "../../src/core/services/notifications/AppNotificationStore"
import { PendingPaylinkMigrationStore } from "../../src/core/services/paylink/PendingPaylinkMigrationStore"
import { PendingPaylinkMigrationService } from "../../src/core/services/paylink/PendingPaylinkMigrationService"
import { setActiveNetworkId } from "../../src/core/activeNetworkId"
import type { CheckSpent } from "../../src/core/services/paylink/PaylinkClaimReconciler"
import type { PaylinkTransaction, Transaction } from "../../src/types"

const NOW_MS = 1_700_000_000_000
const FROM = 1_000
const UNTIL = 2_000

const row = (overrides: Partial<PaylinkTransaction> = {}): PaylinkTransaction =>
  ({
    action: "Pay To Email",
    emailPaymentAction: "Pay To Email",
    flavor: "direct",
    token: {
      name: "DAI",
      symbol: "DAI",
      decimals: 6,
      logo: "",
      price: 1,
      address: "0xt",
      amount: 5,
    },
    timestamp: NOW_MS - 1000,
    status: "success",
    txHash: "0xRow",
    paylink: "https://x/#frag",
    fallbackSecret: "0xtag",
    tokenAddress: "0xhistoric",
    fromClaimable: FROM,
    untilClaimable: UNTIL,
    ...overrides,
  } as PaylinkTransaction)

const unspent: CheckSpent = async (rows) => new Map(rows.map((r) => [r.txHash, false]))

afterEach(() => setActiveNetworkId(undefined))

/** `checkSpent: null` builds a service that has no nullifier read yet. */
function build(rows: Transaction[], checkSpent: CheckSpent | null = unspent) {
  const store = new PendingPaylinkMigrationStore(new InMemoryStorageAdapter())
  const notifications = new AppNotificationStore(new InMemoryStorageAdapter())
  const service = new PendingPaylinkMigrationService({
    store,
    notificationStore: notifications,
    accountTransactions: async () => rows,
    checkSpent: checkSpent ?? undefined,
    now: () => NOW_MS,
  })
  return { store, notifications, service, rows }
}

describe("PendingPaylinkMigrationService", () => {
  it("records a locked row as waiting and skips rows without a claim window", async () => {
    const { store, service } = build([])
    await service.recordPending([row(), row({ txHash: "0xNoWindow", untilClaimable: undefined })])
    expect(store.list()).toEqual([
      expect.objectContaining({
        txHash: "0xRow",
        untilClaimable: UNTIL,
        status: "waiting",
        tokenAddress: "0xhistoric",
      }),
    ])
  })

  it("stays waiting inside the window and mints nothing", async () => {
    const { store, notifications, service } = build([row()])
    await service.recordPending([row()])
    await service.reconcile(FROM + 10)
    expect(store.get("0xrow")!.status).toBe("waiting")
    expect(notifications.list()).toHaveLength(0)
  })

  it("flips to claimable past expiry and mints one reclaim notification, fire-once", async () => {
    const { store, notifications, service } = build([row()])
    await service.recordPending([row()])
    await service.reconcile(UNTIL + 1)
    await service.reconcile(UNTIL + 2)
    expect(store.get("0xRow")!.status).toBe("claimable")
    const list = notifications.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.title).toBe("Paylink ready to reclaim")
    expect(list[0]!.description).toContain("$5")
    expect(list[0]!.target).toEqual({ type: "paylink.reclaimable", txHash: "0xRow" })
  })

  it("a stale probe never pulls a claimable record back to waiting", async () => {
    const { store, service } = build([row()])
    await service.recordPending([row()])
    await service.reconcile(UNTIL + 1)
    await service.recordPending([row()])
    expect(store.get("0xRow")!.status).toBe("claimable")
  })

  it("resolves silently when the recipient claimed while it waited", async () => {
    const rows = [row()]
    const { store, notifications, service } = build(rows)
    await service.recordPending(rows as PaylinkTransaction[])
    rows[0] = row({ isClaimed: true })
    await service.reconcile(UNTIL + 1)
    expect(store.get("0xRow")).toMatchObject({ status: "resolved", resolvedReason: "claimed" })
    expect(notifications.list()).toHaveLength(0)
  })

  it("resolves a claimable record once its refund lands", async () => {
    const rows = [row()]
    const { store, service } = build(rows)
    await service.recordPending(rows as PaylinkTransaction[])
    await service.reconcile(UNTIL + 1)
    rows[0] = row({ isRefunded: true })
    await service.reconcile(UNTIL + 2)
    expect(store.get("0xRow")).toMatchObject({ status: "resolved", resolvedReason: "refunded" })
  })

  it("resolves as unavailable when the row is gone", async () => {
    const rows: Transaction[] = [row()]
    const { store, service } = build(rows)
    await service.recordPending(rows as PaylinkTransaction[])
    rows.length = 0
    await service.reconcile(FROM + 10)
    expect(store.get("0xRow")).toMatchObject({ status: "resolved", resolvedReason: "unavailable" })
  })

  it("resolves as migrated when the escrow was exited by the frozen-generation path", async () => {
    const rows = [row()]
    const { store, service } = build(rows)
    await service.recordPending(rows as PaylinkTransaction[])
    rows[0] = row({ isMigrated: true })
    await service.reconcile(UNTIL + 1)
    expect(store.get("0xRow")).toMatchObject({ status: "resolved", resolvedReason: "migrated" })
  })

  it("leaves records untouched when the transactions read throws or returns null", async () => {
    const store = new PendingPaylinkMigrationStore(new InMemoryStorageAdapter())
    const notifications = new AppNotificationStore(new InMemoryStorageAdapter())
    const throwing = new PendingPaylinkMigrationService({
      store,
      notificationStore: notifications,
      accountTransactions: async () => {
        throw new Error("boom")
      },
      now: () => NOW_MS,
    })
    await throwing.recordPending([row()])
    await expect(throwing.reconcile(UNTIL + 1)).resolves.toHaveLength(1)
    const empty = new PendingPaylinkMigrationService({
      store,
      notificationStore: notifications,
      accountTransactions: async () => null,
      now: () => NOW_MS,
    })
    await expect(empty.reconcile(UNTIL + 1)).resolves.toHaveLength(1)
    expect(store.get("0xRow")!.status).toBe("waiting")
    expect(notifications.list()).toHaveLength(0)
  })

  it("retries the reclaim notification on the next reconcile when the mint failed", async () => {
    const { store, notifications, service } = build([row()])
    await service.recordPending([row()])
    vi.spyOn(notifications, "createIfAbsent").mockRejectedValueOnce(new Error("disk"))
    await service.reconcile(UNTIL + 1)
    expect(store.get("0xRow")!.status).toBe("claimable")
    expect(notifications.list()).toHaveLength(0)
    await service.reconcile(UNTIL + 2)
    expect(notifications.list()).toHaveLength(1)
  })

  it("re-opens a resolved record when the probe reports the escrow locked again", async () => {
    const rows = [row({ isClaimed: true })]
    const { store, notifications, service } = build(rows)
    await service.recordPending(rows as PaylinkTransaction[])
    await service.reconcile(FROM + 10)
    expect(store.get("0xRow")!.status).toBe("resolved")
    rows[0] = row()
    await service.recordPending(rows as PaylinkTransaction[])
    expect(store.get("0xRow")!.status).toBe("waiting")
    expect(store.get("0xRow")!.resolvedReason).toBeUndefined()
    await service.reconcile(UNTIL + 1)
    expect(store.get("0xRow")!.status).toBe("claimable")
    expect(notifications.list()).toHaveLength(1)
  })

  it("resolves as claimed instead of notifying when the nullifier is already spent", async () => {
    const { store, notifications, service } = build([row()], async () => new Map([["0xRow", true]]))
    await service.recordPending([row()])
    await service.reconcile(UNTIL + 1)
    expect(store.get("0xRow")).toMatchObject({ status: "resolved", resolvedReason: "claimed" })
    expect(notifications.list()).toHaveLength(0)
  })

  it("defers the notice while the spent check fails, then mints once it reads unspent", async () => {
    const checkSpent = vi
      .fn<Parameters<CheckSpent>, ReturnType<CheckSpent>>()
      .mockRejectedValueOnce(new Error("rpc"))
      .mockResolvedValueOnce(new Map())
      .mockResolvedValue(new Map([["0xRow", false]]))
    const { store, notifications, service } = build([row()], checkSpent)
    await service.recordPending([row()])
    await service.reconcile(UNTIL + 1)
    await service.reconcile(UNTIL + 2)
    expect(store.get("0xRow")!.status).toBe("claimable")
    expect(notifications.list()).toHaveLength(0)
    await service.reconcile(UNTIL + 3)
    expect(notifications.list()).toHaveLength(1)
    // The read happens once per notice: an existing entry short-circuits it.
    await service.reconcile(UNTIL + 4)
    expect(checkSpent).toHaveBeenCalledTimes(3)
  })

  it("advances records but mints nothing until a spent check exists", async () => {
    const { store, notifications, service } = build([row()], null)
    await service.recordPending([row()])
    await service.reconcile(UNTIL + 1)
    expect(store.get("0xRow")!.status).toBe("claimable")
    expect(notifications.list()).toHaveLength(0)
  })

  it("stamps the active network and leaves other networks' records alone", async () => {
    setActiveNetworkId("net-a")
    const { store, notifications, service } = build([row()])
    await service.recordPending([row()])
    expect(store.get("0xRow")!.networkId).toBe("net-a")
    setActiveNetworkId("net-b")
    await service.reconcile(UNTIL + 1)
    expect(store.get("0xRow")!.status).toBe("waiting")
    expect(notifications.list()).toHaveLength(0)
    setActiveNetworkId("net-a")
    await service.reconcile(UNTIL + 1)
    expect(store.get("0xRow")!.status).toBe("claimable")
    expect(notifications.list()).toHaveLength(1)
  })

  it("survives a reload — records persist through the adapter", async () => {
    const adapter = new InMemoryStorageAdapter()
    const first = new PendingPaylinkMigrationStore(adapter)
    await first.set({
      txHash: "0xRow",
      untilClaimable: UNTIL,
      flavor: "direct",
      status: "waiting",
      detectedAtMs: NOW_MS,
      updatedAtMs: NOW_MS,
    })
    const second = new PendingPaylinkMigrationStore(adapter)
    await second.load()
    expect(second.get("0xrow")?.status).toBe("waiting")
  })
})
