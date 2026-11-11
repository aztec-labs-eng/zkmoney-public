import { afterEach, describe, expect, it, vi } from "vitest"
import { createClock } from "../../src/engine/clock"
import { legacyRecords } from "../../src/engine/recordSource"
import { memoryStore } from "../../src/engine/store"

afterEach(() => vi.useRealTimers())

describe("createClock", () => {
  it("ticks on the period while read, and stops once nothing reads it", () => {
    vi.useFakeTimers({ now: 1_000 })
    const clock = createClock(1_000, () => Date.now())
    const seen: number[] = []
    const off = clock.subscribe(() => seen.push(clock.get()))
    vi.advanceTimersByTime(2_500)
    expect(seen).toEqual([2_000, 3_000])
    off()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5_000)
    expect(seen).toEqual([2_000, 3_000])
    expect(clock.get()).toBe(8_000)
  })

  it("stops while the page is hidden, and ticks at once on its return", () => {
    vi.useFakeTimers({ now: 1_000 })
    const visible = memoryStore(true)
    const clock = createClock(1_000, () => Date.now(), visible.readonly)
    const seen: number[] = []
    const off = clock.subscribe(() => seen.push(clock.get()))
    vi.advanceTimersByTime(1_500)
    visible.set(false)
    vi.advanceTimersByTime(5_000)
    expect(seen).toEqual([2_000])
    expect(vi.getTimerCount()).toBe(0)
    visible.set(true)
    expect(seen).toEqual([2_000, 7_000])
    off()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("legacyRecords", () => {
  it("mirrors the source and hydrates once its load settles, failed or not", async () => {
    let listener: (records: number[]) => void = () => {}
    const store = legacyRecords({
      list: () => [1],
      load: () => Promise.reject(new Error("locked")),
      onListChanged: (l) => ((listener = l), () => {}),
    })
    expect(store.get()).toEqual({ records: [1], hydrated: false })
    listener([1, 2])
    expect(store.get().records).toEqual([1, 2])
    await Promise.resolve()
    await Promise.resolve()
    expect(store.get()).toEqual({ records: [1], hydrated: true })
  })
})
