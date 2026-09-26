import { afterEach, describe, expect, it } from "vitest"
import {
  type ProvingOperationContext,
  ProvingStage,
  provingProgress,
  type ProvingProgressEvent,
} from "./index.js"

afterEach(() => {
  provingProgress.removeAllListeners()
  provingProgress.clearOperationContext()
  // The snapshot map is reset by emitReset; removeAllListeners above flushes
  // test-installed listeners regardless.
  provingProgress.emitReset()
})

describe("provingProgress singleton", () => {
  it("ProvingStage const exposes the four named stages", () => {
    expect(ProvingStage.Simulating).toBe("simulating")
    expect(ProvingStage.Witgen).toBe("witgen")
    expect(ProvingStage.Proving).toBe("proving")
    expect(ProvingStage.Mining).toBe("mining")
  })

  it("emitStageStart fires stage-start with payload shape", () => {
    const events: ProvingProgressEvent[] = []
    provingProgress.on("stage-start", (e: ProvingProgressEvent) => events.push(e))
    provingProgress.emitStageStart(ProvingStage.Simulating)
    expect(events).toHaveLength(1)
    expect(events[0]?.stage).toBe(ProvingStage.Simulating)
    expect(typeof events[0]?.startTime).toBe("number")
  })

  it("emitStageStart accepts an optional operationId correlator", () => {
    const events: ProvingProgressEvent[] = []
    provingProgress.on("stage-start", (e: ProvingProgressEvent) => events.push(e))
    provingProgress.emitStageStart(ProvingStage.Witgen, "send_42")
    expect(events[0]?.operationId).toBe("send_42")
  })

  it("emitStageComplete fires stage-complete with stage payload", () => {
    const events: { stage: ProvingStage }[] = []
    provingProgress.on("stage-complete", (e: { stage: ProvingStage }) => events.push(e))
    provingProgress.emitStageComplete(ProvingStage.Mining)
    expect(events).toEqual([{ stage: ProvingStage.Mining }])
  })

  it("emitReset fires reset listener", () => {
    let called = 0
    provingProgress.on("reset", () => called++)
    provingProgress.emitReset()
    expect(called).toBe(1)
  })

  it("off(event, handler) removes a specific listener", () => {
    let called = 0
    const handler = () => called++
    provingProgress.on("stage-start", handler)
    provingProgress.off("stage-start", handler)
    provingProgress.emitStageStart(ProvingStage.Proving)
    expect(called).toBe(0)
  })

  it("removeAllListeners() clears every subscription", () => {
    let a = 0
    let b = 0
    provingProgress.on("stage-start", () => a++)
    provingProgress.on("stage-complete", () => b++)
    provingProgress.removeAllListeners()
    provingProgress.emitStageStart(ProvingStage.Simulating)
    provingProgress.emitStageComplete(ProvingStage.Simulating)
    expect(a).toBe(0)
    expect(b).toBe(0)
  })

  it("zero-listener emit is a no-op", () => {
    expect(() => provingProgress.emitStageStart(ProvingStage.Witgen)).not.toThrow()
    expect(() => provingProgress.emitReset()).not.toThrow()
  })
})

// ─── Additions ──────────────────────────────────────────────────────────────

const newCtx = (
  overrides: Partial<ProvingOperationContext> = {},
): ProvingOperationContext => ({
  operationId: "send_test",
  kind: "send",
  ...overrides,
})

describe("provingProgress operation-context registry", () => {
  it("happy path: register / read / clear", () => {
    const ctx = newCtx()
    provingProgress.registerOperationContext(ctx)
    expect(provingProgress.getCurrentOperationContext()).toBe(ctx)
    expect(provingProgress.getCurrentOperationId()).toBe("send_test")
    provingProgress.clearOperationContext()
    expect(provingProgress.getCurrentOperationContext()).toBeUndefined()
  })

  it("single-flight: re-register throws LocalProvingInFlight; original survives", () => {
    const original = newCtx({ operationId: "first" })
    provingProgress.registerOperationContext(original)
    expect(() =>
      provingProgress.registerOperationContext(newCtx({ operationId: "second" })),
    ).toThrow("LocalProvingInFlight")
    expect(provingProgress.getCurrentOperationContext()).toBe(original)
  })
})

describe("provingProgress hot-reload-safe singleton", () => {
  it("re-importing the module via globalThis returns the same instance", async () => {
    // Verify the singleton lives on globalThis.__obsidionProvingProgress.
    const globalKey = "__obsidionProvingProgress"
    const fromGlobal = (globalThis as unknown as Record<string, unknown>)[globalKey]
    expect(fromGlobal).toBe(provingProgress)
  })
})

describe("provingProgress getCurrentStageSnapshot", () => {
  it("returns null for an op id that has never seen events", () => {
    expect(provingProgress.getCurrentStageSnapshot("unknown_op")).toBeNull()
  })

  it("captures last-seen stage + completed set per op id", () => {
    provingProgress.emitStageStart(ProvingStage.Simulating, "snap_op_1")
    provingProgress.emitStageComplete(ProvingStage.Simulating, "snap_op_1")
    provingProgress.emitStageStart(ProvingStage.Witgen, "snap_op_1")
    const snap = provingProgress.getCurrentStageSnapshot("snap_op_1")
    expect(snap).not.toBeNull()
    expect(snap?.stage).toBe(ProvingStage.Witgen)
    expect(snap?.completed[ProvingStage.Simulating]).toBe(true)
    expect(snap?.completed[ProvingStage.Witgen]).toBe(false)
  })

  it("snapshot survives clearOperationContext", () => {
    const ctx: ProvingOperationContext = {
      operationId: "snap_op_clear",
      kind: "send",
    }
    provingProgress.registerOperationContext(ctx)
    provingProgress.emitStageStart(ProvingStage.Proving, "snap_op_clear")
    provingProgress.clearOperationContext()
    // Normal-path withProvingScope clears the registry context BEFORE submit
    // completes. The snapshot must NOT be cleared with it — the user-visible
    // stage history is still in flight.
    const snap = provingProgress.getCurrentStageSnapshot("snap_op_clear")
    expect(snap?.stage).toBe(ProvingStage.Proving)
  })

  it("registerOperationContext resets the snapshot for that op id", () => {
    provingProgress.emitStageStart(ProvingStage.Simulating, "snap_op_reuse")
    expect(provingProgress.getCurrentStageSnapshot("snap_op_reuse")?.stage).toBe(
      ProvingStage.Simulating,
    )
    const ctx: ProvingOperationContext = {
      operationId: "snap_op_reuse",
      kind: "send",
    }
    provingProgress.registerOperationContext(ctx)
    // Reset deletes the entry — fresh state means no snapshot yet.
    expect(provingProgress.getCurrentStageSnapshot("snap_op_reuse")).toBeNull()
  })

  it("does not cross-contaminate snapshots across op ids", () => {
    provingProgress.emitStageStart(ProvingStage.Simulating, "snap_op_a")
    provingProgress.emitStageStart(ProvingStage.Mining, "snap_op_b")
    expect(provingProgress.getCurrentStageSnapshot("snap_op_a")?.stage).toBe(
      ProvingStage.Simulating,
    )
    expect(provingProgress.getCurrentStageSnapshot("snap_op_b")?.stage).toBe(
      ProvingStage.Mining,
    )
  })
})
