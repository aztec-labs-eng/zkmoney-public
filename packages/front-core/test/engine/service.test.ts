// @vitest-environment node
import { createPace } from "@obsidion/core/cadence"
import { describe, expect, it, vi } from "vitest"
import { createCatchUp } from "../../src/engine/catchUp"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { createMilestones } from "../../src/engine/milestones"
import { startRuntime, task } from "../../src/engine/runtime"
import { service, valueOf } from "../../src/engine/service"
import { memoryStore } from "../../src/engine/store"
import { fakeClock, flush, later } from "./taskTable"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

/** A service over one input whose builds the test settles, and the values it disposed. */
function controlled() {
  const input = later<number>("input")
  const builds: { n: number; signal: AbortSignal; done: ReturnType<typeof deferred<string>> }[] = []
  const disposed: string[] = []
  const svc = service(
    "svc",
    { from: [input.service], dispose: (v: string) => void disposed.push(v), retry: "manual" },
    ([n], signal) => {
      const done = deferred<string>()
      builds.push({ n, signal, done })
      return done.promise
    },
  )
  return { input, builds, disposed, svc }
}

describe("service", () => {
  fakeClock()

  it("builds once every input is ready", async () => {
    const a = later<number>("a")
    const doubled = service("doubled", { from: [a.service], retry: "manual" }, async ([n]) => n * 2)
    const sum = service(
      "sum",
      { from: [a.service, doubled], retry: "manual" },
      async ([n, d]) => n + d,
    )
    await flush()
    expect(sum.get().status).toBe("pending")
    a.ready(1)
    await flush()
    expect(valueOf(sum)).toBe(3)
  })

  it("disposes the value it replaces when an input changes, and a late build's value", async () => {
    const { input, builds, disposed, svc } = controlled()
    input.ready(1)
    builds[0].done.resolve("one")
    await flush()
    expect(valueOf(svc)).toBe("one")

    input.ready(2)
    expect(svc.get().status).toBe("pending")
    await flush()
    expect(disposed).toEqual(["one"])

    input.ready(3)
    expect(builds[1].signal.aborted).toBe(true)
    builds[1].done.resolve("two") // its input was replaced: disposed, never held
    builds[2].done.resolve("three")
    await flush()
    expect(valueOf(svc)).toBe("three")
    expect(disposed).toEqual(["one", "two"])
  })

  it("disposes its value when an input leaves ready, and builds again when it returns", async () => {
    const { input, builds, disposed, svc } = controlled()
    input.ready(1)
    builds[0].done.resolve("one")
    await flush()
    input.lose()
    await flush()
    expect(svc.get().status).toBe("pending")
    expect(disposed).toEqual(["one"])
    input.ready(1)
    builds[1].done.resolve("again")
    await flush()
    expect(valueOf(svc)).toBe("again")
  })

  it("aborts the build in flight on close, disposes its value, and rejects a waiting ready()", async () => {
    const { input, builds, disposed, svc } = controlled()
    input.ready(1)
    builds[0].done.resolve("one")
    await flush()
    svc.close()
    await flush()
    expect(disposed).toEqual(["one"])
    await expect(svc.ready()).rejects.toMatchObject({ code: "aborted" })

    const other = controlled()
    other.input.ready(1)
    const waiting = other.svc.ready()
    other.svc.close()
    expect(other.builds[0].signal.aborted).toBe(true)
    await expect(waiting).rejects.toMatchObject({ code: "aborted" })
  })

  it("retries a failed build with a doubling backoff, capped", async () => {
    let fails = 3
    const build = vi.fn(async () => {
      if (fails-- > 0) throw new Error("down")
      return "up"
    })
    const svc = service("svc", { from: [], retry: { baseMs: 1_000, maxMs: 1_500 } }, build)
    await flush()
    expect(svc.get().status).toBe("failed")
    await vi.advanceTimersByTimeAsync(999)
    expect(build).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(build).toHaveBeenCalledTimes(2)
    expect(svc.get().status).toBe("failed")
    await vi.advanceTimersByTimeAsync(1_499)
    expect(build).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(valueOf(svc)).toBe("up")
  })

  it("waits for retry() after a failure when manual, and ready() rejects with the failure", async () => {
    let fail = true
    const svc = service("svc", { from: [], retry: "manual" }, async () => {
      if (fail) throw new Error("cancelled")
      return 1
    })
    await expect(svc.ready()).rejects.toThrow("cancelled")
    await vi.advanceTimersByTimeAsync(60_000)
    expect(svc.get().status).toBe("failed")
    fail = false
    svc.retry()
    await expect(svc.ready()).resolves.toBe(1)
  })

  it("stops waiting in ready() once its signal aborts", async () => {
    const { svc } = controlled()
    const stop = new AbortController()
    const waiting = svc.ready(stop.signal)
    stop.abort()
    await expect(waiting).rejects.toMatchObject({ code: "aborted" })
  })

  it("is a task's need: the task runs on its value and stops once it is disposed", async () => {
    const { input, builds, svc } = controlled()
    const seen: string[] = []
    const runtime = startRuntime(
      [task("t", { needs: { svc }, every: 1_000, run: async (ctx) => void seen.push(ctx.svc) })],
      {
        db: openDatabase(memoryBackend()),
        milestones: createMilestones({ catchUp: createCatchUp() }),
        visible: memoryStore(true).readonly,
        pace: createPace(),
        now: () => Date.now(),
      },
    )
    input.ready(1)
    builds[0].done.resolve("one")
    await flush()
    input.lose()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(seen).toEqual(["one"])
    runtime.stop()
  })

  it("builds only while `when` holds; false aborts the build in flight and disposes the value", async () => {
    const input = later<number>("input")
    const when = memoryStore(false)
    const builds: { signal: AbortSignal; done: ReturnType<typeof deferred<string>> }[] = []
    const disposed: string[] = []
    const pxe = service(
      "pxe",
      { from: [input.service], when, dispose: (v) => void disposed.push(v), retry: "manual" },
      (_, signal) => {
        const done = deferred<string>()
        builds.push({ signal, done })
        return done.promise
      },
    )
    input.ready(1)
    await flush()
    expect(builds).toHaveLength(0)
    when.set(true)
    expect(builds).toHaveLength(1)
    when.set(false)
    expect(builds[0].signal.aborted).toBe(true)
    when.set(true)
    builds[1].done.resolve("pxe")
    await flush()
    expect(valueOf(pxe)).toBe("pxe")
    when.set(false)
    await flush()
    expect(pxe.get().status).toBe("pending")
    expect(disposed).toEqual(["pxe"])
  })

  it.each([
    ["closes it", ["b1"], "failed"],
    ["turns `when` off", ["b1"], "pending"],
    ["replaces the input", ["b1", "b3"], "ready"],
  ] as const)(
    "builds only what is current once a subscriber that saw a rebuild %s",
    async (act, built, status) => {
      const input = later<number>("input")
      const when = memoryStore(true)
      const builds: string[] = []
      const svc = service(
        "svc",
        { from: [input.service], when, retry: "manual" },
        async ([n]) => (builds.push(`b${n}`), `v${n}`),
      )
      input.ready(1)
      await flush()
      let acted = false
      svc.subscribe(() => {
        if (acted || svc.get().status !== "pending") return
        acted = true
        if (act === "closes it") svc.close()
        else if (act === "turns `when` off") when.set(false)
        else input.ready(3)
      })
      input.ready(2)
      await flush()
      expect(builds).toEqual(built)
      expect(svc.get().status).toBe(status)
      if (status === "ready") expect(valueOf(svc)).toBe("v3")
    },
  )
})
