import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ProvingStage, provingProgress, type ProvingProgressEvent } from "@obsidion/proving-progress"
import type { PXE } from "@aztec/pxe/client/lazy"
import {
  PerfBucketAccumulator,
  proveTxWithProgress,
  readPerfLogFlag,
  readTimingBenchFlag,
} from "./proving-progress-helpers.js"

beforeEach(() => {
  provingProgress.removeAllListeners()
  delete process.env.OBSIDION_PROVE_TX_PERF_LOGS
  delete process.env.OBSIDION_TX_TIMING_BENCH
})

afterEach(() => {
  provingProgress.removeAllListeners()
  delete process.env.OBSIDION_PROVE_TX_PERF_LOGS
  delete process.env.OBSIDION_TX_TIMING_BENCH
})

describe("proveTxWithProgress", () => {
  it("emits stage-start('simulating') exactly once before pxe.proveTx", async () => {
    const events: ProvingProgressEvent[] = []
    provingProgress.on("stage-start", (e: ProvingProgressEvent) => events.push(e))

    let proveTxCalled = false
    let emitsAtProveTxEntry = 0
    const stubPxe: Pick<PXE, "proveTx" | "sync"> = {
      async sync() {},
      async proveTx() {
        proveTxCalled = true
        emitsAtProveTxEntry = events.length
        return { stub: true } as any
      },
    }

    await proveTxWithProgress(stubPxe, {} as any, { scopes: [] })
    expect(proveTxCalled).toBe(true)
    expect(emitsAtProveTxEntry).toBe(1)
    expect(events[0]?.stage).toBe(ProvingStage.Simulating)
  })

  it("propagates errors from pxe.proveTx without swallowing", async () => {
    const stubPxe: Pick<PXE, "proveTx" | "sync"> = {
      async sync() {},
      async proveTx() {
        throw new Error("simulation reverted")
      },
    }
    await expect(proveTxWithProgress(stubPxe, {} as any, { scopes: [] })).rejects.toThrow("simulation reverted")
  })

  it("emits reset when pxe.proveTx fails so UI clears stranded stage state", async () => {
    let resetCount = 0
    provingProgress.on("reset", () => resetCount++)

    const stubPxe: Pick<PXE, "proveTx" | "sync"> = {
      async sync() {},
      async proveTx() {
        throw new Error("circuit failed")
      },
    }
    await expect(proveTxWithProgress(stubPxe, {} as any, { scopes: [] })).rejects.toThrow("circuit failed")
    expect(resetCount).toBe(1)
  })

  it("calls pxe.sync() before proveTx when opts.sync is set, and not otherwise", async () => {
    const calls: string[] = []
    const stubPxe: Pick<PXE, "proveTx" | "sync"> = {
      async sync() {
        calls.push("sync")
      },
      async proveTx() {
        calls.push("proveTx")
        return { stub: true } as any
      },
    }

    await proveTxWithProgress(stubPxe, {} as any, { scopes: [] }, { sync: true })
    expect(calls).toEqual(["sync", "proveTx"])

    calls.length = 0
    await proveTxWithProgress(stubPxe, {} as any, { scopes: [] })
    expect(calls).toEqual(["proveTx"])
  })

  it("a failing opts.sync rejects, emits reset, and never reaches proveTx", async () => {
    let resetCount = 0
    provingProgress.on("reset", () => resetCount++)

    let proveTxCalled = false
    const stubPxe: Pick<PXE, "proveTx" | "sync"> = {
      async sync() {
        throw new Error("sync failure")
      },
      async proveTx() {
        proveTxCalled = true
        return { stub: true } as any
      },
    }

    await expect(
      proveTxWithProgress(stubPxe, {} as any, { scopes: [] }, { sync: true }),
    ).rejects.toThrow("sync failure")
    expect(resetCount).toBe(1) // sync runs inside the try → catch clears the stage
    expect(proveTxCalled).toBe(false)
  })
})

