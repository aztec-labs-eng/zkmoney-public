import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ProvingStage } from "@obsidion/core/types"
import type { PXE } from "@aztec-labs/pxe/client/lazy"
import {
  proveTxWithProgress,
  readPerfLogFlag,
  readTimingBenchFlag,
  setPerfLogFlag,
} from "../../src/obsidion/proving-progress-helpers.js"

beforeEach(() => {
  delete process.env.OBSIDION_PROVE_TX_PERF_LOGS
  delete process.env.OBSIDION_TX_TIMING_BENCH
})

afterEach(() => {
  setPerfLogFlag(undefined)
  delete process.env.OBSIDION_PROVE_TX_PERF_LOGS
  delete process.env.OBSIDION_TX_TIMING_BENCH
})

describe("proveTxWithProgress", () => {
  it("reports simulating under the send's id exactly once, before pxe.proveTx", async () => {
    const stages: unknown[][] = []
    let reportedAtProveTx = 0
    const stubPxe: Pick<PXE, "proveTx" | "sync"> = {
      async sync() {},
      async proveTx() {
        reportedAtProveTx = stages.length
        return { stub: true } as never
      },
    }
    await proveTxWithProgress(
      stubPxe,
      {} as never,
      { scopes: [] },
      {
        progress: { stage: (...args) => void stages.push(args), lastSendWait: () => {} },
        operationId: "op-1",
      },
    )
    expect(reportedAtProveTx).toBe(1)
    expect(stages).toEqual([[ProvingStage.Simulating, "op-1"]])
  })

  it("calls pxe.sync() before proveTx when opts.sync is set, and not otherwise", async () => {
    const calls: string[] = []
    const stubPxe: Pick<PXE, "proveTx" | "sync"> = {
      async sync() {
        calls.push("sync")
      },
      async proveTx() {
        calls.push("proveTx")
        return { stub: true } as never
      },
    }
    await proveTxWithProgress(stubPxe, {} as never, { scopes: [] }, { sync: true })
    await proveTxWithProgress(stubPxe, {} as never, { scopes: [] })
    expect(calls).toEqual(["sync", "proveTx", "proveTx"])
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

  it("follows the runtime override over the env, both ways, until it is cleared", () => {
    setPerfLogFlag(true)
    expect(readPerfLogFlag()).toBe(true)
    process.env.OBSIDION_PROVE_TX_PERF_LOGS = "true"
    setPerfLogFlag(false)
    expect(readPerfLogFlag()).toBe(false)
    setPerfLogFlag(undefined)
    expect(readPerfLogFlag()).toBe(true)
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
