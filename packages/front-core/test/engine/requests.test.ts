import { describe, expect, it, vi } from "vitest"
import type { SIPADepositRecord } from "../../src/core/services/deposits/SIPADepositStore"
import { REQUEST_STORAGE_KEY } from "../../src/core/storages/storage-constants"
import { createActivity } from "../../src/engine/activity"
import { createMemoryKv, type KvStore } from "../../src/engine/kv"
import {
  createRequests,
  FUNDING_SKEW_MS,
  payersToApprove,
  requestTransition,
  watchPayerApprovals,
  resolveRequests,
  type RequestEvent,
  type RequestPayments,
  type RequestStatus,
  type StoredRequest,
} from "../../src/engine/requests"
import { memoryStore, derived } from "../../src/engine/store"
import type { TokenTransaction, Transaction } from "../../src/types/transactions"
import { diskKv } from "./diskKv"

const TOKEN = "0x" + "aa".repeat(32)
const TX = "0x" + "ab".repeat(32)
const REQ = "0x" + "0c".repeat(32)
const SIPA = "0xabcdef0123456789abcdef0123456789abcdef01"

const request = (over: Partial<StoredRequest> = {}): StoredRequest => ({
  id: REQ,
  contactTag: "alice",
  amount: 1,
  asset: "DAI",
  direction: "outgoing",
  status: "pending",
  createdAt: 0,
  kind: "contact",
  amountAtomic: "1000000",
  tokenDecimals: 6,
  tokenAddress: TOKEN,
  ...over,
})

const receive = (over: Partial<TokenTransaction> = {}): TokenTransaction => ({
  id: TX,
  action: "receive",
  status: "success",
  timestamp: 0,
  txHash: TX,
  from: "alice",
  senderL2Address: "0xalice",
  requestId: REQ,
  amountAtomic: 1_000_000n,
  token: { address: TOKEN, name: "DAI", symbol: "DAI", decimals: 6, logo: "", amount: 1, price: 1 },
  ...over,
})

const deposit = (over: Partial<SIPADepositRecord> = {}) =>
  ({
    sipaAddress: SIPA,
    phase: "claimed",
    amount: "1",
    netAmount: "1000000",
    claimTxHash: "0xclaim",
    ...over,
  } as SIPADepositRecord)

const resolve = (
  requests: StoredRequest[],
  rows: Transaction[] = [],
  deposits: SIPADepositRecord[] = [],
) => Object.fromEntries(resolveRequests(requests, { rows, deposits }).map((r) => [r.id, r]))

const NO_PAYMENTS: RequestPayments = { rows: [], deposits: [] }

function open(kv: KvStore = createMemoryKv(), legacyUnlisted?: () => string[]) {
  const payments = memoryStore(NO_PAYMENTS)
  return { requests: createRequests({ kv, payments: payments.readonly, legacyUnlisted }), payments }
}

describe("requests store", () => {
  it("imports the legacy blob once: a paid row stays paid, a missing kind is a contact's", async () => {
    const kv = createMemoryKv()
    const legacy = [
      { ...request({ id: "a" }), status: "fulfilled", fulfillmentTxHash: TX, kind: undefined },
      request({ id: "b", status: "declined" }),
      request({ id: "a", amount: 9 }),
    ]
    kv.setItem(REQUEST_STORAGE_KEY, JSON.stringify({ requests: legacy }))
    const { requests } = open(kv)
    await requests.ready
    expect(requests.latest("a")).toEqual({
      ...request({ id: "a" }),
      kind: "contact",
      status: "paid",
      fulfillmentTxHash: TX,
      payerApproved: true,
    })
    expect(requests.latest("b")?.status).toBe("declined")
    kv.setItem(REQUEST_STORAGE_KEY, JSON.stringify({ requests: [request({ id: "c" })] }))
    expect(
      open(kv)
        .requests.view.get()
        .map((r) => r.id),
    ).toEqual(["a", "b"])
  })

  it("flags the amountless Receive codes listed under the legacy key, once", async () => {
    const kv = createMemoryKv()
    kv.setItem("acct/meta/requests", "1")
    for (const id of ["0xCODE", "other"]) {
      kv.setItem(`acct/requests/${id}`, JSON.stringify(request({ id })))
    }
    const { requests } = open(kv, () => ["0xcode"])
    await requests.ready
    expect(requests.latest("0xCODE")?.unlisted).toBe(true)
    expect(requests.latest("other")?.unlisted).toBeUndefined()
    expect(open(kv, () => ["other"]).requests.latest("other")?.unlisted).toBeUndefined()
  })

  it("moves a request only from pending, and reminds only an outgoing one", async () => {
    const { requests } = open()
    await requests.add(request({ id: "out" }))
    await requests.add(request({ id: "in", direction: "incoming" }))
    expect(await requests.addIfAbsent(request({ id: "out" }))).toEqual({ inserted: false })
    expect(await requests.markReminded("in", 5)).toEqual({ applied: false })
    expect(await requests.markReminded("out", 5)).toEqual({ applied: true })
    expect(await requests.decline("in")).toEqual({ applied: true })
    expect(await requests.cancel("in")).toEqual({ applied: false })
    expect(await requests.cancel("missing")).toEqual({ applied: false })
    expect(requests.latest("out")?.remindedAt).toBe(5)
    await requests.remove("out")
    expect(requests.view.get().map((r) => r.id)).toEqual(["in"])
  })
})

