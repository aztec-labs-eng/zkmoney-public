// @vitest-environment node
/** A lookup reads a typed key's query entry once the key holds, and drops what a newer key replaces. */
import { createPace } from "@obsidion/core/cadence"
import { describe, expect, it, vi } from "vitest"
import { debounced, lookup, type LookupState } from "../../src/engine/lookup"
import { queries } from "../../src/engine/query"
import { memoryStore } from "../../src/engine/store"
import { fakeClock, flush } from "./taskTable"

const DELAY = 300
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms)

/** A query whose loads the test settles, and a lookup over a key the test types. */
function typed(stale?: number, lateMs?: number) {
  const reads: { key: string; answer(v: string): void; fail(): void }[] = []
  const query = queries({
    pace: createPace({ signalled: false }),
    visible: memoryStore(true),
    now: () => Date.now(),
  })
  const entry = query("q", {
    load: (key: string) =>
      new Promise<string>((answer, reject) =>
        reads.push({ key, answer, fail: () => reject(new Error("down")) }),
      ),
    stale,
  })
  const key = memoryStore<string | undefined>(undefined)
  const answer = lookup(key.readonly, entry, { delayMs: DELAY, lateMs })
  const off = answer.subscribe(() => {})
  const last = (): LookupState<string, string> => answer.get()
  return { key, reads, answer, off, last }
}

describe("lookup", () => {
  fakeClock()

  it("reads a key only once it has held for the delay, and only the last of several", async () => {
    const { key, reads, last } = typed()
    key.set("a")
    await flush()
    key.set("ab")
    await wait(DELAY - 1)
    expect(reads).toHaveLength(0)
    await wait(DELAY)
    expect(reads.map((r) => r.key)).toEqual(["ab"])
    expect(last()).toEqual({ key: "ab", status: "waiting", late: false })
    reads[0].answer("ab!")
    await flush()
    expect(last()).toEqual({ key: "ab", status: "answered", value: "ab!" })
  })

  it("drops an answer still out once a new key replaces it", async () => {
    const { key, reads, last } = typed()
    key.set("old")
    await wait(DELAY)
    key.set("new")
    reads[0].answer("old!")
    await flush()
    expect(last()).toEqual({ key: "new", status: "waiting", late: false })
  })

  it("answers a key typed again from its entry while fresh, and reads it again once stale", async () => {
    const kept = typed()
    kept.key.set("a")
    await wait(DELAY)
    kept.reads[0].answer("a!")
    await flush()
    kept.key.set(undefined)
    expect(kept.last()).toEqual({ key: undefined, status: "idle" })
    kept.key.set("a")
    await wait(DELAY)
    expect(kept.reads).toHaveLength(1)
    expect(kept.last()).toMatchObject({ status: "answered", value: "a!" })

    const always = typed(0)
    always.key.set("a")
    await wait(DELAY)
    always.reads[0].answer("a!")
    await flush()
    always.key.set(undefined)
    always.key.set("a")
    await wait(DELAY)
    expect(always.reads).toHaveLength(2)
    expect(always.last()).toEqual({ key: "a", status: "waiting", late: false })
  })

  it("reads late while the answer is out past lateMs, then answers", async () => {
    const { key, reads, last } = typed(undefined, 1000)
    key.set("a")
    await wait(1000)
    expect(last()).toEqual({ key: "a", status: "waiting", late: true })
    reads[0].answer("a!")
    await flush()
    expect(last()).toMatchObject({ status: "answered" })
  })

  it("reports a failed read, and reads the held key again at once on retry", async () => {
    const { key, reads, last, answer } = typed()
    key.set("a")
    await wait(DELAY)
    reads[0].fail()
    await flush()
    expect(last()).toMatchObject({ key: "a", status: "failed" })
    answer.retry()
    await flush()
    expect(reads).toHaveLength(2)
    reads[1].answer("back")
    await flush()
    expect(last()).toMatchObject({ status: "answered", value: "back" })
  })

  it("answers a key typed back to the one it read, with no second wait", async () => {
    const { key, reads, last } = typed()
    key.set("a")
    await wait(DELAY)
    key.set("ab")
    await wait(DELAY - 1)
    key.set("a")
    reads[0].answer("a!")
    await flush()
    expect(last()).toEqual({ key: "a", status: "answered", value: "a!" })
    await wait(DELAY)
    expect(reads.map((r) => r.key)).toEqual(["a"])
  })

  it("reads nothing once its last subscriber leaves", async () => {
    const { key, reads, off } = typed()
    key.set("a")
    off()
    await wait(DELAY * 4)
    key.set("b")
    await wait(DELAY * 4)
    expect(reads).toHaveLength(0)
  })
})

describe("debounced", () => {
  fakeClock()

  it("holds the first key at once, and a new key once it has held, beside the one before", async () => {
    const key = memoryStore("a")
    const keys = debounced(key.readonly, DELAY)
    const off = keys.subscribe(() => {})
    expect(keys.get()).toEqual({ key: "a" })
    key.set("ab")
    await wait(DELAY - 1)
    key.set("abc")
    await wait(DELAY - 1)
    expect(keys.get()).toEqual({ key: "a" })
    await wait(1)
    expect(keys.get()).toEqual({ key: "abc", before: "a" })
    off()
    key.set("x")
    await wait(DELAY)
    expect(keys.get()).toEqual({ key: "abc", before: "a" })
  })

  it("holds the first key only once it has held, from the start key", async () => {
    const keys = debounced(memoryStore<string | undefined>("a").readonly, DELAY, {
      from: undefined,
    })
    keys.subscribe(() => {})
    expect(keys.get()).toEqual({ key: undefined })
    await wait(DELAY)
    expect(keys.get()).toEqual({ key: "a", before: undefined })
  })
})
