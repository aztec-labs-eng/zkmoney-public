import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createTransfers,
  createPaylinks,
  fundingOf,
  recordOf,
  encodeRecord,
  loadRecords,
  memoryBackend,
  openDatabase,
  scannedRow,
  type Database,
  type MemoryBackend,
} from "@obsidion/front-core"
import {
  closeSession,
  openSession,
  openedSession,
  switchSession,
  type Namespace,
  type Session,
} from "../../src/session/session"
import { pageSessionDeps } from "../../src/app/sessionDeps"
import { testPage } from "../support/page"

// A page serves one account: every test here opens "a" as it.
const a = { id: "a", prefix: "a." }
const anonymous = { id: null, prefix: "" }

const token = {
  address: "0xt",
  name: "USD",
  symbol: "USD",
  decimals: 6,
  logo: "",
  amount: 1,
  price: 1,
}
/** A chain row, keyed by its hash. */
const chainRow = (txHash: string) => ({
  id: txHash,
  networkId: "0xnet",
  action: "send" as const,
  token,
  amountAtomic: 1_000_000n,
  timestamp: 1,
  status: "pending" as const,
  txHash,
  to: "0xb0b",
})

/** A row another writer saves under an account's namespace. */
const commitRow = (db: Database, prefix: string, txHash: string) =>
  createTransfers({ db: db.scoped(prefix), now: () => Date.now() }).record(chainRow(txHash))

const deps = pageSessionDeps(testPage())
const opened: Session[] = []
/** The namespace's session over `db`, not current. */
const sessionOn = (namespace: Namespace, db: Database) => {
  // Assigned, not spread: the deps' getters read config only when the session does.
  const open = openSession(Object.assign(deps(namespace), { database: db }))
  opened.push(open)
  return open
}

/** The database `switchSession` opens sessions over. */
const pageDb = () => deps(anonymous).database

/** A fresh page's storage. */
const page = () => {
  const backend = memoryBackend()
  return { backend, db: openDatabase(backend) }
}

afterEach(() => {
  closeSession()
  for (const open of opened.splice(0)) open.close()
  vi.restoreAllMocks()
})