describe("a request's short link", () => {
  it("records a request's short link", async () => {
    const { requests } = open()
    await requests.add(request({ id: "open" }))
    expect(await requests.setShortLink("open", "https://zk.money/r#seed")).toEqual({
      applied: true,
    })
    expect(await requests.setShortLink("nope", "https://zk.money/r#seed")).toEqual({
      applied: false,
    })
    expect(requests.latest("open")?.shortLink).toBe("https://zk.money/r#seed")
  })

  it("records it whatever the request reads", () => {
    const event = { type: "shortLink", shortLink: "https://zk.money/r#seed" } as const
    for (const status of ["pending", "declined", "cancelled", "paid"] as const) {
      const resolved = status === "paid" ? "fulfilled" : status
      expect(requestTransition(request({ status }), event, resolved)?.shortLink).toBe(
        event.shortLink,
      )
    }
  })
})

describe("requestTransition", () => {
  /** Each stored status with what it can resolve to. */
  const STATES: [StoredRequest["status"], RequestStatus][] = [
    ["pending", "pending"],
    ["pending", "fulfilled"],
    ["declined", "declined"],
    ["declined", "fulfilled"],
    ["cancelled", "cancelled"],
    ["cancelled", "fulfilled"],
    ["paid", "fulfilled"],
  ]
  const EVENTS: RequestEvent[] = [
    { type: "decline" },
    { type: "cancel" },
    { type: "remind", at: 7 },
  ]
  const moved = { decline: "declined", cancel: "cancelled", remind: "pending" }

  it("moves a request only while it reads pending, and reminds only an outgoing one", () => {
    for (const direction of ["outgoing", "incoming"] as const) {
      for (const [status, resolved] of STATES) {
        for (const event of EVENTS) {
          const next = requestTransition(request({ direction, status }), event, resolved)
          const applies =
            resolved === "pending" && (event.type !== "remind" || direction === "outgoing")
          expect(next?.status, `${direction} ${status}/${resolved} ${event.type}`).toBe(
            applies ? moved[event.type] : undefined,
          )
          if (applies && event.type === "remind") expect(next?.remindedAt).toBe(7)
        }
      }
    }
  })

  it("records a payer's approval once, only on a request that reads paid", () => {
    const approved = { type: "payerApproved" } as const
    for (const [status, resolved] of STATES) {
      const next = requestTransition(request({ status }), approved, resolved)
      expect(next?.payerApproved, `${status}/${resolved}`).toBe(
        resolved === "fulfilled" ? true : undefined,
      )
      if (next) expect(requestTransition(next, approved, resolved)).toBeUndefined()
    }
  })
})

describe("a payment racing a cancel", () => {
  it("keeps a request paid whether the cancel lands before the payment or after it", async () => {
    const { requests, payments } = open()
    await requests.add(request())
    await requests.add(request({ id: "late" }))
    expect(await requests.cancel(REQ)).toEqual({ applied: true })
    payments.set({
      rows: [receive(), receive({ id: "b", txHash: "0xb", requestId: "late" })],
      deposits: [],
    })
    const view = Object.fromEntries(requests.view.get().map((r) => [r.id, r]))
    expect(view[REQ]).toMatchObject({ status: "fulfilled", fulfillmentTxHash: TX })
    expect(view.late.status).toBe("fulfilled")
    for (const id of [REQ, "late"]) {
      expect(await requests.cancel(id)).toEqual({ applied: false })
      expect(await requests.decline(id)).toEqual({ applied: false })
      expect(await requests.markReminded(id, 1)).toEqual({ applied: false })
    }
    expect(requests.latest("late")?.status).toBe("pending")
  })
})

