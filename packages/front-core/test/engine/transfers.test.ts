import { describe, expect, it } from "vitest"
import { PaylinkActionEnum, QueueStatus, TokenActionEnum } from "@obsidion/core/constants"
import {
  transferPages,
  createTransfers,
  PENDING,
  storedTransfers,
  type Transfers,
} from "../../src/engine/transfers"
import { openDatabase, type DatabaseBackend } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { encodeRecord, loadRecords, timeKey } from "../../src/engine/persistentStore"
import { ACCOUNT_STORAGE_KEY, TRANSACTIONS_STORAGE_KEY } from "../../src/core/storages/constants"
import { payoutRow, scannedRow } from "../../src/core/services/transactions/TransferEventScanner"
import type { NewIncomingTokenTx } from "../../src/xmtp/receiverTypes"
import type { OnNetwork } from "../../src/types/networkStamp"
import type {
  PaylinkTransaction,
  TokenTransaction,
  Transaction,
} from "../../src/types/transactions"

const token = {
  address: "0xtoken",
  name: "USD",
  symbol: "USD",
  decimals: 6,
  logo: "",
  amount: 1.5,
  price: 1,
}

const pendingSend = (over: Partial<TokenTransaction> = {}): OnNetwork<TokenTransaction> => ({
  id: "op-1",
  networkId: "net",
  operationId: "op-1",
  action: "send",
  token,
  amountAtomic: 1_500_000n,
  timestamp: 1_000,
  status: "pending",
  txHash: "",
  ...over,
})

const scanned = (over: Partial<NewIncomingTokenTx> = {}) =>
  scannedRow({
    txHash: "0xAA",
    from: "@alice",
    senderL2Address: "0xalice",
    to: "@me",
    token,
    amountAtomic: 1_500_000n,
    timestamp: 2_000,
    networkId: "net",
    ...over,
  })

const link = (
  txHash: string,
  over: Partial<PaylinkTransaction> = {},
): OnNetwork<PaylinkTransaction> => ({
  id: txHash,
  networkId: "net",
  action: PaylinkActionEnum.PAY,
  emailPaymentAction: PaylinkActionEnum.PAY,
  status: "success",
  flavor: "direct",
  token,
  amountAtomic: 1n,
  timestamp: 1,
  txHash,
  payToEmailSecret: "0xs",
  paylink: "url",
  ...over,
})

function open(backend: DatabaseBackend = memoryBackend()): Transfers {
  return createTransfers({ db: openDatabase(backend), now: () => Date.now() })
}

const ids = async (transfers: Transfers) => (await transfers.all()).map((row) => row.id).sort()

describe("activity: rows by hash", () => {
  it("files a scanned transfer once, and never beside an older build's own row", async () => {
    const backend = memoryBackend()
    const own = pendingSend({ txHash: "0xaa" })
    backend.entries.set("acct/activity/op-1", encodeRecord(own))
    backend.entries.set("acct/meta/activity", "3")
    const transfers = open(backend)
    expect((await transfers.record(scanned({ action: "send" }))).inserted).toBe(false)
    const receive = await transfers.record(scanned({ txHash: "0xBB" }))
    expect(receive).toMatchObject({ inserted: true, tx: { id: "0xbb", txHash: "0xbb" } })
    const replay = await transfers.record(scanned({ txHash: "0xbb", from: "@mallory" }))
    expect((replay.tx as TokenTransaction).from).toBe("@alice")
    expect(await ids(transfers)).toEqual(["0xbb", "op-1"])
  })

  it("fills a missing memo", async () => {
    const transfers = open()
    await transfers.record(scanned({ txHash: "0xpay" }))
    expect(await transfers.backfillMemo("0xpay", "hi")).toBe(true)
    expect(await transfers.backfillMemo("0xpay", "again")).toBe(false)
  })

  it("upgrades a scanned receive to a payout in place, and keeps a scanned send", async () => {
    const transfers = open()
    await transfers.record(scanned({ action: "send", txHash: "0x01" }))
    await transfers.record(scanned({ txHash: "0x02" }))
    const payout = (txHash: string) =>
      payoutRow({
        action: PaylinkActionEnum.CLAIM,
        txHash,
        flavor: "direct",
        token,
        amountAtomic: 1n,
        timestamp: 3,
        blockNumber: 1,
        networkId: "net",
      })
    const replaces = { replaces: TokenActionEnum.RECEIVE }
    expect((await transfers.record(payout("0x02"), replaces)).inserted).toBe(true)
    expect((await transfers.record(payout("0x01"), replaces)).inserted).toBe(false)
    const rows = await transfers.all()
    expect(rows.map((r) => r.action).sort()).toEqual([PaylinkActionEnum.CLAIM, "send"])
  })
})

