import { describe, expect, it, vi } from "vitest"
import { RequestStorage, REQUEST_STORAGE_KEY, type PaymentRequest } from "../../src/index.js"
import { InMemoryStorageAdapter } from "../__test-helpers__/InMemoryStorageAdapter"

function request(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    id: "req-1",
    contactTag: "maria",
    amount: 10,
    asset: "DAI",
    direction: "outgoing",
    status: "pending",
    createdAt: 1_700_000_000_000,
    kind: "contact",
    ...overrides,
  }
}

describe("RequestStorage", () => {
  it("round-trips add and list", async () => {
    const store = new RequestStorage(new InMemoryStorageAdapter())
    await store.add(request())
    await store.add(request({ id: "req-2", contactTag: "theo" }))
    expect((await store.list()).map((r) => r.id)).toEqual(["req-1", "req-2"])
  })

  it("filters listForContact by tag, case-insensitively", async () => {
    const store = new RequestStorage(new InMemoryStorageAdapter())
    await store.add(request({ id: "r-maria", contactTag: "MARIA" }))
    await store.add(request({ id: "r-theo", contactTag: "theo" }))
    expect((await store.listForContact("maria")).map((r) => r.id)).toEqual(["r-maria"])
  })

  it("addIfAbsent dedupes on id", async () => {
    const store = new RequestStorage(new InMemoryStorageAdapter())
    expect(await store.addIfAbsent(request())).toEqual({ inserted: true })
    expect(await store.addIfAbsent(request({ amount: 99 }))).toEqual({ inserted: false })
    expect(await store.list()).toHaveLength(1)
    expect((await store.findById("req-1"))?.amount).toBe(10)
  })

  it("findById returns null for a missing id", async () => {
    const store = new RequestStorage(new InMemoryStorageAdapter())
    expect(await store.findById("nope")).toBeNull()
  })

  it("applies pending → declined / cancelled / fulfilled transitions", async () => {
    const store = new RequestStorage(new InMemoryStorageAdapter())
    await store.add(request({ id: "a" }))
    await store.add(request({ id: "b" }))
    await store.add(request({ id: "c" }))
    expect(await store.applyStatus("a", "declined")).toEqual({ applied: true })
    expect(await store.applyStatus("b", "cancelled")).toEqual({ applied: true })
    expect(await store.applyStatus("c", "fulfilled")).toEqual({ applied: true })
    expect((await store.list()).map((r) => r.status)).toEqual([
      "declined",
      "cancelled",
      "fulfilled",
    ])
  })

  it("fulfilled always wins; declined/cancelled only from pending; re-apply is a no-op", async () => {
    const store = new RequestStorage(new InMemoryStorageAdapter())
    await store.add(request())
    expect(await store.applyStatus("req-1", "pending")).toEqual({ applied: false })
    await store.applyStatus("req-1", "declined")
    expect(await store.applyStatus("req-1", "cancelled")).toEqual({ applied: false })
    expect(await store.applyStatus("req-1", "fulfilled")).toEqual({ applied: true })
    expect(await store.applyStatus("req-1", "declined")).toEqual({ applied: false })
    expect(await store.applyStatus("req-1", "fulfilled")).toEqual({ applied: false })
    expect((await store.findById("req-1"))?.status).toBe("fulfilled")
  })

  it("returns applied:false for an unknown id", async () => {
    const store = new RequestStorage(new InMemoryStorageAdapter())
    expect(await store.applyStatus("nope", "declined")).toEqual({ applied: false })
  })

  it("records the fulfillment tx hash on fulfill", async () => {
    const store = new RequestStorage(new InMemoryStorageAdapter())
    await store.add(request())
    await store.applyStatus("req-1", "fulfilled", "0xpay")
    expect((await store.findById("req-1"))?.fulfillmentTxHash).toBe("0xpay")
  })

  it("removes a request by id", async () => {
    const store = new RequestStorage(new InMemoryStorageAdapter())
    await store.add(request())
    await store.remove("req-1")
    expect(await store.list()).toEqual([])
  })

  it("persists across instances sharing an adapter", async () => {
    const adapter = new InMemoryStorageAdapter()
    const first = new RequestStorage(adapter)
    await first.add(request())
    await first.applyStatus("req-1", "fulfilled", "0xpay")
    const second = new RequestStorage(adapter)
    expect(await second.findById("req-1")).toMatchObject({
      id: "req-1",
      status: "fulfilled",
      fulfillmentTxHash: "0xpay",
    })
  })

  it("defaults kind to 'contact' for rows written before the field existed", async () => {
    const adapter = new InMemoryStorageAdapter()
    const legacy = request()
    delete legacy.kind
    await adapter.setItem(REQUEST_STORAGE_KEY, JSON.stringify({ requests: [legacy] }))
    const store = new RequestStorage(adapter)
    expect((await store.findById("req-1"))?.kind).toBe("contact")
  })

  it("treats corrupt or missing stored data as empty", async () => {
    const adapter = new InMemoryStorageAdapter()
    await adapter.setItem(REQUEST_STORAGE_KEY, "not-json")
    expect(await new RequestStorage(adapter).list()).toEqual([])
  })

  describe("multi-context write safety (web lock seam)", () => {
    /** Shared FIFO mutex standing in for the web `requests-write` navigator.locks lock. */
    const createSharedMutex = () => {
      let tail: Promise<unknown> = Promise.resolve()
      return <T>(fn: () => Promise<T>): Promise<T> => {
        const run = tail.then(() => fn())
        tail = run.catch(() => undefined)
        return run
      }
    }

    it("overlapping adds from two contexts both survive under the injected lock", async () => {
      const adapter = new InMemoryStorageAdapter()
      const mutex = createSharedMutex()
      const a = new RequestStorage(adapter, mutex)
      const b = new RequestStorage(adapter, mutex)

      // Both adds in flight at once; unlocked, each would read [] and the last write would win.
      await Promise.all([a.add(request({ id: "req-a" })), b.add(request({ id: "req-b" }))])

      const ids = (await new RequestStorage(adapter).list()).map((r) => r.id).sort()
      expect(ids).toEqual(["req-a", "req-b"])
    })

    it("overlapping applyStatus and add both land under the injected lock", async () => {
      const adapter = new InMemoryStorageAdapter()
      const mutex = createSharedMutex()
      const a = new RequestStorage(adapter, mutex)
      await a.add(request({ id: "req-1" }))
      const b = new RequestStorage(adapter, mutex)

      await Promise.all([
        a.applyStatus("req-1", "fulfilled", "0xpay"),
        b.add(request({ id: "req-2" })),
      ])

      const rows = await new RequestStorage(adapter).list()
      expect(rows.map((r) => r.id).sort()).toEqual(["req-1", "req-2"])
      expect(rows.find((r) => r.id === "req-1")).toMatchObject({
        status: "fulfilled",
        fulfillmentTxHash: "0xpay",
      })
    })

    it("overlapping remove and addIfAbsent both land under the injected lock", async () => {
      const adapter = new InMemoryStorageAdapter()
      const mutex = createSharedMutex()
      const a = new RequestStorage(adapter, mutex)
      await a.add(request({ id: "req-old" }))
      const b = new RequestStorage(adapter, mutex)

      await Promise.all([a.remove("req-old"), b.addIfAbsent(request({ id: "req-new" }))])

      expect((await new RequestStorage(adapter).list()).map((r) => r.id)).toEqual(["req-new"])
    })
  })

  it("notifies subscribers on writes, not reads, and not on rejected transitions", async () => {
    const store = new RequestStorage(new InMemoryStorageAdapter())
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    await store.add(request())
    expect(listener).toHaveBeenCalledTimes(1)
    await store.list()
    expect(listener).toHaveBeenCalledTimes(1)
    await store.applyStatus("req-1", "fulfilled")
    expect(listener).toHaveBeenCalledTimes(2)
    await store.applyStatus("req-1", "declined") // fulfilled is terminal — no write
    expect(listener).toHaveBeenCalledTimes(2)
    await store.remove("req-1")
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
    await store.add(request({ id: "req-2" }))
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