describe("resolveRequests", () => {
  it("reads an outgoing request paid by a receive carrying its id, from its contact", () => {
    expect(resolve([request()], [receive({ requestId: REQ.toUpperCase() })])[REQ]).toMatchObject({
      status: "fulfilled",
      fulfillmentTxHash: TX,
    })
    expect(resolve([request()], [receive({ from: "mallory" })])[REQ].status).toBe("pending")
    expect(resolve([request({ contactTag: "" })], [receive({ from: "x" })])[REQ].status).toBe(
      "fulfilled",
    )
  })

  it("needs the token and the whole amount, and a receive the network kept", () => {
    expect(resolve([request()], [receive({ amountAtomic: 999_999n })])[REQ].status).toBe("pending")
    const other = { ...receive().token, address: "0x" + "bb".repeat(32) }
    expect(resolve([request()], [receive({ token: other })])[REQ].status).toBe("pending")
    expect(resolve([request()], [receive({ status: "failed" })])[REQ].status).toBe("pending")
    expect(resolve([request()], [receive({ requestId: undefined })])[REQ].status).toBe("pending")
  })

  it("reads a cancelled or declined outgoing request paid once a payment reaches it", () => {
    for (const status of ["cancelled", "declined"] as const) {
      expect(resolve([request({ status })], [receive()])[REQ].status).toBe("fulfilled")
      expect(resolve([request({ status })])[REQ].status).toBe(status)
    }
  })

  it("reads an incoming request paid while a send carrying its id has not failed", () => {
    const send = receive({ action: "send", status: "pending", txHash: "" })
    const incoming = request({ direction: "incoming", status: "declined" })
    expect(resolve([incoming], [send])[REQ]).toMatchObject({ status: "fulfilled" })
    expect(resolve([incoming], [send])[REQ].fulfillmentTxHash).toBeUndefined()
    expect(resolve([incoming], [{ ...send, status: "failed" }])[REQ].status).toBe("declined")
  })

  it("pays one link per claimed deposit: the live one, else the newest cancelled", () => {
    const link = (id: string, status: StoredRequest["status"], createdAt: number) =>
      request({ id, status, createdAt, kind: "link", contactTag: "", sipaAddress: SIPA })
    const live = resolve(
      [link("old", "cancelled", 1), link("live", "pending", 0), link("older", "cancelled", 0)],
      [],
      [deposit()],
    )
    expect([live.live.status, live.old.status, live.older.status]).toEqual([
      "fulfilled",
      "cancelled",
      "cancelled",
    ])
    expect(live.live.fulfillmentTxHash).toBe("0xclaim")
    const none = resolve([link("a", "cancelled", 0), link("b", "cancelled", 1)], [], [deposit()])
    expect([none.a.status, none.b.status]).toEqual(["cancelled", "fulfilled"])
  })

  describe("a code edited at its address", () => {
    const link = (id: string, status: StoredRequest["status"], createdAt: number, amount = 1) =>
      request({
        id,
        status,
        createdAt,
        kind: "link",
        contactTag: "",
        sipaAddress: SIPA,
        amountAtomic: String(amount * 1_000_000),
      })

    it("keeps a deposit on the request it paid while the edit's replacement is minted", () => {
      const funded = deposit({ startTime: 10_000 })
      const later = 10_000 + FUNDING_SKEW_MS + 1
      const inFlight = resolve([link("a", "pending", 0), link("b", "pending", later)], [], [funded])
      expect([inFlight.a.status, inFlight.b.status]).toEqual(["fulfilled", "pending"])
      const replaced = resolve(
        [link("a", "cancelled", 0), link("b", "pending", later)],
        [],
        [funded],
      )
      expect([replaced.a.status, replaced.b.status]).toEqual(["fulfilled", "pending"])
      const swept = deposit({
        phase: "sweeping",
        claimTxHash: undefined,
        sweeps: [{ inboxIndex: "1", sweepTxHash: "0xs", netAmount: "1000000", settledAt: 10_000 }],
      })
      const past = resolve([link("a", "cancelled", 0), link("b", "pending", later)], [], [swept])
      expect([past.a.status, past.b.status]).toEqual(["fulfilled", "pending"])
    })

    it("keeps a deposit on the request it paid when the replacement is minted within the skew", () => {
      const funded = deposit({ startTime: 10_000 })
      const inFlight = resolve(
        [link("a", "pending", 0), link("b", "pending", 10_001)],
        [],
        [funded],
      )
      expect([inFlight.a.status, inFlight.b.status]).toEqual(["fulfilled", "pending"])
    })

    it("pays a replaced request that was unpaid when funded, and the live one it covers", () => {
      const stored = [link("a", "cancelled", 0), link("b", "pending", 5_000, 2)]
      const small = resolve(stored, [], [deposit({ startTime: 10_000 })])
      expect([small.a.status, small.b.status]).toEqual(["fulfilled", "pending"])
      const whole = resolve(stored, [], [deposit({ startTime: 10_000, netAmount: "2000000" })])
      expect([whole.a.status, whole.b.status]).toEqual(["cancelled", "fulfilled"])
    })

    it("pays a request minted after the funding when no earlier one fits", () => {
      const skewed = resolve([link("a", "pending", 60 * 60_000)], [], [deposit({ startTime: 0 })])
      expect(skewed.a.status).toBe("fulfilled")
    })
  })

  it("lets a past sweep pay only a request for the token it credited", () => {
    const link = request({ kind: "link", contactTag: "", sipaAddress: SIPA })
    const sweep = (l2Token: string) =>
      deposit({
        phase: "sweeping",
        claimTxHash: undefined,
        sweeps: [{ inboxIndex: "1", sweepTxHash: "0xs", netAmount: "1000000", l2Token }],
      })
    expect(resolve([link], [], [sweep("0x" + "bb".repeat(32))])[REQ].status).toBe("pending")
    expect(resolve([link], [], [sweep(TOKEN.toUpperCase())])[REQ].status).toBe("fulfilled")
  })

  it("counts a deposit's payment once, and only once it is claimed and covers the amount", () => {
    const link = request({ kind: "link", contactTag: "", sipaAddress: SIPA.toUpperCase() })
    expect(resolve([link], [], [deposit({ phase: "sweeping" })])[REQ].status).toBe("pending")
    expect(resolve([link], [], [deposit({ netAmount: "1" })])[REQ].status).toBe("pending")
    const twice = resolve([link, { ...link, id: "b" }], [], [deposit(), deposit()])
    expect([twice[REQ].status, twice.b.status]).toEqual(["fulfilled", "pending"])
    const paid = resolve(
      [link, { ...link, id: "b" }],
      [receive({ txHash: "0xclaim" })],
      [deposit()],
    )
    expect(paid.b.status).toBe("pending")
  })
})