describe("PerfBucketAccumulator", () => {
  it("captures sim/witgen/prove durations from singleton events", () => {
    const acc = new PerfBucketAccumulator()
    acc.subscribe()

    provingProgress.emitStageStart(ProvingStage.Simulating)
    provingProgress.emitStageComplete(ProvingStage.Simulating)
    provingProgress.emitStageStart(ProvingStage.Witgen)
    provingProgress.emitStageComplete(ProvingStage.Witgen)
    provingProgress.emitStageStart(ProvingStage.Proving)
    provingProgress.emitStageComplete(ProvingStage.Proving)

    const { sim, witgen, prove } = acc.snapshot()
    expect(typeof sim).toBe("number")
    expect(typeof witgen).toBe("number")
    expect(typeof prove).toBe("number")
    expect(sim).toBeGreaterThanOrEqual(0)
    expect(witgen).toBeGreaterThanOrEqual(0)
    expect(prove).toBeGreaterThanOrEqual(0)

    acc.unsubscribe()
  })

  it("returns 0 for stages that never completed", () => {
    const acc = new PerfBucketAccumulator()
    acc.subscribe()
    provingProgress.emitStageStart(ProvingStage.Simulating)
    // no complete fires
    const { sim, witgen, prove } = acc.snapshot()
    expect(sim).toBe(0)
    expect(witgen).toBe(0)
    expect(prove).toBe(0)
    acc.unsubscribe()
  })

  it("unsubscribe removes both listeners (no leak across calls)", () => {
    const startCount = provingProgress.listenerCount("stage-start")
    const completeCount = provingProgress.listenerCount("stage-complete")

    const acc = new PerfBucketAccumulator()
    acc.subscribe()
    expect(provingProgress.listenerCount("stage-start")).toBe(startCount + 1)
    expect(provingProgress.listenerCount("stage-complete")).toBe(completeCount + 1)

    acc.unsubscribe()
    expect(provingProgress.listenerCount("stage-start")).toBe(startCount)
    expect(provingProgress.listenerCount("stage-complete")).toBe(completeCount)
  })

  it("subscribe + unsubscribe twice is a no-op (stable handler refs)", () => {
    const startCount = provingProgress.listenerCount("stage-start")

    const acc = new PerfBucketAccumulator()
    acc.subscribe()
    acc.unsubscribe()
    acc.subscribe()
    acc.unsubscribe()

    expect(provingProgress.listenerCount("stage-start")).toBe(startCount)
  })
})

describe("readPerfLogFlag", () => {
  it("returns false by default", () => {
    expect(readPerfLogFlag()).toBe(false)
  })

  it("returns true when OBSIDION_PROVE_TX_PERF_LOGS=true", () => {
    process.env.OBSIDION_PROVE_TX_PERF_LOGS = "true"
    expect(readPerfLogFlag()).toBe(true)
  })

  it("does not match arbitrary truthy values like 'TRUE' or '1'", () => {
    process.env.OBSIDION_PROVE_TX_PERF_LOGS = "1"
    expect(readPerfLogFlag()).toBe(false)
    process.env.OBSIDION_PROVE_TX_PERF_LOGS = "TRUE"
    expect(readPerfLogFlag()).toBe(false)
  })
})

describe("readTimingBenchFlag", () => {
  it("returns false by default", () => {
    expect(readTimingBenchFlag()).toBe(false)
  })

  it("returns true when OBSIDION_TX_TIMING_BENCH=true", () => {
    process.env.OBSIDION_TX_TIMING_BENCH = "true"
    expect(readTimingBenchFlag()).toBe(true)
  })

  it("is independent of the perf-log flag", () => {
    process.env.OBSIDION_PROVE_TX_PERF_LOGS = "true"
    expect(readTimingBenchFlag()).toBe(false)
    process.env.OBSIDION_TX_TIMING_BENCH = "true"
    expect(readPerfLogFlag()).toBe(true)
    expect(readTimingBenchFlag()).toBe(true)
  })

  it("does not match arbitrary truthy values like 'TRUE' or '1'", () => {
    process.env.OBSIDION_TX_TIMING_BENCH = "1"
    expect(readTimingBenchFlag()).toBe(false)
    process.env.OBSIDION_TX_TIMING_BENCH = "TRUE"
    expect(readTimingBenchFlag()).toBe(false)
  })
})
