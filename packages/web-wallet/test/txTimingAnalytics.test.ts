import { afterEach, describe, expect, it, vi } from "vitest"
import { benchmarkRegistry, readTimingBenchFlag, setTimingBenchFlag } from "@obsidion/sdk"
import type { BenchmarkSample } from "@obsidion/core/types"
import { txTimingProps, wireTxTimingAnalytics } from "../src/lib/txTimingAnalytics"
import { stubProvingDevice } from "./support/provingDevice"

const h = vi.hoisted(() => ({ fireEvent: vi.fn() }))
vi.mock("../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fireEvent: h.fireEvent,
}))

afterEach(() => {
  setTimingBenchFlag(undefined)
  benchmarkRegistry.setSampleSink(undefined)
  h.fireEvent.mockReset()
})

describe("txTimingProps", () => {
  it("flattens a sample to rounded per-phase durations", () => {
    const sample: BenchmarkSample = {
      flow: "paylink-create",
      phases: {
        sync: 100.4,
        simulation: 2000.6,
        enclave: 300.5,
        userWitgen: 4000.2,
        kernelWitgen: 5000.9,
        proving: 12000.1,
      },
      total: 23402.7,
      unaccounted: 12.3,
      cold: false,
      status: "ok",
      notesUsed: 3,
    }
    expect(txTimingProps(sample)).toEqual({
      flow: "paylink-create",
      status: "ok",
      notes_used: 3,
      sync_ms: 100,
      simulation_ms: 2001,
      enclave_ms: 301,
      user_witgen_ms: 4000,
      kernel_witgen_ms: 5001,
      proving_ms: 12000,
      total_ms: 23403,
    })
  })
})

describe("wireTxTimingAnalytics", () => {
  it("binds capture to the analytics consent gate (off without consent)", () => {
    wireTxTimingAnalytics()
    // No VITE_ZKMONEY_API_URL and no consent bound in tests → analyticsEnabled()
    // is false, so capture stays off too.
    expect(readTimingBenchFlag()).toBe(false)
  })

  it("sends each finished transaction's phases with the device class", () => {
    const restore = stubProvingDevice(true, 8)
    try {
      wireTxTimingAnalytics()
      benchmarkRegistry.contributeTee("op-device", { flow: "send", enclave: 300, notesUsed: 2 })
      benchmarkRegistry.contributeProve("op-device", {
        flow: "send",
        sync: 100,
        simulation: 2_000,
        userWitgen: 4_000,
        kernelWitgen: 5_000,
        proving: 12_000,
        unaccounted: 0,
        incomplete: false,
      })
      expect(h.fireEvent).toHaveBeenCalledWith("tx_timing", {
        flow: "send",
        status: "ok",
        notes_used: 2,
        sync_ms: 100,
        simulation_ms: 2_000,
        enclave_ms: 300,
        user_witgen_ms: 4_000,
        kernel_witgen_ms: 5_000,
        proving_ms: 12_000,
        total_ms: 23_400,
        cross_origin_isolated: true,
        hardware_concurrency: 8,
      })
    } finally {
      restore()
    }
  })

  it("a predicate override is re-evaluated on every read", () => {
    let on = false
    setTimingBenchFlag(() => on)
    expect(readTimingBenchFlag()).toBe(false)
    on = true
    expect(readTimingBenchFlag()).toBe(true)
  })
})
