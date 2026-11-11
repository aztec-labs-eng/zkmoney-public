// @vitest-environment node
import { createPace } from "@obsidion/core/cadence"
import { describe, expect, it, vi } from "vitest"
import { queries, queryKey, type QueryState } from "../../src/engine/query"
import { memoryStore, type ReadonlyStore } from "../../src/engine/store"
import { fakeClock, flush } from "./taskTable"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

/** A page's query constructor over a pace, visibility the test sets, and the fake clock. */
function page({ signalled = false } = {}) {
  const pace = createPace({ signalled })
  const visible = memoryStore(true)
  return {
    pace,
    visible,
    query: queries({ pace, visible: visible.readonly, now: () => Date.now() }),
  }
}

/** Loads the test settles one by one, in order. */
function loads<T>() {
  const calls: { signal: AbortSignal; done: ReturnType<typeof deferred<T>> }[] = []
  const load = (signal: AbortSignal) => {
    const done = deferred<T>()
    calls.push({ signal, done })
    return done.promise
  }
  return { calls, load }
}

/** Counts loads that answer at once with the count so far. */
function counted() {
  let n = 0
  const load = vi.fn(async () => ++n)
  return { load, count: () => load.mock.calls.length }
}

const subscribe = <T>(entry: ReadonlyStore<QueryState<T>>) => entry.subscribe(() => {})

