import { describe, expect, it } from "vitest"
import { PaylinkActionEnum, QueueStatus } from "@obsidion/core/constants"
import { createActivity } from "../../src/engine/activity"
import { createMemoryKv, type KvStore } from "../../src/engine/kv"
import { diskKv } from "./diskKv"
import { ACCOUNT_STORAGE_KEY, TRANSACTIONS_STORAGE_KEY } from "../../src/core/storages/constants"
import type { PaylinkTransaction, TokenTransaction } from "../../src/types/transactions"

const token = {
  address: "0xtoken",
  name: "USD",
  symbol: "USD",
  decimals: 6,
  logo: "",
  amount: 1.5,
  price: 1,
}

const pendingSend = (over: Partial<TokenTransaction> = {}): TokenTransaction => ({
  id: "op-1",
  operationId: "op-1",
  action: "send",
  token,
  amountAtomic: 1_500_000n,
  timestamp: 1_000,
  status: "pending",
  txHash: "",
  ...over,
})

const scanned = (over: Record<string, unknown> = {}) => ({
  txHash: "0xAA",
  from: "@alice",
  senderL2Address: "0xalice",
  to: "@me",
  token,
  amountAtomic: 1_500_000n,
  timestamp: 2_000,
  ...over,
})

const link = {
  flavor: "direct" as const,
  token,
  amountAtomic: 1n,
  timestamp: 1,
  blockNumber: 1,
  payToEmailSecret: "s",
  obsidionAccountAddress: "0xme",
  tokenAddress: "0xtoken",
  paylink: "url",
  fallbackSecret: "f",
  networkId: "net",
}

function open(kv: KvStore = createMemoryKv()) {
  return { activity: createActivity({ kv, networkId: () => "net" }), kv }
}

async function isSettled(p: Promise<unknown>): Promise<boolean> {
  let done = false
  void p.then(() => (done = true))
  await new Promise((r) => setTimeout(r, 0))
  return done
}

describe("activity: the submit boundary", () => {
  it("resolves insertPending only once durable, with the row readable at once", async () => {
    const disk = diskKv()
    const { activity } = open(disk.kv)
    await disk.land()
    disk.hold(true)
    const insert = activity.insertPending(pendingSend())
    expect(activity.latest("op-1")?.networkId).toBe("net")
    expect(activity.rows.get()).toEqual([])
    expect(await isSettled(insert)).toBe(false)
    await disk.land()
    expect(await isSettled(insert)).toBe(true)
    expect(activity.rows.get().map((row) => row.id)).toEqual(["op-1"])
  })

  it("resolves setHash only once durable and stamps the hash once", async () => {
    const disk = diskKv()
    const { activity } = open(disk.kv)
    await activity.insertPending(pendingSend())
    disk.hold(true)
    const stamp = activity.setHash("op-1", "0xBEEF")
    expect(activity.latest("op-1")?.detailedStatus).toBe(QueueStatus.MINING)
    expect(await isSettled(stamp)).toBe(false)
    await disk.land()
    disk.hold(false)
    expect(await stamp).toBe(true)
    expect(activity.byHash("0xbeef")?.id).toBe("op-1")
    expect(await activity.setHash("op-1", "0xOTHER")).toBe(true)
    expect(activity.latest("op-1")?.txHash).toBe("0xBEEF")
    expect(await activity.setHash("missing", "0x1")).toBe(false)
  })

  it("finds a hash still saving, so the scan does not file it twice", async () => {
    const disk = diskKv()
    const { activity } = open(disk.kv)
    await activity.insertPending(pendingSend())
    disk.hold(true)
    const stamp = activity.setHash("op-1", "0xAA")
    expect(activity.upsertScanned(scanned({ action: "send" })).inserted).toBe(false)
    await disk.land()
    await stamp
    expect(activity.rows.get().map((row) => row.id)).toEqual(["op-1"])
  })

  it("stops finding a hash whose save failed", async () => {
    const disk = diskKv()
    const { activity } = open(disk.kv)
    await activity.insertPending(pendingSend())
    disk.fail(true)
    await expect(activity.setHash("op-1", "0xAA")).rejects.toThrow()
    disk.fail(false)
    expect(activity.byHash("0xaa")).toBeUndefined()
  })
})

