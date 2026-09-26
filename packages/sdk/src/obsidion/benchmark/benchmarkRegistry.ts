// Per-operation benchmark registry (docs/plans/2026-06-03-001, U2). sdk-owned.
//
// Correlates the two instrumentation legs of a benchmarked tx — the TEE leg
// (the staged-execution finalizer in `teeOperation.ts`: the `enclave` phase)
// and the prove leg (`ObsidionWallet.sendTx`: `sync`/`simulation` + the prove
// phases) — keyed by `options.operationId`. When BOTH legs have reported for
// an id, it auto-finalizes a core `BenchmarkSample` and emits it via the
// registered sink. No orchestrator owns the finalize, so coverage is
// orchestrator-independent (every benchmarked flow runs `buildTeeOperation`'s
// finalizer inside `sendTx`).
//
// Emits core DTOs only; never imports front-core. All public methods are
// defensively wrapped — a benchmark bug must NEVER throw into the real send.

import type { BenchmarkFlow, BenchmarkSample, SimFunctionTiming } from "@obsidion/core/types"

/** TEE-leg contribution (the `enclave` phase + spent-note count), from the finalizer. */
export interface TeeLegContribution {
  flow: BenchmarkFlow
  enclave: number
  /** Notes the tx nullifies — count only, never values. */
  notesUsed?: number
}

/**
 * Prove-leg contribution (every phase except `enclave`), from `sendTx`
 * post-submit. `sync` is the wall-clock of the explicit entry `pxe.sync()` plus
 * the residual prove-stats sync (~0 under manual sync); `simulation` is the
 * single kernelless pre-simulation.
 */
export interface ProveLegContribution {
  flow: BenchmarkFlow
  sync: number
  simulation: number
  userWitgen: number
  kernelWitgen: number
  proving: number
  unaccounted: number
  /** true when prove-side stats were missing — finalizes as `incomplete`. */
  incomplete: boolean
  /** Per-function breakdown of the simulation; `undefined` when stats absent. */
  simFunctions?: SimFunctionTiming[]
}

export type BenchmarkSampleSink = (sample: BenchmarkSample) => void

interface PartialEntry {
  tee?: TeeLegContribution
  prove?: ProveLegContribution
  createdAt: number
}

/** Hard caps so a leaked single-leg op can never grow the map unbounded. */
const MAX_PARTIALS = 32
const PARTIAL_TTL_MS = 5 * 60 * 1000

function finalize(tee: TeeLegContribution, prove: ProveLegContribution): BenchmarkSample {
  const total =
    prove.sync +
    prove.simulation +
    tee.enclave +
    prove.userWitgen +
    prove.kernelWitgen +
    prove.proving
  const sample: BenchmarkSample = {
    flow: prove.flow,
    phases: {
      sync: prove.sync,
      simulation: prove.simulation,
      enclave: tee.enclave,
      userWitgen: prove.userWitgen,
      kernelWitgen: prove.kernelWitgen,
      proving: prove.proving,
    },
    total,
    unaccounted: prove.unaccounted,
    cold: false,
    status: prove.incomplete ? "incomplete" : "ok",
  }
  if (prove.simFunctions !== undefined) sample.simFunctions = prove.simFunctions
  if (tee.notesUsed !== undefined) sample.notesUsed = tee.notesUsed
  return sample
}

/** Surface a single-leg orphan (abandoned / TTL-evicted) as `incomplete`. */
function finalizeOrphan(entry: PartialEntry): BenchmarkSample {
  const { tee, prove } = entry
  const sample: BenchmarkSample = {
    flow: prove?.flow ?? tee?.flow ?? "send",
    phases: {
      sync: prove?.sync ?? 0,
      simulation: prove?.simulation ?? 0,
      enclave: tee?.enclave ?? 0,
      userWitgen: prove?.userWitgen ?? 0,
      kernelWitgen: prove?.kernelWitgen ?? 0,
      proving: prove?.proving ?? 0,
    },
    total: 0,
    unaccounted: 0,
    cold: false,
    status: "incomplete",
    note: `orphan: missing ${tee ? "prove" : "tee"} leg`,
  }
  if (prove?.simFunctions !== undefined) sample.simFunctions = prove.simFunctions
  if (tee?.notesUsed !== undefined) sample.notesUsed = tee.notesUsed
  return sample
}

class BenchmarkRegistry {
  private readonly partials = new Map<string, PartialEntry>()
  private sink: BenchmarkSampleSink | undefined

  /** Register (or clear with `undefined`) the sample sink. */
  setSampleSink(sink: BenchmarkSampleSink | undefined): void {
    this.sink = sink
  }

  /** Contribute the TEE leg (the `enclave` phase) for `operationId`. */
  contributeTee(operationId: string, data: TeeLegContribution): void {
    this.merge(operationId, (e) => {
      e.tee = data
    })
  }

  /** Contribute the prove leg (every phase except `enclave`) for `operationId`. */
  contributeProve(operationId: string, data: ProveLegContribution): void {
    this.merge(operationId, (e) => {
      e.prove = data
    })
  }

  private merge(operationId: string, apply: (e: PartialEntry) => void): void {
    try {
      this.evictStale()
      const entry = this.partials.get(operationId) ?? { createdAt: Date.now() }
      apply(entry)
      this.partials.set(operationId, entry)
      if (entry.tee && entry.prove) {
        this.partials.delete(operationId)
        this.emit(finalize(entry.tee, entry.prove))
      } else {
        this.enforceCap()
      }
    } catch {
      // Benchmark capture must never throw into the real send path.
    }
  }

  /**
   * Drop `operationId`'s partial. A single-leg orphan (the other leg never
   * arrived — e.g. a pre-submit error) is surfaced as an `incomplete` sample
   * so the driver can fail loud; a fully-finalized op is a no-op (its entry
   * was already deleted on finalize).
   */
  abandon(operationId: string): void {
    try {
      const entry = this.partials.get(operationId)
      if (!entry) return
      this.partials.delete(operationId)
      if (entry.tee || entry.prove) this.emit(finalizeOrphan(entry))
    } catch {
      // never throw into the caller
    }
  }

  private emit(sample: BenchmarkSample): void {
    try {
      this.sink?.(sample)
    } catch {
      // a misbehaving sink must not break capture
    }
  }

  private evictStale(): void {
    const now = Date.now()
    for (const [id, entry] of this.partials) {
      if (now - entry.createdAt > PARTIAL_TTL_MS) {
        this.partials.delete(id)
        this.emit(finalizeOrphan(entry))
      }
    }
  }

  private enforceCap(): void {
    while (this.partials.size > MAX_PARTIALS) {
      const oldest = this.partials.keys().next().value
      if (oldest === undefined) break
      const entry = this.partials.get(oldest)
      this.partials.delete(oldest)
      if (entry) this.emit(finalizeOrphan(entry))
    }
  }
}

/** Process-wide singleton — both instrumentation legs write into this. */
export const benchmarkRegistry = new BenchmarkRegistry()