describe("activity: indexes", () => {
  it("moves a row's entries when its time or counterparty changes", async () => {
    const transfers = open()
    await transfers.record(scanned({ txHash: "0x01", senderL2Address: "0xBob", timestamp: 5 }))
    const payout = payoutRow({
      action: PaylinkActionEnum.CLAIM,
      txHash: "0x01",
      flavor: "direct",
      token,
      amountAtomic: 1n,
      timestamp: 9,
      blockNumber: 1,
      networkId: "net",
    })
    await transfers.record(payout, { replaces: TokenActionEnum.RECEIVE })
    expect(await loadRecords(transfers.where("peer", "0xbob"))).toEqual([])
    expect((await loadRecords(transfers.where("time", { before: timeKey(6) }))).length).toBe(0)
    expect((await loadRecords(transfers.where("hash", "0x01"))).map((r) => r.id)).toEqual(["0x01"])
  })

  it("reads a contact's rows by address and by tag, and a request's by its id", async () => {
    const transfers = open()
    await transfers.record(scanned({ txHash: "0x01", from: "@Alice", senderL2Address: "0xA1" }))
    await transfers.record(scanned({ txHash: "0x02", from: "@carol", requestId: "0xR" }))
    const sent = { ...scanned({ txHash: "0x03" }), action: "send", to: "0xa1", toTag: "alice" }
    await transfers.record(sent as OnNetwork<TokenTransaction>)
    const peer = async (value: string) =>
      (await loadRecords(transfers.where("peer", value))).map((r) => r.id).sort()
    expect(await peer("0xa1")).toEqual(["0x01", "0x03"])
    expect(await peer("alice")).toEqual(["0x01", "0x03"])
    const paying = await loadRecords(transfers.where("request", "0xr"))
    expect(paying.map((r) => r.id)).toEqual(["0x02"])
  })

  it("keeps the pending rows under one key, until they end", async () => {
    const transfers = open()
    await transfers.record(scanned())
    await transfers.record(scanned({ txHash: "0xBB" }))
    const { reorgEpoch } = await transfers.demoteByTxHash("0xaa")
    const pending = transfers.where("pending", PENDING)
    expect((await loadRecords(pending)).map((r) => r.id)).toEqual(["0xaa"])
    await transfers.settleByHash("0xaa", QueueStatus.SUCCESS, 5, reorgEpoch)
    expect(await loadRecords(pending)).toEqual([])
  })

  it("holds the newest rows in its view, newest first", async () => {
    const transfers = open()
    for (let i = 1; i <= 12; i++)
      await transfers.record(scanned({ txHash: `0x${i}`, timestamp: i }))
    const stop = transfers.view.subscribe(() => {})
    await transfers.ready
    await new Promise((r) => setTimeout(r, 0))
    const { records, loaded } = transfers.view.get()
    expect(loaded).toBe(true)
    expect(records.map((r) => r.timestamp)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
    stop()
  })
})

describe("activity: pages", () => {
  it("reads one more page at a time, and keeps the last shown while the next loads", async () => {
    const transfers = open()
    for (let i = 1; i <= 5; i++) await transfers.record(scanned({ txHash: `0x${i}`, timestamp: i }))
    const pages = transferPages(transfers, 2)
    const seen: number[] = []
    const stop = pages.rows.subscribe(() => seen.push(pages.rows.get().records.length))
    await new Promise((r) => setTimeout(r, 0))
    expect(pages.rows.get()).toMatchObject({ loaded: true, complete: false })
    pages.more()
    pages.more()
    await new Promise((r) => setTimeout(r, 0))
    pages.more()
    await new Promise((r) => setTimeout(r, 0))
    expect(pages.rows.get()).toMatchObject({ loaded: true, complete: true })
    expect(pages.rows.get().records.map((r) => r.timestamp)).toEqual([5, 4, 3, 2, 1])
    expect(seen.slice(seen.indexOf(2))).not.toContain(0)
    stop()
  })
})

describe("activity: pages failing", () => {
  it("keeps the page shown when the next one fails, and reads it again on the next more", async () => {
    const backend = memoryBackend()
    const transfers = open(backend)
    for (let i = 1; i <= 5; i++) await transfers.record(scanned({ txHash: `0x${i}`, timestamp: i }))
    const pages = transferPages(transfers, 2)
    const stop = pages.rows.subscribe(() => {})
    await new Promise((r) => setTimeout(r, 0))
    backend.failing = { reads: true }
    pages.more()
    await new Promise((r) => setTimeout(r, 0))
    expect(pages.rows.get()).toMatchObject({ loaded: true, failed: false, complete: false })
    expect(pages.rows.get().records.map((r) => r.timestamp)).toEqual([5, 4])
    backend.failing = {}
    pages.more()
    await new Promise((r) => setTimeout(r, 0))
    expect(pages.rows.get().records.map((r) => r.timestamp)).toEqual([5, 4, 3, 2])
    stop()
  })
})

describe("activity: lifecycle", () => {
  it("fences a stale settle after a reorg demote", async () => {
    const transfers = open()
    await transfers.record(scanned())
    const { reorgEpoch } = await transfers.demoteByTxHash("0xaa")
    expect((await transfers.byHash("0xaa"))?.status).toBe("pending")
    await transfers.settleByHash("0xaa", QueueStatus.SUCCESS, 5)
    expect((await transfers.byHash("0xaa"))?.status).toBe("pending")
    await transfers.settleByHash("0xaa", QueueStatus.SUCCESS, 5, reorgEpoch)
    expect(await transfers.byHash("0xaa")).toMatchObject({ status: "success", endTime: 5 })
    expect(await transfers.demoteByTxHash("0xaa", { terminal: "failed" })).toEqual({
      matched: true,
      reorgEpoch: 2,
    })
  })

  it("commits writes that share a transaction together, or not at all", async () => {
    const backend = memoryBackend()
    const db = openDatabase(backend)
    const transfers = createTransfers({ db, now: () => Date.now() })
    await transfers.ready
    backend.failing.commits = true
    await expect(
      db.write(async (w) => {
        await transfers.record(scanned({ txHash: "0x1" }), {}, w)
        await transfers.record(scanned({ txHash: "0x2" }), {}, w)
      }),
    ).rejects.toThrow()
    backend.failing.commits = false
    expect(await transfers.hasTxHash("0x1")).toBe(false)
    expect(await transfers.hasTxHash("0x2")).toBe(false)
  })
})

describe("activity: migration", () => {
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
  const legacyIds = ["0xc", "0xd", "legacy-6-5", "op-a", "op-b", "op-e"]

  it("fails an older build's own row that never got its hash, and keeps one that did", async () => {
    const backend = memoryBackend()
    const rows = [pendingSend(), pendingSend({ id: "op-2", operationId: "op-2", txHash: "0x2" })]
    for (const row of rows) backend.entries.set(`acct/activity/${row.id}`, encodeRecord(row))
    backend.entries.set("acct/meta/activity", "3")
    const transfers = open(backend)
    await transfers.ready
    expect(await transfers.get("op-1")).toMatchObject({
      status: "failed",
      failure: { code: "tx.interrupted" },
    })
    expect(await transfers.get("op-2")).toMatchObject({ status: "pending", txHash: "0x2" })
  })

  it("carries every legacy row, keyed and converted, and leaves the legacy key in place", async () => {
    const backend = memoryBackend()
    backend.entries.set(TRANSACTIONS_STORAGE_KEY, JSON.stringify(legacy))
    const transfers = open(backend)
    await transfers.ready
    const rows = new Map((await transfers.all()).map((r): [string, Transaction] => [r.id, r]))
    expect([...rows.keys()].sort()).toEqual(legacyIds)
    expect(rows.get("op-a")).toMatchObject({ failure: { code: "tx.interrupted" } })
    expect(rows.get("op-b")?.failure).toEqual({ code: "tx.failed", detail: "boom" })
    expect(rows.get("0xc")?.amountAtomic).toBe(42n)
    expect(rows.get("0xd")).toMatchObject({ amountAtomic: 10n ** 17n, toTag: "bob" })
    expect(rows.get("op-e")).toMatchObject({ flavor: "email", amountAtomic: 1_500_000n })
    for (const row of rows.values()) expect(row).not.toHaveProperty("queueId")
    expect(backend.entries.get(TRANSACTIONS_STORAGE_KEY)).toBeDefined()
    expect(backend.entries.get("acct/meta/transfers")).toBe("5")
    expect((await transfers.byHash("0xc"))?.id).toBe("0xc")
  })

  it("carries the account blob's rows where no build split them out, never over the split key", async () => {
    const account = memoryBackend()
    account.entries.set(ACCOUNT_STORAGE_KEY, JSON.stringify({ transactions: legacy }))
    expect(await ids(open(account))).toEqual(legacyIds)
    const split = memoryBackend()
    split.entries.set(ACCOUNT_STORAGE_KEY, JSON.stringify({ transactions: legacy }))
    split.entries.set(TRANSACTIONS_STORAGE_KEY, JSON.stringify([legacy[2]]))
    expect(await ids(open(split))).toEqual(["0xc"])
  })

  it("builds the indexes of rows a previous version saved, and reads the legacy key once", async () => {
    const backend = memoryBackend()
    backend.entries.set(TRANSACTIONS_STORAGE_KEY, JSON.stringify(legacy))
    backend.entries.set("acct/meta/activity", "1")
    backend.entries.set("acct/activity/0xee", encodeRecord(scanned({ txHash: "0xee" })))
    const transfers = open(backend)
    expect(await ids(transfers)).toEqual(["0xee"])
    expect((await transfers.byHash("0xee"))?.id).toBe("0xee")
  })

  it.each(["1", "4"])(
    "moves an activity store's rows at version %s to its keys in one write, and only once",
    async (version) => {
      const backend = memoryBackend()
      backend.entries.set("acct/meta/activity", version)
      backend.entries.set("acct/activity/0xee", encodeRecord(scanned({ txHash: "0xee" })))
      backend.entries.set("acct/activity.i/hash/0xee/0xee", "")
      backend.failing.commits = true
      await expect(open(backend).ready).rejects.toThrow()
      expect(backend.entries.get("acct/meta/activity")).toBe(version)

      backend.failing.commits = false
      const transfers = open(backend)
      expect(await ids(transfers)).toEqual(["0xee"])
      expect((await transfers.byHash("0xee"))?.id).toBe("0xee")
      const keys = [...backend.entries.keys()]
      expect(keys.filter((k) => k.includes("activity"))).toEqual([])
      expect(backend.entries.get("acct/meta/transfers")).toBe("5")
      const moved = new Map(backend.entries)
      await open(backend).ready
      expect(new Map(backend.entries)).toEqual(moved)
    },
  )

  it("opens empty from a malformed or missing blob", async () => {
    const backend = memoryBackend()
    backend.entries.set(TRANSACTIONS_STORAGE_KEY, "{not json")
    expect(await ids(open(backend))).toEqual([])
    expect(await ids(open())).toEqual([])
  })

  it("adds a retired rollup's rows once, failed where unfinished", async () => {
    const transfers = open()
    await transfers.record(scanned({ txHash: "0xC" }))
    expect(await transfers.importHistoricRows(legacy)).toBe(1)
    expect(await transfers.importHistoricRows(legacy)).toBe(0)
    expect((await transfers.byHash("0xd"))?.status).toBe("success")
  })

  it("moves a saved row's link out on open, and a retired rollup's on import", async () => {
    const backend = memoryBackend()
    backend.entries.set("acct/meta/activity", "3")
    backend.entries.set("acct/activity/0xl", encodeRecord(link("0xl")))
    const transfers = open(backend)
    await transfers.ready
    expect(await transfers.get("0xl")).not.toHaveProperty("payToEmailSecret")
    expect([...backend.entries.keys()].some((k) => k.startsWith("acct/activity.i/link/"))).toBe(
      false,
    )
    expect(
      await transfers.importHistoricRows([
        link("0xm", { payToEmailSecret: "0xt", paylink: "url2" }),
      ]),
    ).toBe(1)
    expect(await transfers.get("0xm")).not.toHaveProperty("paylink")
    const stored = storedTransfers({
      get: (key) => backend.entries.get(key),
      keys: (prefix) => [...backend.entries.keys()].filter((k) => k.startsWith(prefix)),
    }) as PaylinkTransaction[]
    expect(stored.map((row) => [row.id, row.payToEmailSecret]).sort()).toEqual([
      ["0xl", "0xs"],
      ["0xm", "0xt"],
    ])
  })

  it("reads a retired database's own transfers off their operations", () => {
    const send = {
      operationId: "op-s",
      flow: "send",
      summary: "",
      state: "settled",
      startedAt: 1,
      txHash: "0xs1",
      kind: "send",
      payload: { networkId: "net", token, amountAtomic: "1500000", to: "0xbob" },
    }
    const entries = new Map([["acct/operations/op-s", encodeRecord(send)]])
    const stored = storedTransfers({
      get: (key) => entries.get(key),
      keys: (prefix) => [...entries.keys()].filter((k) => k.startsWith(prefix)),
    }) as TokenTransaction[]
    expect(stored.map((row) => [row.txHash, row.action, row.to])).toEqual([
      ["0xs1", "send", "0xbob"],
    ])
  })
})