describe("a request paid before payments were read from the chain", () => {
  async function migrated(rows: object[]) {
    const kv = createMemoryKv()
    kv.setItem(REQUEST_STORAGE_KEY, JSON.stringify({ requests: rows }))
    const { requests } = open(kv)
    await requests.ready
    return requests.view.get().map((r) => requests.latest(r.id)!)
  }

  it("stays paid with its payment on chain, under the hash the chain holds", async () => {
    const stored = await migrated([{ ...request(), status: "fulfilled", fulfillmentTxHash: TX }])
    expect(resolve(stored, [receive()])[REQ]).toMatchObject({
      status: "fulfilled",
      fulfillmentTxHash: TX,
    })
  })

  it("stays paid with no payment left to read, and is never asked for again", async () => {
    const stored = await migrated([
      { ...request(), status: "fulfilled" },
      { ...request({ id: "owed", direction: "incoming" }), status: "fulfilled" },
    ])
    const resolved = resolve(stored)
    expect([resolved[REQ].status, resolved.owed.status]).toEqual(["fulfilled", "fulfilled"])
    const { requests } = open()
    for (const row of stored) await requests.add(row)
    expect(await requests.cancel(REQ)).toEqual({ applied: false })
    expect(await requests.markReminded(REQ, 1)).toEqual({ applied: false })
  })

  it("keeps a link paid when its address is funded again", () => {
    const link = request({ kind: "link", contactTag: "", sipaAddress: SIPA })
    const sweep = { inboxIndex: "1", sweepTxHash: "0xsweep", netAmount: "1000000" } as const
    expect(
      resolve([link], [], [deposit({ sweepTxHash: "0xsweep", sweeps: [sweep] })])[REQ],
    ).toMatchObject({
      status: "fulfilled",
      fulfillmentTxHash: "0xclaim",
    })
    const fundedAgain = deposit({ phase: "sweeping", claimTxHash: undefined, sweeps: [sweep] })
    expect(resolve([link], [], [fundedAgain])[REQ]).toMatchObject({
      status: "fulfilled",
      fulfillmentTxHash: "0xsweep",
    })
  })

  it("keeps a paid link paid, and its deposit pays no other request", async () => {
    const link = { ...request({ kind: "link", contactTag: "", sipaAddress: SIPA }) }
    const stored = await migrated([
      { ...link, status: "fulfilled", fulfillmentTxHash: "0xclaim" },
      { ...link, id: "next", createdAt: 5 },
    ])
    const resolved = resolve(stored, [], [deposit()])
    expect([resolved[REQ].status, resolved.next.status]).toEqual(["fulfilled", "pending"])
  })

  it("keeps its deposit once the address is funded again: the new payment pays the next request", async () => {
    const link = { ...request({ kind: "link", contactTag: "", sipaAddress: SIPA }) }
    const stored = await migrated([
      { ...link, status: "fulfilled", fulfillmentTxHash: "0xclaim" },
      { ...link, id: "next", createdAt: 5 },
      { ...link, id: "later", createdAt: 6, status: "cancelled" },
    ])
    const sweeps = [
      { inboxIndex: "1", sweepTxHash: "0xsweep", netAmount: "1000000" },
      { inboxIndex: "2", sweepTxHash: "0xsweep2", netAmount: "1000000" },
    ]
    const fundedAgain = deposit({ claimTxHash: "0xclaim2", sweepTxHash: "0xsweep2", sweeps })
    const resolved = resolve(stored, [], [fundedAgain])
    expect(resolved.next).toMatchObject({ status: "fulfilled", fulfillmentTxHash: "0xclaim2" })
    expect(resolved.later.status).toBe("cancelled")
  })
})