describe("activity: rows by hash", () => {
  it("files a scanned transfer once, and never beside the row this device started", async () => {
    const { activity } = open()
    await activity.insertPending(pendingSend())
    await activity.setHash("op-1", "0xAA")
    expect(activity.upsertScanned(scanned({ action: "send" })).inserted).toBe(false)
    const receive = activity.upsertScanned(scanned({ txHash: "0xBB" }))
    expect(receive).toMatchObject({ inserted: true, tx: { id: "0xbb", amountAtomic: 1_500_000n } })
    const replay = activity.upsertScanned(scanned({ txHash: "0xbb", from: "@mallory" }))
    expect(replay.tx.from).toBe("@alice")
    expect(activity.rows.get().map((r) => r.id)).toEqual(["op-1", "0xbb"])
  })

  it("knows a refund's hash, and fills a missing memo", () => {
    const { activity } = open()
    activity.addRecoveredPaylink({
      ...link,
      txHash: "0xPAY",
      isRefunded: true,
      refundTxHash: "0xR",
    })
    expect(activity.hasTxHash("0xr")).toBe(true)
    expect((activity.byHash("0xpay") as PaylinkTransaction).paylink).toBeUndefined()
    expect(activity.backfillMemo("0xpay", "hi")).toBe(true)
    expect(activity.backfillMemo("0xpay", "again")).toBe(false)
  })

  it("upgrades a scanned send to a recovered link and a scanned receive to a payout, in place", () => {
    const { activity } = open()
    activity.upsertScanned(scanned({ action: "send", txHash: "0x01" }))
    activity.upsertScanned(scanned({ txHash: "0x02" }))
    const created = activity.addRecoveredPaylink({ ...link, txHash: "0x01" })
    expect(created).toMatchObject({
      inserted: true,
      tx: { id: "0x01", action: PaylinkActionEnum.PAY },
    })
    expect(activity.addRecoveredPaylink({ ...link, txHash: "0x01" }).inserted).toBe(false)
    const payout = { ...link, action: PaylinkActionEnum.CLAIM as const }
    expect(activity.addRecoveredPayout({ ...payout, txHash: "0x02" })).toBe(true)
    expect(activity.addRecoveredPayout({ ...payout, txHash: "0x01" })).toBe(false)
    expect(activity.rows.get().map((r) => r.action)).toEqual([
      PaylinkActionEnum.PAY,
      PaylinkActionEnum.CLAIM,
    ])
  })
})

