import { benchmarkRegistry, setTimingBenchFlag } from "@obsidion/sdk"
import type { BenchmarkSample } from "@obsidion/core/types"
import { analyticsEnabled, fireEvent, type AnalyticsProps } from "./analytics"

/** Flatten a benchmark sample to tx_timing props: flow kind, status, note count, rounded phase durations. */
export function txTimingProps(s: BenchmarkSample): AnalyticsProps {
  return {
    flow: s.flow,
    status: s.status,
    notes_used: s.notesUsed,
    sync_ms: Math.round(s.phases.sync),
    simulation_ms: Math.round(s.phases.simulation),
    enclave_ms: Math.round(s.phases.enclave),
    user_witgen_ms: Math.round(s.phases.userWitgen),
    kernel_witgen_ms: Math.round(s.phases.kernelWitgen),
    proving_ms: Math.round(s.phases.proving),
    total_ms: Math.round(s.total),
  }
}

/**
 * Sink per-tx phase timings into analytics as `tx_timing` events: one event per
 * completed tx, with the full lifecycle breakdown — sync, simulation, enclave
 * (oxide/TEE sign), userWitgen, kernelWitgen, proving. The sdk capture flag is
 * bound to the live analytics consent gate, so a user with analytics off runs
 * no timing spans at all — and flipping consent in Settings takes effect on the
 * next tx, both ways. Emission re-checks the same gate inside `fireEvent`.
 * Durations and flow kind only — no payment data. Separate module from
 * `analytics.ts` so that file stays sdk-free (its tests run in node without
 * the wallet stack).
 */
export function wireTxTimingAnalytics(): void {
  setTimingBenchFlag(analyticsEnabled)
  benchmarkRegistry.setSampleSink((s) => fireEvent("tx_timing", txTimingProps(s)))
}
