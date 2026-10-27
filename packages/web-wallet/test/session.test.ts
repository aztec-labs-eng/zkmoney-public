import { afterEach, describe, expect, it, vi } from "vitest"
import { createActivity, createMemoryKv, prefixedKv, type KvStore } from "@obsidion/front-core"
import { closeSession, openSession, openedSession, session } from "../src/platform/session"
import { walletStorage } from "../src/platform/storage/walletStorage"

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
const pending = (id: string) => ({
  id,
  operationId: id,
  action: "send" as const,
  token,
  amountAtomic: 1_000_000n,
  timestamp: 1,
  status: "pending" as const,
  txHash: "",
})

/** A row another writer saves under an account's namespace. */
const commitRow = (kv: KvStore, prefix: string, id: string) =>
  createActivity({ kv: prefixedKv(kv, prefix), networkId: () => undefined }).insertPending(
    pending(id),
  )

afterEach(() => {
  closeSession()
  vi.restoreAllMocks()
})

describe("openSession", () => {
  it("keeps the account's rows under its namespace", async () => {
    const kv = createMemoryKv()
    await openSession(a, kv).activity.insertPending(pending("op-a"))
    expect(kv.getItem("a.acct/activity/op-a")).not.toBeNull()
    closeSession()
    expect(openSession(anonymous, kv).activity.rows.get()).toEqual([])
  })

  it("returns the open session for the same account", () => {
    const kv = createMemoryKv()
    const first = openSession(a, kv)
    expect(openSession(a, kv)).toBe(first)
    expect(session()).toBe(first)
  })

  it("never opens another account's session on this page, and says so", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const kv = createMemoryKv()
    const first = openSession(a, kv)
    expect(openSession({ id: "b", prefix: "b." }, kv)).toBe(first)
    // Signed out in between: the page still served "a".
    closeSession()
    const open = openSession(anonymous, kv)
    expect(openSession({ id: "b", prefix: "b." }, kv)).toBe(open)
    expect(openedSession.get()?.account.id).toBeNull()
    expect(error).toHaveBeenCalledTimes(2)
  })

  it("replaces the anonymous session with the first account's, and the old one stops hearing", async () => {
    const kv = createMemoryKv()
    const before = openSession(anonymous, kv)
    await before.activity.ready
    const after = openSession(a, kv)
    expect(after).not.toBe(before)
    expect(session()).toBe(after)
    await commitRow(kv, "", "op-late")
    expect(before.activity.rows.get()).toEqual([])
  })

  it("starts an anonymous session's bell writer only once its bell is read", async () => {
    const open = openSession(anonymous, createMemoryKv())
    open.activity.upsertScanned({
      action: "receive",
      txHash: "0xbacc",
      from: "alice",
      senderL2Address: "0xa11ce",
      to: "me",
      token,
      amountAtomic: 1_000_000n,
      timestamp: Date.now(),
    })
    await walletStorage.flush()
    await new Promise((r) => setTimeout(r, 0))
    expect(open.notifications.state.get().size).toBe(0)
    expect(open.bell.get().sources.rows).toHaveLength(1)
    await vi.waitFor(() => expect(open.notifications.state.get().size).toBe(1))
  })

  it("hears its namespace until it closes, then throws on every read", async () => {
    const kv = createMemoryKv()
    const open = openSession(a, kv)
    await open.activity.ready
    await commitRow(kv, "a.", "op-1")
    expect(open.activity.rows.get().map((r) => r.id)).toEqual(["op-1"])
    closeSession()
    await commitRow(kv, "a.", "op-2")
    expect(open.activity.rows.get().map((r) => r.id)).toEqual(["op-1"])
    expect(session).toThrow()
  })
})