describe("activity: lifecycle", () => {
  it("fails only this device's hashless rows older than the cutoff", async () => {
    const { activity } = open()
    await activity.insertPending(pendingSend({ timestamp: 100 }))
    await activity.insertPending(pendingSend({ id: "op-2", operationId: "op-2", timestamp: 900 }))
    await activity.insertPending(pendingSend({ id: "op-3", operationId: "op-3", timestamp: 100 }))
    await activity.setHash("op-3", "0x3")
    activity.upsertScanned(scanned({ timestamp: 100 }))
    expect(activity.failInterrupted(1_000, 500).map((r) => r.id)).toEqual(["op-1"])
    expect(activity.latest("op-1")).toMatchObject({
      status: "failed",
      failure: { code: "tx.interrupted" },
    })
  })

  it("settles and fails rows, and a flow's second outcome changes nothing", async () => {
    const { activity } = open()
    await activity.insertPending(pendingSend())
    await activity.insertPending(pendingSend({ id: "op-2", operationId: "op-2" }))
    expect(activity.settle("op-1", "0x9")).toBe(true)
    expect(activity.latest("op-1")).toMatchObject({ status: "success", txHash: "0x9" })
    expect(activity.fail("op-2", { code: "tx.failed", detail: "boom" })).toBe(true)
    expect(activity.latest("op-2")).toMatchObject({
      status: "failed",
      failure: { code: "tx.failed" },
    })
    expect(activity.fail("op-1", { code: "tx.failed" })).toBe(false)
    expect(activity.latest("op-1")?.status).toBe("success")
  })

  it("keeps a demote that lands while the flow waits, against the flow's late settle", async () => {
    const { activity } = open()
    await activity.insertPending(pendingSend())
    await activity.setHash("op-1", "0x9")
    // The flow waits (a registration burn mining) while the reorg monitor demotes its row.
    expect(activity.demoteByTxHash("0x9").reorgEpoch).toBe(1)
    expect(activity.settle("op-1", "0x9")).toBe(false)
    expect(activity.latest("op-1")).toMatchObject({ status: "pending", reorgEpoch: 1 })
    activity.settleByHash("0x9", QueueStatus.SUCCESS, 5, 1)
    expect(activity.latest("op-1")).toMatchObject({ status: "success", endTime: 5 })
  })

  it("keeps a freeze that lands while the flow waits, against the flow's late settle", async () => {
    const { activity } = open()
    await activity.insertPending(pendingSend())
    await activity.setHash("op-1", "0x9")
    activity.demoteByTxHash("0x9", { terminal: "failed" })
    expect(activity.settle("op-1")).toBe(false)
    expect(activity.latest("op-1")?.status).toBe("failed")
  })

  it("never lets a field patch move a row's status or claim state", async () => {
    const { activity } = open()
    await activity.insertPending(pendingSend())
    activity.patch("op-1", (row) => ({ ...row, status: "success", txHash: "0x1", memo: "hi" }))
    expect(activity.latest("op-1")).toMatchObject({ status: "pending", txHash: "", memo: "hi" })
  })

  it("fences a stale settle after a reorg demote", () => {
    const { activity } = open()
    activity.upsertScanned(scanned())
    const { reorgEpoch } = activity.demoteByTxHash("0xaa")
    expect(activity.byHash("0xaa")?.status).toBe("pending")
    activity.settleByHash("0xaa", QueueStatus.SUCCESS, 5)
    expect(activity.byHash("0xaa")?.status).toBe("pending")
    activity.settleByHash("0xaa", QueueStatus.SUCCESS, 5, reorgEpoch)
    expect(activity.byHash("0xaa")).toMatchObject({ status: "success", endTime: 5 })
    expect(activity.demoteByTxHash("0xaa", { terminal: "failed" })).toEqual({
      matched: true,
      reorgEpoch: 2,
    })
    expect(activity.byHash("0xaa")?.status).toBe("failed")
  })

  it("keeps its rows across a reopen", async () => {
    const kv = createMemoryKv()
    const first = open(kv).activity
    await first.insertPending(pendingSend())
    first.upsertScanned(scanned())
    expect(open(kv).activity.rows.get()).toEqual(first.rows.get())
  })
})

describe("activity: writes in flight", () => {
  it("lets each writer read the last write, while rows wait for it to land", async () => {
    const disk = diskKv()
    const { activity } = open(disk.kv)
    await activity.insertPending(pendingSend())
    disk.hold(true)
    activity.patch("op-1", (row) => ({ ...row, memo: "hi" }))
    activity.settle("op-1", "0x9")
    activity.upsertScanned(scanned({ txHash: "0xBB", memo: "first" }))
    expect(activity.backfillMemo("0xbb", "later")).toBe(false)
    expect(activity.byHash("0xbb")?.id).toBe("0xbb")
    expect(activity.rows.get().map((row) => row.status)).toEqual(["pending"])
    await disk.land()
    expect(activity.latest("op-1")).toMatchObject({ status: "success", txHash: "0x9", memo: "hi" })
    expect(activity.rows.get().map((row) => row.id)).toEqual(["op-1", "0xbb"])
  })
})

