import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DeferredSetItemAdapter } from "../../__test-helpers__/DeferredSetItemAdapter"
import { InMemoryStorageAdapter } from "../../__test-helpers__/InMemoryStorageAdapter"
import { RecordStorage } from "../../../src/core/services/bridge/RecordStorage"

type TRec = { id: string; value: number }

const STORAGE_KEY = "@test/records"
const LABEL = "TestStorage"

const keyOf = (r: TRec) => r.id.toLowerCase()
const sortBy = (r: TRec) => r.value

function makeStore(adapter: InMemoryStorageAdapter | DeferredSetItemAdapter): RecordStorage<TRec> {
  return new RecordStorage<TRec>({
    storage: adapter,
    storageKey: STORAGE_KEY,
    keyOf,
    sortBy,
    label: LABEL,
  })
}

/**
 * Drain all pending microtasks by yielding to the macrotask queue. Used in the
 * persistChain tests to advance the chain past `await load()` yields, the
 * `.catch().then()` microtasks, and the async `doPersist` entry. One `setTimeout(0)`
 * drain is robust to any number of microtask-level yields in the chain.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe("RecordStorage", () => {
  describe("load", () => {
    it("when storage is empty, marks loaded and emits one listChanged with empty list", async () => {
      const adapter = new InMemoryStorageAdapter()
      const store = makeStore(adapter)
      const listener = vi.fn()
      store.onListChanged(listener)

      await store.load()

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenLastCalledWith([])
      expect(store.list()).toEqual([])
    })

    it("when storage has pre-existing records, hydrates all and emits listChanged once", async () => {
      const adapter = new InMemoryStorageAdapter()
      await adapter.setItem(
        STORAGE_KEY,
        JSON.stringify({
          a: { id: "a", value: 1 },
          b: { id: "b", value: 2 },
        }),
      )
      const store = makeStore(adapter)
      const listener = vi.fn()
      store.onListChanged(listener)

      await store.load()

      expect(listener).toHaveBeenCalledTimes(1)
      const hydrated = listener.mock.calls[0]?.[0] as TRec[]
      expect(hydrated).toHaveLength(2)
      expect(hydrated.map((r) => r.id).sort()).toEqual(["a", "b"])
    })

    it("when load is called concurrently before first resolve, dedupes via shared loadPromise", async () => {
      const adapter = new InMemoryStorageAdapter()
      const getItemSpy = vi.spyOn(adapter, "getItem")
      const store = makeStore(adapter)

      await Promise.all([store.load(), store.load(), store.load()])

      expect(getItemSpy).toHaveBeenCalledTimes(1)
    })

    it("when storage getItem throws, swallows the error, marks loaded, still emits listChanged", async () => {
      const adapter = new InMemoryStorageAdapter()
      vi.spyOn(adapter, "getItem").mockRejectedValueOnce(new Error("disk"))
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const store = makeStore(adapter)
      const listener = vi.fn()
      store.onListChanged(listener)

      await store.load()

      expect(store.list()).toEqual([])
      expect(listener).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalled()

      // Subsequent load is a no-op (already marked loaded).
      await store.load()
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })

  describe("setRecord", () => {
    it("when the key is new, inserts, persists, emits updated and listChanged", async () => {
      const adapter = new InMemoryStorageAdapter()
      const store = makeStore(adapter)
      await store.load()

      const updated = vi.fn()
      const listChanged = vi.fn()
      store.onUpdated(updated)
      store.onListChanged(listChanged)

      const record: TRec = { id: "a", value: 1 }
      await store.setRecord("a", record)

      expect(store.getByKey("a")).toEqual(record)
      expect(updated).toHaveBeenCalledWith(record)
      expect(listChanged).toHaveBeenCalledWith([record])

      const raw = await adapter.getItem(STORAGE_KEY)
      expect(raw).not.toBeNull()
      expect(JSON.parse(raw as string)).toEqual({ a: record })
    })

    it("when the key already exists, replaces the record and emits both events", async () => {
      const adapter = new InMemoryStorageAdapter()
      const store = makeStore(adapter)
      await store.load()
      await store.setRecord("a", { id: "a", value: 1 })

      const updated = vi.fn()
      const listChanged = vi.fn()
      store.onUpdated(updated)
      store.onListChanged(listChanged)

      const next: TRec = { id: "a", value: 2 }
      await store.setRecord("a", next)

      expect(store.getByKey("a")).toEqual(next)
      expect(updated).toHaveBeenCalledWith(next)
      expect(listChanged).toHaveBeenCalledTimes(1)
    })
  })

  describe("updateRecord", () => {
    it("on a loaded store, applies the update before the call returns", async () => {
      const store = makeStore(new InMemoryStorageAdapter())
      await store.setRecord("a", { id: "a", value: 1 })

      const pending = store.updateRecord("a", (current) => current && { ...current, value: 2 })

      expect(store.getByKey("a")).toEqual({ id: "a", value: 2 })
      await pending
    })

    it("on a store not yet loaded, updates what storage holds", async () => {
      const adapter = new InMemoryStorageAdapter()
      await adapter.setItem(STORAGE_KEY, JSON.stringify({ a: { id: "a", value: 1 } }))
      const store = makeStore(adapter)

      await store.updateRecord(
        "a",
        (current) => current && { ...current, value: current.value + 1 },
      )

      expect(store.getByKey("a")).toEqual({ id: "a", value: 2 })
    })
  })

  describe("rekey", () => {
    it("when oldKey differs from newKey, deletes oldKey and sets newKey in a single persist", async () => {
      const adapter = new InMemoryStorageAdapter()
      const store = makeStore(adapter)
      await store.load()
      await store.setRecord("old", { id: "old", value: 1 })

      const moved: TRec = { id: "new", value: 1 }
      await store.rekey("old", "new", moved)

      expect(store.getByKey("old")).toBeNull()
      expect(store.getByKey("new")).toEqual(moved)

      // Persisted blob should only contain the new key.
      const raw = await adapter.getItem(STORAGE_KEY)
      const persisted = JSON.parse(raw as string)
      expect(Object.keys(persisted)).toEqual(["new"])

      // A fresh instance pointing at the same adapter should see only the new key.
      const fresh = makeStore(adapter)
      await fresh.load()
      expect(fresh.getByKey("old")).toBeNull()
      expect(fresh.getByKey("new")).toEqual(moved)
    })

    it("when oldKey equals newKey, behaves like setRecord with no delete", async () => {
      const adapter = new InMemoryStorageAdapter()
      const store = makeStore(adapter)
      await store.load()
      await store.setRecord("a", { id: "a", value: 1 })

      const next: TRec = { id: "a", value: 2 }
      await store.rekey("a", "a", next)

      expect(store.getByKey("a")).toEqual(next)
    })
  })

  describe("removeByKey", () => {
    it("when the key exists, deletes, persists, emits listChanged", async () => {
      const adapter = new InMemoryStorageAdapter()
      const store = makeStore(adapter)
      await store.load()
      await store.setRecord("a", { id: "a", value: 1 })

      const listChanged = vi.fn()
      store.onListChanged(listChanged)

      await store.removeByKey("a")

      expect(store.getByKey("a")).toBeNull()
      expect(listChanged).toHaveBeenCalledWith([])
    })

    it("when the key does not exist, is a no-op with no persist and no emit", async () => {
      const adapter = new InMemoryStorageAdapter()
      const store = makeStore(adapter)
      await store.load()

      const setItemSpy = vi.spyOn(adapter, "setItem")
      const removeItemSpy = vi.spyOn(adapter, "removeItem")
      const listChanged = vi.fn()
      store.onListChanged(listChanged)

      await store.removeByKey("missing")

      expect(setItemSpy).not.toHaveBeenCalled()
      expect(removeItemSpy).not.toHaveBeenCalled()
      expect(listChanged).not.toHaveBeenCalled()
    })
  })

  describe("clearAll", () => {
    it("empties the map, calls removeItem, emits listChanged with empty list", async () => {
      const adapter = new InMemoryStorageAdapter()
      const store = makeStore(adapter)
      await store.load()
      await store.setRecord("a", { id: "a", value: 1 })
      await store.setRecord("b", { id: "b", value: 2 })

      const removeItemSpy = vi.spyOn(adapter, "removeItem")
      const listChanged = vi.fn()
      store.onListChanged(listChanged)

      await store.clearAll()

      expect(store.list()).toEqual([])
      expect(removeItemSpy).toHaveBeenCalledWith(STORAGE_KEY)
      expect(listChanged).toHaveBeenCalledWith([])
    })

    it("followed by setRecord on the same instance persists only the new record with no resurrection", async () => {
      const adapter = new InMemoryStorageAdapter()
      const store = makeStore(adapter)
      await store.load()
      await store.setRecord("a", { id: "a", value: 1 })
      await store.setRecord("b", { id: "b", value: 2 })
      await store.clearAll()

      await store.setRecord("c", { id: "c", value: 3 })

      expect(store.list()).toEqual([{ id: "c", value: 3 }])

      // A fresh instance should see only 'c', not the pre-clear records.
      const fresh = makeStore(adapter)
      await fresh.load()
      expect(fresh.list()).toEqual([{ id: "c", value: 3 }])
    })
  })

  describe("persist round trip", () => {
    it("when records are written and a fresh instance loads the same adapter, hydrates identically", async () => {
      const adapter = new InMemoryStorageAdapter()
      const writer = makeStore(adapter)
      await writer.load()
      await writer.setRecord("a", { id: "a", value: 1 })
      await writer.setRecord("b", { id: "b", value: 2 })

      const reader = makeStore(adapter)
      await reader.load()

      const sorted = reader.list().sort((a, b) => a.id.localeCompare(b.id))
      expect(sorted).toEqual([
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ])
    })
  })

  describe("persist serialization via persistChain", () => {
    it("when three setRecord calls race, setItem invocations fire in submission order one at a time", async () => {
      const adapter = new DeferredSetItemAdapter()
      const store = makeStore(adapter)
      await store.load()

      // Issue three concurrent setRecord calls. Don't await.
      void store.setRecord("a", { id: "a", value: 1 })
      void store.setRecord("b", { id: "b", value: 2 })
      void store.setRecord("c", { id: "c", value: 3 })

      // Drain microtasks so the first doPersist fires.
      await flushMicrotasks()
      expect(adapter.pendingSetItems.map((p) => p.key)).toEqual([STORAGE_KEY])

      // Flush the first; second should queue.
      adapter.flushOne()
      await flushMicrotasks()
      expect(adapter.pendingSetItems.map((p) => p.key)).toEqual([STORAGE_KEY])

      // Flush the second; third should queue.
      adapter.flushOne()
      await flushMicrotasks()
      expect(adapter.pendingSetItems.map((p) => p.key)).toEqual([STORAGE_KEY])

      // Flush the third; queue empties.
      adapter.flushOne()
      await flushMicrotasks()
      expect(adapter.pendingSetItems).toHaveLength(0)

      // Final persisted blob should contain all three records.
      const raw = await adapter.getItem(STORAGE_KEY)
      const persisted = JSON.parse(raw as string)
      expect(Object.keys(persisted).sort()).toEqual(["a", "b", "c"])
    })

    it("when an earlier persist throws via failOne, the chain survives and a subsequent setRecord persists", async () => {
      const adapter = new DeferredSetItemAdapter()
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const store = makeStore(adapter)
      await store.load()

      void store.setRecord("a", { id: "a", value: 1 })
      await flushMicrotasks()
      expect(adapter.pendingSetItems).toHaveLength(1)

      // Fail the first write.
      adapter.failOne(new Error("disk full"))
      await flushMicrotasks()

      // Chain must not be poisoned — a second setRecord should still produce a pending write.
      void store.setRecord("b", { id: "b", value: 2 })
      await flushMicrotasks()
      expect(adapter.pendingSetItems.map((p) => p.key)).toEqual([STORAGE_KEY])

      adapter.flushOne()
      await flushMicrotasks()
      expect(warnSpy).toHaveBeenCalled() // persist() warns on the failed write
    })

    it("negative control: three direct setItem calls bypassing RecordStorage produce three pending entries synchronously", async () => {
      const adapter = new DeferredSetItemAdapter()

      void adapter.setItem("a", "1")
      void adapter.setItem("b", "2")
      void adapter.setItem("c", "3")

      // No microtask drain — entries must be observable synchronously.
      expect(adapter.pendingSetItems).toHaveLength(3)
      expect(adapter.pendingSetItems.map((p) => p.key)).toEqual(["a", "b", "c"])
    })

    it("drain validation: flushOne resolves and splices, so a subsequent setItem leaves length at one", async () => {
      const adapter = new DeferredSetItemAdapter()

      const first = adapter.setItem("a", "1")
      expect(adapter.pendingSetItems).toHaveLength(1)

      adapter.flushOne()
      await first
      expect(adapter.pendingSetItems).toHaveLength(0)

      void adapter.setItem("b", "2")
      expect(adapter.pendingSetItems).toHaveLength(1)
      expect(adapter.pendingSetItems[0]?.key).toBe("b")
    })
  })

  describe("listeners", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    })

    afterEach(() => {
      warnSpy.mockRestore()
    })

    it("when an onUpdated listener throws, other onUpdated listeners still fire, mutation completes, console.warn is called", async () => {
      const adapter = new InMemoryStorageAdapter()
      const store = makeStore(adapter)
      await store.load()

      const first = vi.fn()
      const second = vi.fn(() => {
        throw new Error("boom")
      })
      const third = vi.fn()
      store.onUpdated(first)
      store.onUpdated(second)
      store.onUpdated(third)

      const record: TRec = { id: "a", value: 1 }
      await store.setRecord("a", record)

      expect(first).toHaveBeenCalledWith(record)
      expect(third).toHaveBeenCalledWith(record)
      expect(store.getByKey("a")).toEqual(record)
      expect(warnSpy).toHaveBeenCalled()
      const warnMsg = warnSpy.mock.calls[0]?.[0] as string
      expect(warnMsg).toContain(`[${LABEL}]`)
    })

    it("when an onListChanged listener throws, other onListChanged listeners still fire and console.warn is called", async () => {
      const adapter = new InMemoryStorageAdapter()
      const store = makeStore(adapter)
      await store.load()

      const first = vi.fn()
      const second = vi.fn(() => {
        throw new Error("boom")
      })
      const third = vi.fn()
      store.onListChanged(first)
      store.onListChanged(second)
      store.onListChanged(third)

      await store.setRecord("a", { id: "a", value: 1 })

      expect(first).toHaveBeenCalled()
      expect(third).toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalled()
      const warnMsg = warnSpy.mock.calls[0]?.[0] as string
      expect(warnMsg).toContain(`[${LABEL}]`)
    })

    it("when unsubscribe is called, the listener receives no subsequent events", async () => {
      const adapter = new InMemoryStorageAdapter()
      const store = makeStore(adapter)
      await store.load()

      const updated = vi.fn()
      const unsubscribe = store.onUpdated(updated)

      await store.setRecord("a", { id: "a", value: 1 })
      expect(updated).toHaveBeenCalledTimes(1)

      unsubscribe()
      await store.setRecord("b", { id: "b", value: 2 })
      expect(updated).toHaveBeenCalledTimes(1)
    })
  })
})

/** Fails the next `failNext` writes, then behaves. */
class FlakyAdapter extends InMemoryStorageAdapter {
  failNext = 0
  override async setItem(key: string, value: string): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--
      throw new Error("QuotaExceededError")
    }
    return super.setItem(key, value)
  }
}