describe("query", () => {
  fakeClock()

  it("shares one load among concurrent reads and a subscribe, and keeps the value", async () => {
    const { query } = page()
    const { calls, load } = loads<string>()
    const entry = query("q", { load })()
    const reads = [entry.read(), entry.read()]
    const off = subscribe(entry)
    calls[0].done.resolve("v")
    await expect(Promise.all(reads)).resolves.toEqual(["v", "v"])
    await expect(entry.read()).resolves.toBe("v")
    expect(calls).toHaveLength(1)
    off()
  })

  const highOrOld = (v: number, age: number) => v > 1 || age > 5_000
  it("returns a fresh cached value during a load, and a stale one joins the load", async () => {
    // Signalled: the poll loads only on a wake.
    const { query, pace } = page({ signalled: true })
    const { calls, load } = loads<number>()
    let rule = false
    const entry = query("q", { load, stale: () => rule, poll: 5_000 })()
    const off = subscribe(entry)
    calls[0].done.resolve(1)
    await flush()
    pace.wake()
    await flush()
    expect(calls).toHaveLength(2)
    await expect(entry.read()).resolves.toBe(1)
    rule = true
    const joined = entry.read()
    calls[1].done.resolve(2)
    await expect(joined).resolves.toBe(2)
    expect(calls).toHaveLength(2)
    off()
  })

  it.each([
    ["a number of ms", 1_000, 999, 1],
    ["a number of ms, reached", 1_000, 1_000, 2],
    ["a rule over value and age, kept", highOrOld, 5_000, 1],
    ["a rule over value and age, dropped", highOrOld, 5_001, 2],
  ])("reads again once stale: %s", async (_, stale, waitMs, expected) => {
    const { query } = page()
    const { load, count } = counted()
    const entry = query("q", { load, stale })()
    await entry.read()
    await vi.advanceTimersByTimeAsync(waitMs)
    await entry.read()
    expect(count()).toBe(expected)
  })

  it("keeps a ready value readable, marked refreshing, while it reads again", async () => {
    const { query } = page()
    const { calls, load } = loads<number>()
    const entry = query("q", { load })()
    const first = entry.read()
    calls[0].done.resolve(1)
    await first
    entry.refresh()
    expect(entry.get()).toEqual({ status: "ready", value: 1, refreshing: true })
    calls[1].done.resolve(2)
    await flush()
    expect(entry.get()).toEqual({ status: "ready", value: 2, refreshing: false })
  })

  it("keeps the ready value with the error when a read again fails, until a good read", async () => {
    const { query } = page()
    let fail = false
    let n = 0
    const entry = query("q", {
      load: async () => {
        if (fail) throw new Error("down")
        return ++n
      },
      stale: 0,
    })()
    await entry.read()
    fail = true
    await expect(entry.read()).rejects.toThrow("down")
    // Stale at once, so with no subscriber it shows as refreshing; the error stays beside the value.
    expect(entry.get()).toEqual({
      status: "ready",
      value: 1,
      refreshing: true,
      error: expect.any(Error),
    })
    fail = false
    await entry.read()
    expect(entry.get()).toStrictEqual({ status: "ready", value: 2, refreshing: true })
  })

  it("fails a first read that fails, with no value", async () => {
    const { query } = page()
    const entry = query("q", {
      load: async (): Promise<number> => {
        throw new Error("down")
      },
    })()
    await expect(entry.read()).rejects.toThrow("down")
    expect(entry.get()).toEqual({ status: "failed", error: expect.any(Error) })
  })

  it("shows a stale value as refreshing from the first get, before a subscribe reads it again", async () => {
    const { query } = page()
    const { calls, load } = loads<number>()
    const entry = query("q", { load, stale: 0 })()
    const first = entry.read()
    calls[0].done.resolve(1)
    await first
    const shown = entry.get()
    expect(shown).toEqual({ status: "ready", value: 1, refreshing: true })
    expect(entry.get()).toBe(shown)
    const off = subscribe(entry)
    calls[1].done.resolve(2)
    await flush()
    expect(entry.get()).toEqual({ status: "ready", value: 2, refreshing: false })
    off()
  })

  it("retries a failed load on a backoff while subscribed, showing when, and stops once unsubscribed", async () => {
    const { query } = page()
    const load = vi.fn(async (): Promise<number> => {
      throw new Error("down")
    })
    const entry = query("q", { load, retry: { baseMs: 1_000, maxMs: 1_500 } })()
    const off = subscribe(entry)
    await flush()
    expect(entry.get()).toMatchObject({ status: "failed", retryAt: Date.now() + 1_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(entry.get()).toMatchObject({ status: "failed", retryAt: Date.now() + 1_500 })
    expect(load).toHaveBeenCalledTimes(2)
    off()
    expect(entry.get()).toEqual({ status: "failed", error: expect.any(Error) })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["no stale rule or poll", {}],
    ["a poll", { poll: 60_000 }],
    ["a stale value", { stale: 1 }],
  ])("keeps a retry owed over a kept value across a resubscribe, with %s", async (_, rule) => {
    const { query } = page()
    let fail = false
    const load = vi.fn(async () => {
      if (fail) throw new Error("down")
      return 1
    })
    const entry = query("q", { load, retry: { baseMs: 1_000, maxMs: 1_000 }, ...rule })()
    const off = subscribe(entry)
    await flush()
    fail = true
    entry.refresh()
    await flush()
    off()
    subscribe(entry)
    await flush()
    // The backoff still holds: no load yet, then the retry.
    expect(load).toHaveBeenCalledTimes(2)
    fail = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(load).toHaveBeenCalledTimes(3)
    expect(entry.get()).toEqual({ status: "ready", value: 1, refreshing: false })
  })

  it.each([
    ["lands", true],
    ["fails", false],
  ])("gives a reader that a load's result starts its own load, when it %s", async (_, ok) => {
    const { query } = page()
    const { calls, load } = loads<number>()
    const entry = query("q", { load, stale: 0 })()
    let late: Promise<number> | undefined
    entry.subscribe(() => {
      if (!late && entry.get().status !== "pending") late = entry.read()
    })
    const first = entry.read().catch((e: unknown) => e)
    if (ok) calls[0].done.resolve(1)
    else calls[0].done.reject(new Error("down"))
    await first
    expect(calls).toHaveLength(2)
    calls[1].done.resolve(2)
    await expect(late).resolves.toBe(2)
  })

  it.each(["read", "subscribe"])(
    "retries a failed re-read on the next %s when onRead, showing the value meanwhile",
    async (next) => {
      const { query } = page()
      let fail = false
      const load = vi.fn(async () => {
        if (fail) throw new Error("down")
        return load.mock.calls.length
      })
      const entry = query("q", { load })()
      await entry.read()
      fail = true
      entry.refresh()
      await flush()
      // Refreshing from the first get: the next read or subscribe loads it again.
      expect(entry.get()).toEqual({
        status: "ready",
        value: 1,
        refreshing: true,
        error: expect.any(Error),
      })
      fail = false
      if (next === "read") await expect(entry.read()).resolves.toBe(3)
      else subscribe(entry)
      await flush()
      expect(load).toHaveBeenCalledTimes(3)
      expect(entry.get()).toEqual({ status: "ready", value: 3, refreshing: false })
    },
  )

  it("loads a failed entry again on its next read or subscribe when onRead, and never on its own", async () => {
    const { query } = page()
    let fail = true
    const load = vi.fn(async () => {
      if (fail) throw new Error("down")
      return 1
    })
    const entry = query("q", { load })()
    const off = subscribe(entry)
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(entry.get()).toEqual({ status: "failed", error: expect.any(Error) })
    off()
    fail = false
    subscribe(entry)
    await flush()
    expect(entry.get()).toEqual({ status: "ready", value: 1, refreshing: false })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("polls only while subscribed, and stops at the last unsubscribe", async () => {
    const { query } = page()
    const { load, count } = counted()
    const entry = query("q", { load, poll: 1_000 })()
    await entry.read()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(count()).toBe(1)
    const offA = subscribe(entry)
    const offB = subscribe(entry)
    // Older than one poll: read at once.
    await flush()
    expect(count()).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(count()).toBe(3)
    offA()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(count()).toBe(4)
    offB()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(count()).toBe(4)
  })

  it("pauses its poll while the page is hidden, and reads at once when shown", async () => {
    const { query, visible } = page()
    const { load, count } = counted()
    const entry = query("q", { load, poll: 1_000 })()
    const off = subscribe(entry)
    await flush()
    visible.set(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(count()).toBe(1)
    visible.set(true)
    await flush()
    expect(count()).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(count()).toBe(3)
    off()
  })

  it("waits on the pace: a wake runs the poll, and a wake during a load runs the next at once", async () => {
    const { query, pace } = page({ signalled: true })
    const { calls, load } = loads<number>()
    const entry = query("q", { load, poll: 1_000 })()
    const off = subscribe(entry)
    calls[0].done.resolve(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(1)
    pace.wake()
    await flush()
    expect(calls).toHaveLength(2)
    pace.wake()
    calls[1].done.resolve(2)
    await flush()
    expect(calls).toHaveLength(3)
    off()
  })

  it("latches on a final value: no more polls, and never stale again", async () => {
    const { query } = page()
    const { load, count } = counted()
    const entry = query("q", { load, poll: 1_000, stale: 0, final: (n) => n >= 2 })()
    const off = subscribe(entry)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(count()).toBe(2)
    await expect(entry.read()).resolves.toBe(2)
    off()
    subscribe(entry)
    await flush()
    expect(count()).toBe(2)
  })

  it("ends a subscribe that starts during a load with that load's value, and polls for it", async () => {
    // Signalled, as in a test world: a poll reads only on a wake.
    const { query, pace } = page({ signalled: true })
    const { calls, load } = loads<number>()
    const entry = query("clock", { load, poll: 5_000 })()
    const offFirst = subscribe(entry)
    // The view that subscribed leaves and the next one opens before the read in flight returns.
    offFirst()
    const offNext = subscribe(entry)
    calls[0].done.resolve(31)
    await flush()
    expect(entry.get()).toEqual({ status: "ready", value: 31, refreshing: false })
    expect(calls).toHaveLength(1)
    pace.wake()
    await flush()
    expect(calls).toHaveLength(2)
    offNext()
  })

  it("drops a load in flight on refresh, and its readers take the new one's value", async () => {
    const { query } = page()
    const { calls, load } = loads<number>()
    const entry = query("q", { load })()
    const waiting = entry.read()
    entry.refresh()
    expect(calls[0].signal.aborted).toBe(true)
    calls[0].done.resolve(1)
    calls[1].done.resolve(2)
    await expect(waiting).resolves.toBe(2)
    expect(entry.get()).toMatchObject({ value: 2 })
  })

  it("serves no cached value to a read after refresh until the new load lands", async () => {
    const { query } = page()
    const { calls, load } = loads<number>()
    const entry = query("q", { load })()
    const first = entry.read()
    calls[0].done.resolve(1)
    await expect(first).resolves.toBe(1)
    entry.refresh()
    const after = entry.read()
    calls[1].done.resolve(2)
    await expect(after).resolves.toBe(2)
    await expect(entry.read()).resolves.toBe(2)
    expect(calls).toHaveLength(2)
  })

  it("stops waiting in read() on abort, while the load still fills the entry", async () => {
    const { query } = page()
    const { calls, load } = loads<number>()
    const entry = query("q", { load })()
    const stop = new AbortController()
    const waiting = entry.read(stop.signal)
    stop.abort()
    await expect(waiting).rejects.toMatchObject({ code: "aborted" })
    calls[0].done.resolve(1)
    await flush()
    expect(entry.get()).toMatchObject({ value: 1 })
  })

  it("keeps one entry per key: bigints by value, addresses in any case, objects by field", async () => {
    const { query } = page()
    const seen: string[] = []
    const balance = query("balance", {
      load: async (owner: string, block: bigint, _signal: AbortSignal) => {
        seen.push(`${owner}@${block}`)
        return block
      },
    })
    expect(balance("0xAbC", 1n)).toBe(balance("0xabc", 1n))
    expect(balance("0xabc", 1n)).not.toBe(balance("0xabc", 2n))
    await balance("0xABC", 10n).read()
    await balance("0xabc", 10n).read()
    expect(seen).toEqual(["0xABC@10"])
    expect(queryKey([{ b: 1n, a: "x" }])).toBe(queryKey([{ a: "x", b: 1n }]))
    expect(queryKey([1n])).not.toBe(queryKey([1]))
    expect(queryKey([undefined])).not.toBe(queryKey([null]))
    expect(queryKey([{ toString: () => "0xDEF" }])).toBe(queryKey(["0xdef"]))
  })
})
