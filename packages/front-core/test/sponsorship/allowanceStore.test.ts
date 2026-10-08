/**
 * The signed-in account's allowance. It belongs to one account on one deployment: switching either
 * clears it before a new read lands, and a late answer for the old one is dropped.
 */
import { describe, expect, it, vi } from "vitest"
import type { ClaimFpcAllowance } from "@obsidion/sdk"
import {
  SponsoredAllowanceStore,
  type AllowanceRead,
  type AllowanceUsage,
} from "../../src/core/sponsorship"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const read = (allowance: Partial<ClaimFpcAllowance>): AllowanceRead => ({
  fpcAddress: "0xf9c",
  railId: 1,
  allowance: { subscribed: true, uses: 0, maxTx: 100, refillPeriod: 86_400, ...allowance },
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("SponsoredAllowanceStore", () => {
  it("starts signed out and loads when an account scope arrives", async () => {
    const store = new SponsoredAllowanceStore()
    expect(store.getSnapshot()).toEqual({ status: "signed-out" })
    store.setScope({ key: "alice|v1", read: async () => read({ uses: 5 }) })
    expect(store.getSnapshot()).toEqual({ status: "loading", scope: "alice|v1" })
    await flush()
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      scope: "alice|v1",
      state: { kind: "available", available: 5 },
    })
  })

  it("clears on an account change and drops the old account's late answer", async () => {
    const store = new SponsoredAllowanceStore()
    const alice = deferred<AllowanceRead>()
    store.setScope({ key: "alice|v1", read: () => alice.promise })
    store.setScope({
      key: "bob|v1",
      read: async () => read({ subscribed: false }),
    })
    expect(store.getSnapshot()).toEqual({ status: "loading", scope: "bob|v1" })
    await flush()
    alice.resolve(read({ uses: 9 }))
    await flush()
    expect(store.getSnapshot()).toMatchObject({
      scope: "bob|v1",
      state: { kind: "not-subscribed" },
    })
  })

  it("clears on a deployment change", async () => {
    const store = new SponsoredAllowanceStore()
    store.setScope({ key: "alice|v1", read: async () => read({ uses: 9 }) })
    await flush()
    store.setScope({ key: "alice|v2", read: () => new Promise(() => {}) })
    expect(store.getSnapshot()).toEqual({ status: "loading", scope: "alice|v2" })
  })

  it("forgets the account on sign-out", async () => {
    const store = new SponsoredAllowanceStore()
    store.setScope({ key: "alice|v1", read: async () => read({ uses: 9 }) })
    await flush()
    store.setScope(undefined)
    expect(store.getSnapshot()).toEqual({ status: "signed-out" })
  })

  it("does not notify when a signed-out store is told it is signed out", () => {
    const store = new SponsoredAllowanceStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.setScope(undefined)
    expect(listener).not.toHaveBeenCalled()
  })

  it("keeps the read when the same scope re-renders with a new reader", async () => {
    const store = new SponsoredAllowanceStore()
    const first = vi.fn(async () => read({ uses: 9 }))
    store.setScope({ key: "alice|v1", read: first })
    await flush()
    const second = vi.fn(async () => read({ uses: 8 }))
    store.setScope({ key: "alice|v1", read: second })
    expect(store.getSnapshot()).toMatchObject({ status: "ready", state: { available: 9 } })
    expect(second).not.toHaveBeenCalled()
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: "ready", state: { available: 8 } })
  })

  it("reports a failed read as unavailable rather than as zero", async () => {
    const store = new SponsoredAllowanceStore()
    store.setScope({
      key: "alice|v1",
      read: async () => {
        throw new Error("PXE is busy")
      },
    })
    await flush()
    expect(store.getSnapshot()).toMatchObject({ status: "unavailable", scope: "alice|v1" })
  })

  it("shares one read between concurrent refreshes", async () => {
    const store = new SponsoredAllowanceStore()
    const reader = vi.fn(async () => read({ uses: 2 }))
    store.setScope({ key: "alice|v1", read: reader })
    await Promise.all([store.refresh(), store.refresh()])
    expect(reader).toHaveBeenCalledTimes(1)
  })

  it("forgets the account when the last subscriber leaves", async () => {
    const store = new SponsoredAllowanceStore()
    const first = store.subscribe(() => {})
    const second = store.subscribe(() => {})
    store.setScope({ key: "alice|v1", read: async () => read({ uses: 3 }) })
    await flush()
    first()
    expect(store.getSnapshot()).toMatchObject({ status: "ready", scope: "alice|v1" })
    second()
    expect(store.getSnapshot()).toEqual({ status: "signed-out" })
  })

  it("marks a ready read as refreshing while a new read runs, and clears the mark when it lands", async () => {
    const store = new SponsoredAllowanceStore()
    const next = deferred<AllowanceRead>()
    const reads = [async () => read({ refillPeriod: 0 }), () => next.promise]
    store.setScope({ key: "alice|v1", read: () => reads.shift()!() })
    await flush()
    const refreshing = store.refresh()
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      state: { kind: "does-not-renew" },
      refreshing: true,
    })
    next.resolve(read({ uses: 4 }))
    await refreshing
    expect(store.getSnapshot()).toMatchObject({ state: { kind: "available" }, refreshing: false })
  })

  it("drops an obsolete read after the scope goes A → B → A, whether it lands before or after the new one", async () => {
    const store = new SponsoredAllowanceStore()
    const oldA = deferred<AllowanceRead>()
    const newA = deferred<AllowanceRead>()
    store.setScope({ key: "alice|v1", read: () => oldA.promise })
    store.setScope({ key: "bob|v1", read: () => new Promise(() => {}) })
    store.setScope({ key: "alice|v1", read: () => newA.promise })

    oldA.resolve(read({ uses: 9 }))
    await flush()
    expect(store.getSnapshot()).toEqual({ status: "loading", scope: "alice|v1" })

    newA.resolve(read({ uses: 2 }))
    await flush()
    expect(store.getSnapshot()).toMatchObject({ status: "ready", state: { available: 2 } })
  })

  it("drops an obsolete read that lands after the new activation's read", async () => {
    const store = new SponsoredAllowanceStore()
    const oldA = deferred<AllowanceRead>()
    store.setScope({ key: "alice|v1", read: () => oldA.promise })
    store.setScope({ key: "bob|v1", read: () => new Promise(() => {}) })
    store.setScope({ key: "alice|v1", read: async () => read({ uses: 2 }) })
    await flush()
    oldA.resolve(read({ refillPeriod: 0 }))
    await flush()
    expect(store.getSnapshot()).toMatchObject({ status: "ready", state: { kind: "available" } })
  })

  it("drops an obsolete failure after the scope goes A → B → A", async () => {
    const store = new SponsoredAllowanceStore()
    const oldA = deferred<AllowanceRead>()
    store.setScope({ key: "alice|v1", read: () => oldA.promise })
    store.setScope({ key: "bob|v1", read: () => new Promise(() => {}) })
    store.setScope({ key: "alice|v1", read: async () => read({ uses: 2 }) })
    await flush()
    oldA.reject(new Error("PXE is busy"))
    await flush()
    expect(store.getSnapshot()).toMatchObject({ status: "ready", state: { available: 2 } })
  })

  it("drops a read from before the last subscriber left when the same account comes back", async () => {
    const store = new SponsoredAllowanceStore()
    const before = deferred<AllowanceRead>()
    const after = deferred<AllowanceRead>()
    const leave = store.subscribe(() => {})
    store.setScope({ key: "alice|v1", read: () => before.promise })
    leave()
    store.subscribe(() => {})
    store.setScope({ key: "alice|v1", read: () => after.promise })

    before.resolve(read({ refillPeriod: 0 }))
    await flush()
    expect(store.getSnapshot()).toEqual({ status: "loading", scope: "alice|v1" })
    after.resolve(read({ uses: 4 }))
    await flush()
    expect(store.getSnapshot()).toMatchObject({ status: "ready", state: { available: 4 } })
  })

  it("keeps a pending read when the same scope only swaps its reader", async () => {
    const store = new SponsoredAllowanceStore()
    const pending = deferred<AllowanceRead>()
    store.setScope({ key: "alice|v1", read: () => pending.promise })
    store.setScope({ key: "alice|v1", read: async () => read({ uses: 1 }) })
    pending.resolve(read({ uses: 6 }))
    await flush()
    expect(store.getSnapshot()).toMatchObject({ status: "ready", state: { available: 6 } })
  })

  describe("usage split", () => {
    const usageOf = (store: SponsoredAllowanceStore) => {
      const snapshot = store.getSnapshot()
      return snapshot.status === "ready" ? snapshot.read.usage : "not ready"
    }

    it("shows the count before the split lands, then adds it", async () => {
      const store = new SponsoredAllowanceStore()
      const split = deferred<AllowanceUsage | undefined>()
      store.setScope({
        key: "alice|v1",
        read: async () => read({ uses: 5 }),
        readUsage: () => split.promise,
      })
      await flush()
      expect(store.getSnapshot()).toMatchObject({ status: "ready", state: { available: 5 } })
      expect(usageOf(store)).toBeUndefined()

      split.resolve({ yours: 3, depositAddresses: 2 })
      await flush()
      expect(usageOf(store)).toEqual({ yours: 3, depositAddresses: 2 })
    })

    it("keeps the last split through a refresh and drops a split for a replaced read", async () => {
      const store = new SponsoredAllowanceStore()
      const splits = [
        deferred<AllowanceUsage | undefined>(),
        deferred<AllowanceUsage | undefined>(),
      ]
      let call = 0
      store.setScope({
        key: "alice|v1",
        read: async () => read({ uses: 5 - call }),
        readUsage: () => splits[call++]!.promise,
      })
      await flush()
      splits[0]!.resolve({ yours: 3, depositAddresses: 2 })
      await flush()

      await store.refresh()
      expect(store.getSnapshot()).toMatchObject({ state: { available: 4 } })
      expect(usageOf(store)).toEqual({ yours: 3, depositAddresses: 2 })

      splits[1]!.resolve({ yours: 3, depositAddresses: 3 })
      await flush()
      expect(usageOf(store)).toEqual({ yours: 3, depositAddresses: 3 })
    })

    it("keeps the count when the split fails", async () => {
      const store = new SponsoredAllowanceStore()
      store.setScope({
        key: "alice|v1",
        read: async () => read({ uses: 5 }),
        readUsage: async () => {
          throw new Error("PXE sync failed")
        },
      })
      await flush()
      await flush()
      expect(store.getSnapshot()).toMatchObject({ status: "ready", state: { available: 5 } })
      expect(usageOf(store)).toBeUndefined()
    })
  })
})
