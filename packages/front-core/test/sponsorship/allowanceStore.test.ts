/**
 * One session's allowance: each reader that opens reads it again over the last count, and readers
 * open together share one read.
 */
import { describe, expect, it, vi } from "vitest"
import { createPace } from "@obsidion/core/cadence"
import type { ClaimFpcAllowance } from "@obsidion/sdk"
import { queries } from "../../src/engine/query"
import { memoryStore } from "../../src/engine/store"
import {
  sponsoredAllowance,
  type AllowanceRead,
  type AllowanceUsage,
  type SponsoredAllowance,
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
  payer: "0xalice",
  allowance: { subscribed: true, uses: 0, maxTx: 100, refillPeriod: 86_400, ...allowance },
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const query = () =>
  queries({ pace: createPace(), visible: memoryStore(true).readonly, now: () => Date.now() })
const noUsage = async (): Promise<AllowanceUsage | undefined> => undefined
const listen = (allowance: SponsoredAllowance) => allowance.snapshot.subscribe(() => {})

describe("sponsoredAllowance", () => {
  it("reads nothing until a reader comes, then reads once for each reader that opens", async () => {
    const fetch = vi.fn(async () => read({ uses: 5 }))
    const allowance = sponsoredAllowance(query(), fetch, noUsage)
    expect(fetch).not.toHaveBeenCalled()
    const off = listen(allowance)
    await flush()
    expect(allowance.snapshot.get()).toMatchObject({ status: "ready", state: { available: 5 } })
    expect(fetch).toHaveBeenCalledTimes(1)
    off()
    listen(allowance)
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("reports a failed read as unavailable rather than as zero", async () => {
    const allowance = sponsoredAllowance(
      query(),
      async () => {
        throw new Error("PXE down")
      },
      noUsage,
    )
    listen(allowance)
    await flush()
    expect(allowance.snapshot.get()).toMatchObject({ status: "unavailable" })
  })

  it("shares one read between concurrent refreshes", async () => {
    const fetch = vi.fn(async () => read({ uses: 1 }))
    const allowance = sponsoredAllowance(query(), fetch, noUsage)
    allowance.refresh()
    allowance.refresh()
    listen(allowance)
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("shows the last count, marked refreshing, while a new read runs", async () => {
    const next = deferred<AllowanceRead>()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(read({ uses: 5 }))
      .mockReturnValueOnce(next.promise)
    const allowance = sponsoredAllowance(query(), fetch, noUsage)
    const off = listen(allowance)
    await flush()
    off()
    listen(allowance)
    expect(allowance.snapshot.get()).toMatchObject({
      status: "ready",
      state: { available: 5 },
      refreshing: true,
    })
    next.resolve(read({ uses: 6 }))
    await flush()
    expect(allowance.snapshot.get()).toMatchObject({ state: { available: 6 }, refreshing: false })
  })

  it("keeps the last count after a failed re-read, marked with the failure", async () => {
    const error = new Error("PXE down")
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(read({ uses: 0, refillPeriod: 0 }))
      .mockRejectedValueOnce(error)
    const allowance = sponsoredAllowance(query(), fetch, noUsage)
    listen(allowance)
    await flush()
    allowance.refresh()
    await flush()
    expect(allowance.snapshot.get()).toMatchObject({
      status: "ready",
      state: { kind: "does-not-renew" },
      refreshing: false,
      error,
    })
  })

  it("reads again on a refresh after a failed read", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("PXE down"))
      .mockResolvedValueOnce(read({ uses: 6 }))
    const allowance = sponsoredAllowance(query(), fetch, noUsage)
    listen(allowance)
    await flush()
    expect(allowance.snapshot.get()).toMatchObject({ status: "unavailable" })
    allowance.refresh()
    await flush()
    expect(allowance.snapshot.get()).toMatchObject({ status: "ready", state: { available: 6 } })
  })

  describe("usage split", () => {
    const usageOf = (allowance: SponsoredAllowance) => {
      const snapshot = allowance.snapshot.get()
      return snapshot.status === "ready" ? snapshot.read.usage : "not ready"
    }

    it("shows the count before the split lands, then adds it", async () => {
      const split = deferred<AllowanceUsage | undefined>()
      const allowance = sponsoredAllowance(
        query(),
        async () => read({ uses: 5 }),
        () => split.promise,
      )
      listen(allowance)
      await flush()
      expect(allowance.snapshot.get()).toMatchObject({ status: "ready", state: { available: 5 } })
      expect(usageOf(allowance)).toBeUndefined()
      split.resolve({ yours: 3, depositAddresses: 2 })
      await flush()
      expect(usageOf(allowance)).toEqual({ yours: 3, depositAddresses: 2 })
    })

    it("drops a split for a replaced read, and adds the new read's own", async () => {
      const splits = [
        deferred<AllowanceUsage | undefined>(),
        deferred<AllowanceUsage | undefined>(),
      ]
      let call = 0
      const allowance = sponsoredAllowance(
        query(),
        async () => read({ uses: 5 - call }),
        () => splits[call++]!.promise,
      )
      listen(allowance)
      await flush()
      allowance.refresh()
      await flush()
      expect(allowance.snapshot.get()).toMatchObject({ state: { available: 4 } })
      splits[0]!.resolve({ yours: 3, depositAddresses: 2 })
      await flush()
      expect(usageOf(allowance)).toBeUndefined()
      splits[1]!.resolve({ yours: 3, depositAddresses: 3 })
      await flush()
      expect(usageOf(allowance)).toEqual({ yours: 3, depositAddresses: 3 })
    })

    it.each([
      ["before", true],
      ["after", false],
    ])(
      "splits a reopened reader's count when it lands %s the split in flight",
      async (_, countFirst) => {
        const splits = [
          deferred<AllowanceUsage | undefined>(),
          deferred<AllowanceUsage | undefined>(),
        ]
        const second = deferred<AllowanceRead>()
        const fetch = vi
          .fn()
          .mockResolvedValueOnce(read({ uses: 5 }))
          .mockReturnValueOnce(second.promise)
        let call = 0
        const allowance = sponsoredAllowance(query(), fetch, () => splits[call++]!.promise)
        const off = listen(allowance)
        await flush()
        off()
        listen(allowance)
        if (countFirst) second.resolve(read({ uses: 4 }))
        await flush()
        splits[0]!.resolve({ yours: 3, depositAddresses: 2 })
        await flush()
        second.resolve(read({ uses: 4 }))
        await flush()
        splits[1]!.resolve({ yours: 4, depositAddresses: 2 })
        await flush()
        expect(allowance.snapshot.get()).toMatchObject({ state: { available: 4 } })
        expect(usageOf(allowance)).toEqual({ yours: 4, depositAddresses: 2 })
      },
    )

    it("splits each fresh count again, the same count included", async () => {
      const split = vi
        .fn<() => Promise<AllowanceUsage | undefined>>()
        .mockResolvedValueOnce({ yours: 3, depositAddresses: 2 })
        .mockResolvedValueOnce({ yours: 4, depositAddresses: 1 })
        .mockResolvedValueOnce({ yours: 5, depositAddresses: 0 })
      const allowance = sponsoredAllowance(query(), async () => read({ uses: 5 }), split)
      const off = listen(allowance)
      await flush()
      await flush()
      expect(usageOf(allowance)).toEqual({ yours: 3, depositAddresses: 2 })
      allowance.refresh()
      await flush()
      await flush()
      expect(split).toHaveBeenCalledTimes(2)
      expect(usageOf(allowance)).toEqual({ yours: 4, depositAddresses: 1 })
      // A reader that opens later reads the count and its split again.
      off()
      listen(allowance)
      await flush()
      await flush()
      expect(split).toHaveBeenCalledTimes(3)
      expect(usageOf(allowance)).toEqual({ yours: 5, depositAddresses: 0 })
    })

    it("reads a failed split again on its backoff, never taking the failure for no split", async () => {
      vi.useFakeTimers()
      try {
        const split = vi
          .fn<() => Promise<AllowanceUsage | undefined>>()
          .mockRejectedValueOnce(new Error("PXE sync failed"))
          .mockResolvedValueOnce({ yours: 3, depositAddresses: 2 })
        const allowance = sponsoredAllowance(query(), async () => read({ uses: 5 }), split)
        listen(allowance)
        await vi.advanceTimersByTimeAsync(0)
        expect(usageOf(allowance)).toBeUndefined()
        await vi.advanceTimersByTimeAsync(5_000)
        expect(split).toHaveBeenCalledTimes(2)
        expect(usageOf(allowance)).toEqual({ yours: 3, depositAddresses: 2 })
      } finally {
        vi.useRealTimers()
      }
    })

    it.each([
      ["spent back down after a renewal", 4],
      ["renewed", 100],
    ])("shows no split under a new count, %s, until that count's own lands", async (_, uses) => {
      const splits = [
        deferred<AllowanceUsage | undefined>(),
        deferred<AllowanceUsage | undefined>(),
      ]
      const counts = [read({ uses: 5 }), read({ uses })]
      let call = 0
      const allowance = sponsoredAllowance(
        query(),
        async () => counts[call]!,
        () => splits[call++]!.promise,
      )
      listen(allowance)
      await flush()
      splits[0]!.resolve({ yours: 90, depositAddresses: 5 })
      await flush()
      expect(usageOf(allowance)).toEqual({ yours: 90, depositAddresses: 5 })
      allowance.refresh()
      await flush()
      expect(allowance.snapshot.get()).toMatchObject({ state: { available: uses } })
      expect(usageOf(allowance)).toBeUndefined()
      splits[1]!.resolve({ yours: 1, depositAddresses: 0 })
      await flush()
      expect(usageOf(allowance)).toEqual({ yours: 1, depositAddresses: 0 })
    })

    it("keeps the count when the split fails", async () => {
      const allowance = sponsoredAllowance(
        query(),
        async () => read({ uses: 5 }),
        async () => {
          throw new Error("PXE sync failed")
        },
      )
      listen(allowance)
      await flush()
      await flush()
      expect(allowance.snapshot.get()).toMatchObject({ status: "ready", state: { available: 5 } })
      expect(usageOf(allowance)).toBeUndefined()
    })
  })
})
