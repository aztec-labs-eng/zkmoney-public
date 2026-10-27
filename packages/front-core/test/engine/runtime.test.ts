// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryKv } from "../../src/engine/kv"
import {
  startRuntime,
  within,
  type Runtime,
  type RuntimeDeps,
  type TaskDef,
} from "../../src/engine/runtime"
import { memoryStore } from "../../src/engine/store"

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}
/** A run that lasts until it is aborted. */
const untilAborted = ({ signal }: { signal: AbortSignal }) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()))
const flush = () => vi.advanceTimersByTimeAsync(0)

describe("task runtime", () => {
  let runtime: Runtime | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    runtime?.stop()
    vi.useRealTimers()
  })
  const start = (tasks: TaskDef[], deps: Partial<RuntimeDeps> = {}) =>
    (runtime = startRuntime(tasks, { kv: createMemoryKv(), whenReady: async () => {}, ...deps }))

  it("waits for its boot stage", async () => {
    const stage = gate()
    const order: string[] = []
    const push = (id: string) => async () => void order.push(id)
    start(
      [
        { id: "a", stage: "savings", cadence: "once", run: push("a") },
        { id: "b", cadence: "once", run: push("b") },
      ],
      { whenReady: (s) => (s === "savings" ? stage.opened : Promise.resolve()) },
    )
    await flush()
    expect(order).toEqual(["b"])
    stage.open()
    await flush()
    expect(order).toEqual(["b", "a"])
  })

  it("runs one at a time; wakes mid-run share one rerun, settled only once it ends", async () => {
    const runs: ReturnType<typeof gate>[] = []
    const run = () => (runs.push(gate()), runs[runs.length - 1].opened)
    const rt = start([{ id: "t", cadence: "once", run }])
    await flush()
    let settled = 0
    void rt.wake("t").then(() => settled++)
    void rt.wake("t").then(() => settled++)
    await flush()
    expect(runs).toHaveLength(1)
    runs[0].open()
    await flush()
    expect([runs.length, settled]).toEqual([2, 0])
    runs[1].open()
    await flush()
    expect([runs.length, settled]).toEqual([2, 2])
  })

  it("backs off a failing task, and keeps the backoff across a restart", async () => {
    const kv = createMemoryKv()
    let failing = true
    const run = vi.fn(async () => {
      if (failing) throw new Error("down")
    })
    const task: TaskDef = {
      id: "t",
      cadence: "once",
      backoff: { baseMs: 1_000, maxMs: 3_000 },
      run,
    }
    const rt = start([task], { kv })
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
    rt.stop()
    // The second failure waits 2 s; a restart 500 ms in waits out the rest.
    await vi.advanceTimersByTimeAsync(500)
    start([task], { kv })
    await vi.advanceTimersByTimeAsync(1_499)
    expect(run).toHaveBeenCalledTimes(2)
    failing = false
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(3)
    expect(kv.keys()).toEqual([])
  })

  it("pauses while hidden, aborting the run in flight, and runs at once on show", async () => {
    const visible = memoryStore(true)
    const run = vi.fn<(ctx: { signal: AbortSignal }) => Promise<void>>(async () => {})
    start([{ id: "t", cadence: 5_000, run }], { visible: visible.readonly })
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

  it("settles a wake at once while hidden, and runs on show", async () => {
    const visible = memoryStore(false)
    const run = vi.fn(async () => {})
    const rt = start([{ id: "t", cadence: 5_000, run }], { visible: visible.readonly })
    await flush()
    await rt.wake("t")
    expect(run).not.toHaveBeenCalled()
    visible.set(true)
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("settles the wakers of a run that never ends on its abort", async () => {
    const visible = memoryStore(true)
    const rt = start([{ id: "t", cadence: 5_000, run: () => new Promise<void>(() => {}) }], {
      visible: visible.readonly,
    })
    await flush()
    let woken = false
    void rt.wake("t").then(() => (woken = true))
    visible.set(false)
    await flush()
    expect(woken).toBe(true)
  })

  it("ends a wait on its signal, even one aborted before it began, and observes the late work", async () => {
    const aborted = new AbortController()
    aborted.abort()
    let fail!: (e: Error) => void
    const work = new Promise<never>((_, reject) => (fail = reject))
    await expect(within(work, "read", { signal: aborted.signal })).rejects.toThrow("read aborted")
    // Unobserved, this rejection would fail the run as unhandled.
    fail(new Error("late"))
    await flush()
    const live = new AbortController()
    const waiting = within(new Promise(() => {}), "read", { ms: 1_000, signal: live.signal })
    live.abort()
    await expect(waiting).rejects.toThrow("read aborted")
  })

  it("aborts the run in flight on stop, settles its wakers and runs nothing more", async () => {
    const run = vi.fn(untilAborted)
    const rt = start([{ id: "t", cadence: 1_000, run }])
    await flush()
    const woken = rt.wake("t")
    rt.stop()
    expect(run.mock.calls[0][0].signal.aborted).toBe(true)
    await woken
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