describe("switchSession", () => {
  it("keeps the account's rows under its namespace", async () => {
    const { backend, db } = page()
    await sessionOn(a, db).transfers.record(chainRow("0xaa"))
    expect(backend.entries.get("a.acct/transfers/0xaa")).toBeDefined()
    expect(await sessionOn(anonymous, db).transfers.all()).toEqual([])
  })

  it("returns the open session for the same account", () => {
    const first = switchSession(a, deps)
    expect(switchSession(a, deps)).toBe(first)
    expect(openedSession.get()).toBe(first)
  })

  it("never opens another account's session on this page, and says so", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const first = switchSession(a, deps)
    expect(switchSession({ id: "b", prefix: "b." }, deps)).toBe(first)
    // Signed out in between: the page still served "a".
    closeSession()
    const open = switchSession(anonymous, deps)
    expect(switchSession({ id: "b", prefix: "b." }, deps)).toBe(open)
    expect(openedSession.get()?.namespace.id).toBeNull()
    expect(error).toHaveBeenCalledTimes(2)
  })

  it("replaces the anonymous session with the first account's, and the old one stops hearing", async () => {
    const before = switchSession(anonymous, deps)
    await vi.waitFor(() => expect(before.transfers.view.get().loaded).toBe(true))
    const after = switchSession(a, deps)
    expect(after === before).toBe(false)
    expect(openedSession.get()).toBe(after)
    await commitRow(pageDb(), "", "0xab1e")
    expect(before.transfers.view.get().records).toEqual([])
  })

  it("starts an anonymous session's bell writer only once its bell is read", async () => {
    const { db } = page()
    const open = sessionOn(anonymous, db)
    await open.transfers.record(
      scannedRow({
        networkId: "0xnet",
        action: "receive",
        txHash: "0xbacc",
        from: "alice",
        senderL2Address: "0xa11ce",
        to: "me",
        token,
        amountAtomic: 1_000_000n,
        timestamp: Date.now(),
      }),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(open.notifications.state.get().size).toBe(0)
    const stop = open.bell.subscribe(() => {})
    await vi.waitFor(() => expect(open.bell.get().sources.rows).toHaveLength(1))
    await vi.waitFor(() => expect(open.notifications.state.get().size).toBe(1))
    stop()
  })

  it("hears its namespace until it closes", async () => {
    const db = pageDb()
    const open = switchSession(a, deps)
    await vi.waitFor(() => expect(open.transfers.view.get().loaded).toBe(true))
    await commitRow(db, "a.", "0xa1")
    expect(open.transfers.view.get().records.map((r) => r.id)).toEqual(["0xa1"])
    closeSession()
    await commitRow(db, "a.", "0xa2")
    expect(open.transfers.view.get().records.map((r) => r.id)).toEqual(["0xa1"])
    expect(openedSession.get()).toBeNull()
  })

  it("carries an account's registrations with the page's side keys, and refuses a visitor's", async () => {
    const { backend, db } = page()
    const sipa = "0x00000000000000000000000000000000000000a1"
    const record = {
      account: "0xacct",
      tag: "alice",
      nameHash: "0x11",
      l2Address: "0x22",
      l1ChainId: 1,
      sipaAddress: sipa,
      fee: "10",
      beneficiary: "0xbe",
      depositToken: "0xdai",
      broadcast: true,
      phase: "awaiting_deposit",
      retries: 0,
      startTime: 1,
    }
    backend.entries.set(
      "a.@obsidion/pending-registration/records",
      JSON.stringify({ "0xacct": record }),
    )
    backend.entries.set("webwallet.registration.confirmed", JSON.stringify([sipa]))

    const account = sessionOn(a, db).registrations
    expect(await loadRecords(account.view)).toEqual([{ ...record, tagConfirmed: true }])
    const visitor = sessionOn(anonymous, db).registrations
    await visitor.ready
    await expect(visitor.apply(sipa, { type: "retried" })).rejects.toMatchObject({
      code: "wallet.notReady",
    })
  })

  describe("the bell's rows", () => {
    const DAY = 24 * 60 * 60 * 1000
    const receive = (txHash: string, timestamp: number) =>
      scannedRow({
        txHash,
        from: "alice",
        senderL2Address: "0xa11ce",
        to: "me",
        token,
        amountAtomic: 1n,
        timestamp,
        networkId: "0xnet",
      })
    /** A state row as the previous version kept it, which the store carries over at open. */
    const entry = (backend: MemoryBackend, id: string, firstSeenAt: number) => {
      backend.entries.set("a.acct/meta/notificationState", "1")
      backend.entries.set(`a.acct/notificationState/${id}`, encodeRecord({ id, firstSeenAt }))
    }
    /** The rows the bell reads, once they include one received now. */
    const bellRows = async (db: Database) => {
      const open = sessionOn(a, db)
      await open.transfers.record(receive("0xnew", Date.now()))
      const stop = open.bell.subscribe(() => {})
      const ids = () => open.bell.get().sources.rows.map((row) => row.id)
      await vi.waitFor(() => expect(ids()).toContain("0xnew"))
      stop()
      return ids().filter((id) => id !== "0xnew")
    }

    it("reach back to an unread receive, never to an older entry of another kind", async () => {
      const { db, backend } = page()
      const now = Date.now()
      const transfers = createTransfers({ db: db.scoped("a."), now: () => Date.now() })
      await transfers.record(receive("0xold", now - 3 * DAY))
      await transfers.record(receive("0xancient", now - 30 * DAY))
      entry(backend, "transfer:receive:0xold", now - 3 * DAY)
      entry(backend, "bridge:deposit:0xsipa", now - 90 * DAY)
      expect(await bellRows(db)).toEqual(["0xold"])
    })
  })
  it("reads an incoming request paid by this device's send as paid", async () => {
    const open = sessionOn(a, page().db)
    await open.requests.add({
      id: "0xreq",
      contactTag: "bob",
      amount: 1,
      amountAtomic: "1000000",
      tokenDecimals: 6,
      asset: "USD",
      direction: "incoming",
      status: "pending",
      createdAt: 1,
      kind: "contact",
    })
    await open.operations.begin({ operationId: "op-pay", flow: "send", summary: "" })
    const payload = { networkId: "0xnet", token, amountAtomic: "1000000", to: "0xb0b" }
    await open.operations.apply("op-pay", {
      type: "transfer",
      transfer: { kind: "send", payload: { ...payload, requestId: "0xreq" } },
    })
    const stop = open.requests.view.subscribe(() => {})
    await vi.waitFor(() => expect(open.requests.view.get()[0]?.status).toBe("fulfilled"))
    stop()
  })

  it("holds for Home its window and pending rows, and every link apart from its funding row", async () => {
    const { db } = page()
    const now = Date.now()
    const transfers = createTransfers({ db: db.scoped("a."), now: () => Date.now() })
    const paylinks = createPaylinks({ db: db.scoped("a."), transfers })
    const link = async (txHash: string, over: object) => {
      const row = {
        id: txHash,
        networkId: "0xnet",
        action: "Pay To Email",
        emailPaymentAction: "Pay To Email",
        flavor: "direct",
        status: "success",
        txHash,
        token,
        amountAtomic: 1n,
        timestamp: now - 90 * 24 * 60 * 60 * 1000,
        payToEmailSecret: txHash,
        ...over,
      } as never
      await paylinks.put(recordOf(row))
      await transfers.record(fundingOf(row))
    }
    await link("0xescrowed", {})
    await link("0xclaimed", { isClaimed: true, claimedAt: now - 60 * 24 * 60 * 60 * 1000 })
    for (let i = 0; i < 12; i++) {
      await transfers.record(
        scannedRow({
          networkId: "0xnet",
          txHash: `0x${i + 10}`,
          from: "alice",
          senderL2Address: "0xa11ce",
          to: "me",
          token,
          amountAtomic: 1n,
          timestamp: now - i,
        }),
      )
    }
    const open = sessionOn(a, db)
    const stop = open.feed.subscribe(() => {})
    await vi.waitFor(() => expect(open.feed.get().rows.loaded).toBe(true))
    const ids = open.feed.get().rows.records.map((row) => row.id)
    expect(ids).toHaveLength(10)
    expect(ids).not.toContain("0xescrowed")
    await vi.waitFor(() => expect(open.feed.get().links.loaded).toBe(true))
    const links = open.feed.get().links.records.map((l) => l.txHash)
    expect(links.sort()).toEqual(["0xclaimed", "0xescrowed"])
    stop()
  })
})