describe("payersToApprove", () => {
  const payers = (requests: StoredRequest[], rows: Transaction[]) =>
    payersToApprove(resolveRequests(requests, { rows, deposits: [] }), rows)

  it("names the sender of the receive that paid an outgoing request, per request", () => {
    expect(payers([request()], [receive()])).toEqual([{ requestId: REQ, payer: "0xalice" }])
    expect(payers([request({ status: "cancelled" })], [receive()])).toHaveLength(1)
  })

  it("names nobody for a recorded approval, an unpaid, incoming, or deposit-paid request", () => {
    expect(payers([request({ payerApproved: true })], [receive()])).toEqual([])
    expect(payers([request()], [])).toEqual([])
    expect(payers([request({ direction: "incoming" })], [receive()])).toEqual([])
    const link = request({ kind: "link", contactTag: "", sipaAddress: SIPA })
    const claimed = resolveRequests([link], { rows: [], deposits: [deposit()] })
    const sameHash = receive({ txHash: "0xclaim", requestId: undefined })
    expect(payersToApprove(claimed, [sameHash])).toEqual([])
  })
})

describe("watchPayerApprovals", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve))

  /** A contacts book where `approve` makes a wallet-added contact full, as `approveAutoAdded` does. */
  function watch(kv: KvStore = createMemoryKv()) {
    const { requests, payments } = open(kv)
    const rows = memoryStore<readonly Transaction[]>([])
    const autoAdded = new Map<string, boolean>()
    const approve = vi.fn(async (address: string) => {
      if (autoAdded.has(address)) autoAdded.set(address, false)
    })
    const stop = watchPayerApprovals({ requests, rows: rows.readonly, approve })
    const receiveAll = (txs: Transaction[]) => {
      rows.set(txs)
      payments.set({ rows: txs, deposits: [] })
    }
    return { requests, receiveAll, autoAdded, approve, stop }
  }

  it("approves a newly paid request's payer once, and records it", async () => {
    const { requests, receiveAll, autoAdded, approve } = watch()
    await requests.add(request())
    autoAdded.set("0xalice", true)
    receiveAll([receive()])
    await settle()
    expect(autoAdded.get("0xalice")).toBe(false)
    expect(requests.latest(REQ)?.payerApproved).toBe(true)
    receiveAll([receive(), receive({ id: "b", txHash: "0xb", requestId: undefined })])
    await settle()
    expect(approve).toHaveBeenCalledTimes(1)
  })

  it("leaves a deleted payer that an unrelated transfer adds back as the wallet added it", async () => {
    const { requests, receiveAll, autoAdded } = watch()
    await requests.add(request())
    autoAdded.set("0xalice", true)
    receiveAll([receive()])
    await settle()
    // Deleted, then added back by a transfer that pays no request.
    autoAdded.set("0xalice", true)
    receiveAll([receive(), receive({ id: "b", txHash: "0xb", requestId: undefined })])
    await settle()
    expect(autoAdded.get("0xalice")).toBe(true)
  })

  it("approves again on the next change after an approval failed, and stops when told", async () => {
    const { requests, receiveAll, approve, stop } = watch()
    approve.mockRejectedValueOnce(new Error("locked"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await requests.add(request())
    receiveAll([receive()])
    await settle()
    expect(requests.latest(REQ)?.payerApproved).toBeUndefined()
    receiveAll([receive(), receive({ id: "b", txHash: "0xb", requestId: undefined })])
    await settle()
    expect(approve).toHaveBeenCalledTimes(2)
    expect(requests.latest(REQ)?.payerApproved).toBe(true)
    stop()
    await requests.add(request({ id: "next" }))
    receiveAll([receive(), receive({ id: "c", txHash: "0xc", requestId: "next" })])
    await settle()
    expect(approve).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it("never approves the payer of a request paid before the migration", async () => {
    const kv = createMemoryKv()
    const paid = { ...request(), status: "fulfilled", fulfillmentTxHash: TX }
    kv.setItem(REQUEST_STORAGE_KEY, JSON.stringify({ requests: [paid] }))
    const { requests, receiveAll, approve } = watch(kv)
    await requests.ready
    receiveAll([receive()])
    await settle()
    expect(approve).not.toHaveBeenCalled()
  })

  it("approves only from a saved payment: a receive whose save failed names no one until saved", async () => {
    const disk = diskKv()
    const activity = createActivity({ kv: disk.kv, networkId: () => "net" })
    const payments = derived([activity.rows], (rows) => ({ rows, deposits: [] }))
    const requests = createRequests({ kv: disk.kv, payments })
    await requests.add(request())
    const approve = vi.fn(async () => undefined)
    watchPayerApprovals({ requests, rows: activity.rows, approve })
    const { txHash, from, senderL2Address, requestId, amountAtomic, token, timestamp } = receive()
    const payment = {
      txHash,
      from,
      senderL2Address,
      to: "me",
      requestId,
      amountAtomic,
      token,
      timestamp,
    }
    const scan = () => disk.kv.batch(() => activity.upsertScanned(payment))
    disk.fail(true)
    await expect(scan()).rejects.toThrow("disk")
    expect(approve).not.toHaveBeenCalled()
    disk.fail(false)
    await scan()
    expect(approve).toHaveBeenCalledWith("0xalice")
  })
})

describe("requests: writes in flight", () => {
  it("moves a request from its latest write, and shows it once saved", async () => {
    const disk = diskKv()
    const { requests } = open(disk.kv)
    await requests.add(request())
    disk.hold(true)
    const declining = requests.decline(REQ)
    expect(requests.latest(REQ)?.status).toBe("declined")
    expect(requests.view.get()[0].status).toBe("pending")
    expect(await requests.cancel(REQ)).toEqual({ applied: false })
    await disk.land()
    expect(await declining).toEqual({ applied: true })
    expect(requests.view.get()[0].status).toBe("declined")
  })

  it("keeps nothing of a failed write: the request reads as it was saved", async () => {
    const disk = diskKv()
    const { requests } = open(disk.kv)
    await requests.add(request())
    disk.fail(true)
    await expect(requests.decline(REQ)).rejects.toThrow("disk")
    expect(requests.latest(REQ)?.status).toBe("pending")
    expect(requests.view.get()[0].status).toBe("pending")
  })
})
