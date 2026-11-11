// @vitest-environment node
import { createPace } from "@obsidion/core/cadence"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCatchUp } from "../../src/engine/catchUp"
import { openDatabase } from "../../src/engine/database"
import { createMilestones } from "../../src/engine/milestones"
import { memoryBackend } from "../../src/engine/memoryBackend"
import {
  startRuntime,
  task,
  within,
  type Runtime,
  type RuntimeDeps,
  type Task,
  type TaskSpec,
} from "../../src/engine/runtime"
import { memoryStore } from "../../src/engine/store"
import { flush, later } from "./taskTable"

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}
/** A run that lasts until it is aborted. */
const untilAborted = ({ signal }: { signal: AbortSignal }) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()))
type Spec = TaskSpec<Record<string, never>>
const t = (
  spec: Spec extends infer S ? (S extends Spec ? Omit<S, "needs"> : never) : never,
  name = "t",
) => task(name, { needs: {}, ...spec })

describe("task runtime", () => {
  let runtime: Runtime | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    runtime?.stop()
    vi.useRealTimers()
  })
  const start = (tasks: Task[], deps: Partial<RuntimeDeps> = {}) =>
    (runtime = startRuntime(tasks, {
      db: openDatabase(memoryBackend()),
      milestones: createMilestones({ catchUp: createCatchUp() }),
      visible: memoryStore(true).readonly,
      pace: createPace(),
      now: () => Date.now(),
      ...deps,
    }))

  it("waits for its milestones, and runs nothing once stopped before them", async () => {
    const milestones = createMilestones({ catchUp: createCatchUp() })
    const order: string[] = []
    const push = (id: string) => async () => void order.push(id)
    start(
      [
        t({ after: { firstBalance: 60_000 }, every: "once", run: push("a") }, "a"),
        t({ every: "once", run: push("b") }, "b"),
      ],
      { milestones },
    )
    await flush()
    expect(order).toEqual(["b"])
    milestones.mark("firstBalance")
    await flush()
    expect(order).toEqual(["b", "a"])

    order.length = 0
    const later = createMilestones({ catchUp: createCatchUp() })
    start([t({ after: { firstBalance: 60_000 }, every: "once", run: push("a") }, "a")], {
      milestones: later,
    }).stop()
    later.mark("firstBalance")
    await flush()
    expect(order).toEqual([])
  })

  it("counts a milestone's bound from its needs first being ready", async () => {
    const wallet = later<string>("wallet")
    const run = vi.fn(async () => {})
    start([
      task("t", {
        needs: { wallet: wallet.service },
        after: { firstBalance: 60_000 },
        every: "once",
        run,
      }),
    ])
    await vi.advanceTimersByTimeAsync(100_000)
    wallet.ready("w1")
    await vi.advanceTimersByTimeAsync(59_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("runs one at a time; wakes mid-run share one rerun, settled only once it ends", async () => {
    const runs: ReturnType<typeof gate>[] = []
    const run = () => (runs.push(gate()), runs[runs.length - 1].opened)
    const task = t({ every: "once", run })
    const rt = start([task])
    await flush()
    let settled = 0
    void rt.wake(task).then(() => settled++)
    void rt.wake(task).then(() => settled++)
    await flush()
    expect(runs).toHaveLength(1)
    runs[0].open()
    await flush()
    expect([runs.length, settled]).toEqual([2, 0])
    runs[1].open()
    await flush()
    expect([runs.length, settled]).toEqual([2, 2])
  })

  it("wakes another task from a run, and ignores a task it does not run", async () => {
    const other = vi.fn(async () => {})
    const second = t({ every: 60_000, run: other }, "second")
    const first = t({ every: "once", run: ({ wake }) => wake(second) }, "first")
    const rt = start([first, second])
    await flush()
    other.mockClear()
    await rt.wake(first)
    expect(other).toHaveBeenCalledTimes(1)
    await rt.wake(t({ every: "once", run: other }, "stranger"))
    expect(other).toHaveBeenCalledTimes(1)
  })

  it("backs off a failing task, and keeps the backoff across a restart", async () => {
    const backend = memoryBackend()
    const db = openDatabase(backend)
    let failing = true
    const run = vi.fn(async () => {
      if (failing) throw new Error("down")
    })
    const task = t({ every: "once", backoff: { baseMs: 1_000, maxMs: 3_000 }, run })
    const rt = start([task], { db })
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
    rt.stop()
    // The second failure waits 2 s; a restart 500 ms in waits out the rest.
    await vi.advanceTimersByTimeAsync(500)
    start([task], { db })
    await vi.advanceTimersByTimeAsync(1_499)
    expect(run).toHaveBeenCalledTimes(2)
    failing = false
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(3)
    expect([...backend.entries.keys()]).toEqual([])
  })

  it("counts a saved backoff on the time it is given", async () => {
    const db = openDatabase(memoryBackend())
    const run = vi.fn(async () => {
      throw new Error("down")
    })
    const task = t({ every: "once", backoff: { baseMs: 10_000, maxMs: 10_000 }, run })
    const rt = start([task], { db })
    await flush()
    rt.stop()
    start([task], { db, now: () => Date.now() + 10_000 })
    await flush()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("reads a restart's backoff once the failed run's save has landed", async () => {
    const inner = memoryBackend()
    const saving = gate()
    const db = openDatabase({
      ...inner,
      apply: async (ops) => saving.opened.then(() => inner.apply(ops)),
    })
    const run = vi.fn(async () => {
      throw new Error("down")
    })
    const task = t({ every: "once", backoff: { baseMs: 1_000, maxMs: 3_000 }, run })
    const rt = start([task], { db })
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    // A replacement runtime starts while the failure's backoff is still being saved.
    rt.stop()
    start([task], { db })
    await flush()
    saving.open()
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("runs again after the delay a clean run returns, in place of its cadence", async () => {
    const delays = [1_000, 30_000]
    const run = vi.fn(async () => ({ nextMs: delays.shift() ?? 5_000 }))
    start([t({ every: 5_000, run })])
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("runs again at once on a signalled wake that came while its cadence run was in flight", async () => {
    const pace = createPace({ signalled: true })
    const runs: ReturnType<typeof gate>[] = []
    const run = () => (runs.push(gate()), runs[runs.length - 1].opened)
    start([t({ every: 5_000, run })], { pace })
    await flush()
    pace.wake()
    runs[0].open()
    await flush()
    expect(runs).toHaveLength(2)
    runs[1].open()
    await flush()
    expect(runs).toHaveLength(2)
  })

  it("backs off a failed run, however short the delay the clean ones return", async () => {
    let failing = false
    const run = vi.fn(async () => {
      if (failing) throw new Error("down")
      return { nextMs: 1_000 }
    })
    start([t({ every: 5_000, backoff: { baseMs: 10_000, maxMs: 10_000 }, run })])
    await flush()
    failing = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
    failing = false
    await vi.advanceTimersByTimeAsync(9_999)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(4)
  })

  it("holds a returned delay to the hidden pace while hidden, and keeps a longer one", async () => {
    const visible = memoryStore(true)
    const delays = [4_000, 60_000]
    const run = vi.fn(async () => ({ nextMs: delays.shift() ?? 4_000 }))
    start([t({ every: 4_000, whenHidden: 12_000, run })], { visible: visible.readonly })
    await flush()
    visible.set(false)
    // The shown run's 4 s ends hidden; that run asks 60 s, longer than the hidden 12 s.
    await vi.advanceTimersByTimeAsync(4_000)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(3)
    // It asks 4 s; hidden, it waits 12 s.
    await vi.advanceTimersByTimeAsync(11_999)
    expect(run).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(4)
  })

  it("runs at its store's interval, and at once when a shorter one has already passed", async () => {
    const interval = memoryStore(10_000)
    const run = vi.fn(async () => {})
    start([t({ every: interval.readonly, run })])
    await flush()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(6_000)
    interval.set(4_000)
    await flush()
    expect(run).toHaveBeenCalledTimes(3)
    // Not yet passed: the wait in place ends 4 s after the last run.
    await vi.advanceTimersByTimeAsync(1_000)
    interval.set(3_000)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(run).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(4)
  })

  it("lengthens the wait in place when its store's interval grows, with no extra run", async () => {
    const interval = memoryStore(4_000)
    const run = vi.fn(async () => {})
    start([t({ every: interval.readonly, run })])
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    interval.set(10_000)
    await vi.advanceTimersByTimeAsync(7_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("lets a run finish when its interval changes during it, then waits the new interval", async () => {
    const interval = memoryStore(10_000)
    const runs: ReturnType<typeof gate>[] = []
    const run = vi.fn(
      (_: { signal: AbortSignal }) => (runs.push(gate()), runs[runs.length - 1].opened),
    )
    start([t({ every: interval.readonly, run })])
    await vi.advanceTimersByTimeAsync(20_000)
    interval.set(4_000)
    await flush()
    expect([run.mock.calls.length, run.mock.calls[0][0].signal.aborted]).toEqual([1, false])
    runs[0].open()
    await vi.advanceTimersByTimeAsync(3_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("stops listening to its interval's store on stop", async () => {
    const interval = memoryStore(10_000)
    let listening = 0
    const every = {
      get: interval.get,
      subscribe(listener: () => void) {
        listening++
        const off = interval.subscribe(listener)
        return () => (listening--, off())
      },
    }
    const run = vi.fn(async () => {})
    const rt = start([t({ every, run })])
    await flush()
    expect(listening).toBe(1)
    rt.stop()
    interval.set(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect([listening, run.mock.calls.length]).toEqual([0, 1])
  })

  it("ignores its interval's store while hidden at a hidden pace, and follows it once shown", async () => {
    const visible = memoryStore(true)
    const interval = memoryStore(4_000)
    const run = vi.fn(async () => {})
    start([t({ every: interval.readonly, whenHidden: 30_000, run })], { visible: visible.readonly })
    await flush()
    visible.set(false)
    // The wait begun while shown keeps its 4 s; the next one is the hidden 30 s.
    await vi.advanceTimersByTimeAsync(1_000)
    interval.set(1_000)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(3)
    visible.set(true)
    await flush()
    expect(run).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(5)
  })

  it("compiles a spec only in a form the runtime runs", () => {
    const n = memoryStore(1).readonly
    task("periodic", {
      needs: {},
      every: n,
      whenHidden: 1_000,
      run: async () => ({ nextMs: 1 }),
    })
    task("once", {
      needs: {},
      every: "once",
      on: { n },
      run: async ({ n }) => void (n satisfies number),
    })
    // @ts-expect-error a store change reruns only a once task
    task("on", { needs: {}, every: 1_000, on: { n }, run: async () => {} })
    // @ts-expect-error a hidden pace is a periodic task's
    task("hidden", { needs: {}, every: "once", whenHidden: 1_000, run: async () => {} })
    // @ts-expect-error a returned delay is a periodic task's
    task("next", { needs: {}, every: "once", run: async () => ({ nextMs: 1 }) })
  })

  it("pauses while hidden, aborting the run in flight, and runs at once on show", async () => {
    const visible = memoryStore(true)
    const run = vi.fn<(ctx: { signal: AbortSignal }) => Promise<void>>(async () => {})
    start([t({ every: 5_000, run })], { visible: visible.readonly })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).toHaveBeenCalledTimes(2)
    run.mockImplementationOnce(untilAborted)
    await vi.advanceTimersByTimeAsync(5_000)
    visible.set(false)
    expect(run.mock.calls[2][0].signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(3)
    visible.set(true)
    await flush()
    expect(run).toHaveBeenCalledTimes(4)
  })

  it("keeps a hidden pace: the run in flight goes on, and showing runs at once", async () => {
    const visible = memoryStore(true)
    const runs: ReturnType<typeof gate>[] = []
    const run = vi.fn((ctx: { signal: AbortSignal }) => {
      runs.push(gate())
      return Promise.race([runs[runs.length - 1].opened, untilAborted(ctx)])
    })
    start([t({ every: 5_000, whenHidden: 30_000, run })], { visible: visible.readonly })
    await flush()
    visible.set(false)
    expect(run.mock.calls[0][0].signal.aborted).toBe(false)
    runs[0].open()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    runs[1].open()
    await flush()
    visible.set(true)
    await flush()
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("settles a wake at once while hidden, and runs on show", async () => {
    const visible = memoryStore(false)
    const run = vi.fn(async () => {})
    const task = t({ every: 5_000, run })
    const rt = start([task], { visible: visible.readonly })
    await flush()
    await rt.wake(task)
    expect(run).not.toHaveBeenCalled()
    visible.set(true)
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("settles the wakers of a run that never ends on its abort", async () => {
    const visible = memoryStore(true)
    const task = t({ every: 5_000, run: () => new Promise<void>(() => {}) })
    const rt = start([task], { visible: visible.readonly })
    await flush()
    let woken = false
    void rt.wake(task).then(() => (woken = true))
    visible.set(false)
    await flush()
    expect(woken).toBe(true)
  })

  it("runs once its needs are ready, with their values", async () => {
    const wallet = later<string>("wallet")
    const seen: string[] = []
    const needing = task("t", {
      needs: { wallet: wallet.service },
      every: 5_000,
      run: async (ctx) => void seen.push(ctx.wallet),
    })
    const rt = start([needing])
    await vi.advanceTimersByTimeAsync(10_000)
    await rt.wake(needing)
    expect(seen).toEqual([])
    wallet.ready("w1")
    await flush()
    expect(seen).toEqual(["w1"])
  })

  it("aborts the run in flight when a need is lost or replaced, and runs with its value once back; a once task runs clean once per value", async () => {
    const wallet = later<string>("wallet")
    wallet.ready("w1")
    const seen: string[] = []
    const once = vi.fn(async (ctx: { wallet: string }) => void seen.push(ctx.wallet))
    const run = vi.fn<(ctx: { signal: AbortSignal; wallet: string }) => Promise<void>>(untilAborted)
    start([
      task("periodic", { needs: { wallet: wallet.service }, every: 5_000, run }),
      task("once", { needs: { wallet: wallet.service }, every: "once", run: once }),
    ])
    await flush()
    wallet.lose()
    expect(run.mock.calls[0][0].signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    wallet.ready("w1")
    await flush()
    expect(seen).toEqual(["w1"])
    wallet.ready("w2")
    await flush()
    expect(run.mock.calls.map((c) => [c[0].wallet, c[0].signal.aborted])).toEqual([
      ["w1", true],
      ["w1", true],
      ["w2", false],
    ])
    expect(seen).toEqual(["w1", "w2"])
  })

  it("runs only while when holds: false aborts the run and pauses the task, true runs it again", async () => {
    const when = memoryStore(false)
    const run = vi.fn<(ctx: { signal: AbortSignal }) => Promise<void>>(untilAborted)
    const gated = task("t", { needs: {}, when: when.readonly, every: 5_000, run })
    const rt = start([gated])
    await flush()
    expect(run).not.toHaveBeenCalled()
    when.set(true)
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    when.set(false)
    expect(run.mock.calls[0]![0].signal.aborted).toBe(true)
    await rt.wake(gated)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    when.set(true)
    await flush()
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1]![0].signal.aborted).toBe(false)
  })

  it("runs a once task again on each change of a store it runs on", async () => {
    const store = memoryStore(1)
    const run = vi.fn(async () => {})
    start([task("t", { needs: {}, on: { n: store.readonly }, every: "once", run })])
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    store.set(2)
    await flush()
    store.set(3)
    await flush()
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("gives the run each store it runs on as it is at the run, undefined included", async () => {
    const store = memoryStore<string | undefined>(undefined)
    const seen: (string | undefined)[] = []
    start([
      task("t", {
        needs: {},
        on: { v: store.readonly },
        every: "once",
        run: async ({ v }) => void seen.push(v),
      }),
    ])
    await flush()
    store.set("a")
    await flush()
    store.set("b")
    await flush()
    expect(seen).toEqual([undefined, "a", "b"])
  })

  it("finishes a run whose store changes during it, then runs on the new value: at once, or after the backoff of a failed run", async () => {
    const due = memoryStore(["a", "b"])
    let broken = true
    const seen: [string[], boolean][] = []
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    start([
      task("t", {
        needs: {},
        on: { items: due.readonly },
        every: "once",
        backoff: { baseMs: 1_000, maxMs: 1_000 },
        run: async ({ items, signal }) => {
          try {
            for (const item of items) {
              if (item === "b" && broken) throw new Error("b failed")
              due.set(due.get().filter((held) => held !== item))
            }
          } finally {
            seen.push([items, signal.aborted])
          }
        },
      }),
    ])
    await flush()
    expect(seen).toEqual([[["a", "b"], false]])
    expect(warn).toHaveBeenCalledWith("[runtime] t failed:", expect.any(Error))
    broken = false
    await vi.advanceTimersByTimeAsync(999)
    expect(seen).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(seen).toEqual([
      [["a", "b"], false],
      [["b"], false],
      [[], false],
    ])
    warn.mockRestore()
  })

  it("runs a failed once task with no backoff again only on a change after the run", async () => {
    const due = memoryStore(1)
    const seen: number[] = []
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    start([
      task("t", {
        needs: {},
        on: { n: due.readonly },
        every: "once",
        run: async ({ n }) => {
          seen.push(n)
          due.set(n + 1)
          await flush()
          throw new Error("failed")
        },
      }),
    ])
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(seen).toEqual([1])
    due.set(10)
    await flush()
    expect(seen).toEqual([1, 10])
    warn.mockRestore()
  })

  it("runs a once task while hidden: at start, and on each change of what it hears", async () => {
    const visible = memoryStore(false)
    const store = memoryStore(1)
    const seen: number[] = []
    start(
      [
        task("t", {
          needs: {},
          on: { n: store.readonly },
          every: "once",
          run: async ({ n }) => void seen.push(n),
        }),
      ],
      { visible: visible.readonly },
    )
    await flush()
    store.set(2)
    await flush()
    expect(seen).toEqual([1, 2])
  })

  it("ends a wait on its signal, even one aborted before it began, and observes the late work", async () => {
    const aborted = new AbortController()
    aborted.abort()
    let fail!: (e: Error) => void
    const work = new Promise<never>((_, reject) => (fail = reject))
    await expect(within(work, "read", { signal: aborted.signal })).rejects.toMatchObject({
      code: "aborted",
    })
    // Unobserved, this rejection would fail the run as unhandled.
    fail(new Error("late"))
    await flush()
    const live = new AbortController()
    const waiting = within(new Promise(() => {}), "read", { ms: 1_000, signal: live.signal })
    live.abort()
    await expect(waiting).rejects.toMatchObject({ code: "aborted" })
  })

  it("aborts the run in flight on stop, settles its wakers and runs nothing more", async () => {
    const run = vi.fn(untilAborted)
    const task = t({ every: 1_000, run })
    const rt = start([task])
    await flush()
    const woken = rt.wake(task)
    rt.stop()
    expect(run.mock.calls[0][0].signal.aborted).toBe(true)
    await woken
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  describe("cadence and backoff on the page's pace", () => {
    const failing = (fails: () => boolean) =>
      vi.fn(async () => {
        if (fails()) throw new Error("down")
      })

    it("with timers: a cadence waits its interval or a wake, a backoff its timer", async () => {
      const pace = createPace()
      let fails = false
      const run = failing(() => fails)
      start([t({ every: 5_000, backoff: { baseMs: 10_000, maxMs: 10_000 }, run })], { pace })
      await flush()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(run).toHaveBeenCalledTimes(2)
      pace.wake()
      await flush()
      expect(run).toHaveBeenCalledTimes(3)
      fails = true
      pace.wake()
      await flush()
      expect(run).toHaveBeenCalledTimes(4)
      // The failed run backs off 10 s, whatever the pace says.
      pace.wake()
      await vi.advanceTimersByTimeAsync(9_999)
      expect(run).toHaveBeenCalledTimes(4)
      fails = false
      await vi.advanceTimersByTimeAsync(1)
      expect(run).toHaveBeenCalledTimes(5)
    })

    it("signalled: a cadence waits for a wake alone, a backoff still its timer", async () => {
      const pace = createPace({ signalled: true })
      let fails = false
      const run = failing(() => fails)
      start([t({ every: 5_000, backoff: { baseMs: 1_000, maxMs: 1_000 }, run })], { pace })
      await flush()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(run).toHaveBeenCalledTimes(1)
      fails = true
      pace.wake()
      await flush()
      expect(run).toHaveBeenCalledTimes(2)
      pace.wake()
      await flush()
      expect(run).toHaveBeenCalledTimes(2)
      fails = false
      await vi.advanceTimersByTimeAsync(1_000)
      expect(run).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(run).toHaveBeenCalledTimes(3)
    })

    it("signalled: a passed interval from its store waits for a wake", async () => {
      const pace = createPace({ signalled: true })
      const interval = memoryStore(10_000)
      const run = vi.fn(async () => {})
      start([t({ every: interval.readonly, run })], { pace })
      await vi.advanceTimersByTimeAsync(20_000)
      interval.set(1_000)
      await flush()
      expect(run).toHaveBeenCalledTimes(1)
      pace.wake()
      await flush()
      expect(run).toHaveBeenCalledTimes(2)
    })

    it("signalled: a wake runs no hidden, stopped or restarted-in-backoff task", async () => {
      const pace = createPace({ signalled: true })
      const db = openDatabase(memoryBackend())
      const visible = memoryStore(true)
      let fails = false
      const run = failing(() => fails)
      const task = t({ every: 5_000, backoff: { baseMs: 1_000, maxMs: 1_000 }, run })
      const rt = start([task], { pace, db, visible: visible.readonly })
      await flush()
      visible.set(false)
      pace.wake()
      await flush()
      expect(run).toHaveBeenCalledTimes(1)
      visible.set(true)
      await flush()
      expect(run).toHaveBeenCalledTimes(2)
      fails = true
      pace.wake()
      await flush()
      expect(run).toHaveBeenCalledTimes(3)
      rt.stop()
      pace.wake()
      await flush()
      expect(run).toHaveBeenCalledTimes(3)
      // A restart keeps the saved backoff: a wake does not cut it short.
      fails = false
      start([task], { pace, db, visible: visible.readonly })
      pace.wake()
      await vi.advanceTimersByTimeAsync(999)
      expect(run).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(run).toHaveBeenCalledTimes(4)
    })
  })
})