describe("activity: migration from the legacy blob", () => {
  const interrupted =
    "This payment was interrupted before it was sent. The amount is still in your balance."
  const legacy = [
    {
      action: "send",
      token,
      timestamp: 1,
      status: "failed",
      txHash: "",
      queueId: "op-a",
      error: interrupted,
    },
    {
      action: "send",
      token,
      timestamp: 2,
      status: "failed",
      txHash: "",
      queueId: "op-b",
      error: "boom",
    },
    {
      action: "receive",
      token,
      timestamp: 3,
      status: "success",
      txHash: "0xC",
      amountAtomic: "42",
    },
    {
      action: "send",
      token: { ...token, amount: 0.1, decimals: 18 },
      timestamp: 4,
      status: "success",
      txHash: "0xD",
      toTag: "bob",
      kind: "send",
    },
    {
      action: PaylinkActionEnum.PAY,
      emailPaymentAction: PaylinkActionEnum.PAY,
      token,
      timestamp: 5,
      status: "pending",
      txHash: "",
      to: "a@b.co",
      operationId: "op-e",
      queueId: "q-e",
    },
    { action: "contract_call", timestamp: 6, status: "success", txHash: "" },
  ]

  it("carries every row, keyed and converted, and leaves the legacy key in place", async () => {
    const kv = createMemoryKv()
    kv.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify(legacy))
    const { activity } = open(kv)
    await activity.ready
    const byId = new Map(activity.rows.get().map((r) => [r.id, r]))
    expect([...byId.keys()]).toEqual(["op-a", "op-b", "0xc", "0xd", "op-e", "legacy-6-5"])
    expect(byId.get("op-a")).toMatchObject({
      operationId: "op-a",
      failure: { code: "tx.interrupted" },
    })
    expect(byId.get("op-b")?.failure).toEqual({ code: "tx.failed", detail: "boom" })
    expect(byId.get("0xc")?.amountAtomic).toBe(42n)
    expect(byId.get("0xd")).toMatchObject({ amountAtomic: 10n ** 17n, toTag: "bob" })
    expect(byId.get("op-e")).toMatchObject({ flavor: "email", amountAtomic: 1_500_000n })
    expect(byId.get("legacy-6-5")?.amountAtomic).toBe(0n)
    for (const row of byId.values()) expect(row).not.toHaveProperty("queueId")
    expect(kv.getItem(TRANSACTIONS_STORAGE_KEY)).not.toBeNull()
    expect(kv.getItem("acct/meta/activity")).toBe("1")
  })

  it("carries the account blob's rows where no build split them out, never over the split key", () => {
    const kv = createMemoryKv()
    kv.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify({ name: "me", transactions: legacy }))
    const ids = ["op-a", "op-b", "0xc", "0xd", "op-e", "legacy-6-5"]
    expect(
      open(kv)
        .activity.rows.get()
        .map((r) => r.id),
    ).toEqual(ids)

    const split = createMemoryKv()
    split.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify({ transactions: legacy }))
    split.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify([legacy[2]]))
    expect(
      open(split)
        .activity.rows.get()
        .map((r) => r.id),
    ).toEqual(["0xc"])
  })

  it("reads the legacy key once", () => {
    const kv = createMemoryKv()
    kv.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify(legacy))
    open(kv)
    kv.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify([{ ...legacy[2], txHash: "0xNEW" }]))
    expect(open(kv).activity.byHash("0xnew")).toBeUndefined()
  })

  it("runs a failed import again until it lands, keeping rows written meanwhile", async () => {
    vi.useFakeTimers()
    try {
      const disk = diskKv()
      disk.kv.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify(legacy))
      await disk.land()
      disk.fail(true)
      const { activity } = open(disk.kv)
      await vi.advanceTimersByTimeAsync(0)
      expect(activity.rows.get()).toEqual([])
      disk.fail(false)
      activity.upsertScanned(scanned({ txHash: "0xNEW" }))
      await vi.advanceTimersByTimeAsync(1_000)
      await activity.ready
      const ids = activity.rows.get().map((row) => row.id)
      expect(ids).toEqual(expect.arrayContaining(["op-a", "0xc", "0xnew"]))
      expect(disk.kv.getItem("acct/meta/activity")).toBe("1")
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps saved rows when the import runs again after its version write was lost", () => {
    const kv = createMemoryKv()
    kv.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify(legacy))
    const first = open(kv).activity
    first.settle("op-e", "0xE")
    kv.removeItem("acct/meta/activity")
    expect(open(kv).activity.latest("op-e")).toMatchObject({ status: "success", txHash: "0xE" })
  })

  it("opens empty from a malformed or missing blob", () => {
    const kv = createMemoryKv()
    kv.setItem(TRANSACTIONS_STORAGE_KEY, "{not json")
    expect(open(kv).activity.rows.get()).toEqual([])
    expect(open().activity.rows.get()).toEqual([])
  })
})