describe("RecordStorage strict rollback", () => {
  const strictStore = (adapter: FlakyAdapter) =>
    new RecordStorage<TRec>({ storage: adapter, storageKey: STORAGE_KEY, keyOf, label: LABEL, strict: true })

  it("leaves a newer write that landed meanwhile untouched when an older write is rejected", async () => {
    const adapter = new FlakyAdapter()
    const store = strictStore(adapter)
    await store.setRecord("a", { id: "a", value: 0 })
    adapter.failNext = 1
    const older = store.setRecord("a", { id: "a", value: 1 })
    const newer = store.setRecord("a", { id: "a", value: 2 })
    await expect(older).rejects.toThrow("QuotaExceededError")
    await newer
    expect(store.getByKey("a")).toEqual({ id: "a", value: 2 })
    expect(JSON.parse((await adapter.getItem(STORAGE_KEY))!).a).toEqual({ id: "a", value: 2 })
  })

  it("returns the key to what storage holds when every pending write is rejected", async () => {
    const adapter = new FlakyAdapter()
    const store = strictStore(adapter)
    await store.setRecord("a", { id: "a", value: 0 })
    adapter.failNext = 2
    const older = store.setRecord("a", { id: "a", value: 1 })
    const newer = store.updateRecord("a", (current) => ({ id: "a", value: (current?.value ?? 0) + 10 }))
    await expect(older).rejects.toThrow()
    await expect(newer).rejects.toThrow()
    expect(store.getByKey("a")).toEqual({ id: "a", value: 0 })
    expect(JSON.parse((await adapter.getItem(STORAGE_KEY))!).a).toEqual({ id: "a", value: 0 })
  })

  it("rolls a rejected write back to what the last write serialized, not to a value that only landed in memory", async () => {
    const adapter = new DeferredSetItemAdapter()
    const store = new RecordStorage<TRec>({
      storage: adapter,
      storageKey: STORAGE_KEY,
      keyOf,
      label: LABEL,
      strict: true,
    })
    const first = store.setRecord("a", { id: "a", value: 1 })
    await flushMicrotasks()
    // A second write lands in memory while the first one's setItem is still in flight.
    const second = store.setRecord("a", { id: "a", value: 2 })
    await flushMicrotasks()
    expect(adapter.pendingSetItems).toHaveLength(1)
    adapter.flushOne()
    await first
    await flushMicrotasks()
    expect(adapter.pendingSetItems).toHaveLength(1)
    adapter.failOne(new Error("QuotaExceededError"))
    await expect(second).rejects.toThrow("QuotaExceededError")
    // Storage holds value 1; memory must say the same, never the value 2 that never landed.
    expect(store.getByKey("a")).toEqual({ id: "a", value: 1 })
    expect(JSON.parse((await adapter.getItem(STORAGE_KEY))!).a).toEqual({ id: "a", value: 1 })
  })

  it("drops a first write that never persisted", async () => {
    const adapter = new FlakyAdapter()
    const store = strictStore(adapter)
    adapter.failNext = 1
    await expect(store.setRecord("a", { id: "a", value: 1 })).rejects.toThrow()
    expect(store.getByKey("a")).toBeNull()
  })
})
