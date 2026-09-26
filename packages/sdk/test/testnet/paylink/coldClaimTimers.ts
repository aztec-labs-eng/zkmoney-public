/**
 * Timing + diagnostics instrumentation for the direct-paylink cold-claim
 * benchmark. Pure, offline-testable: the testnet suite feeds it per-rep phase
 * timings and diagnostics; this module aggregates and shapes a secret-safe
 * report.
 *
 * Two design points the plan calls out:
 *  - p10/p90 are NOT estimable at small N — below `MIN_PERCENTILE_SAMPLES` we
 *    report min/median/max + raw samples only, flagged `smallSample`.
 *  - the headline "dominant phase" excludes the WASM `prove` phase, which is
 *    not device-representative; a separate raw ranking keeps it (flagged).
 */
import { performance } from "node:perf_hooks"

/** Phase label -> elapsed ms for a single claim. */
export type PhaseSample = Record<string, number>

/** Below this sample count, p10/p90 are reported as range, not tail. */
export const MIN_PERCENTILE_SAMPLES = 8

/** Phases whose absolute ms is not representative of the device (WASM host). */
export const NON_REPRESENTATIVE_PHASES = ["prove"] as const

export interface PhaseStats {
  phase: string
  min: number
  median: number
  max: number
  /** Raw per-rep values, always included so a reader sees the sample set. */
  samples: number[]
  /** Present only when N >= MIN_PERCENTILE_SAMPLES. */
  p10?: number
  p90?: number
  /** True when N < MIN_PERCENTILE_SAMPLES (min/median/max are a range, not tails). */
  smallSample: boolean
}

export interface ClaimDiagnostics {
  /** Anchor block adopted at the start of the claim. */
  anchorBlock?: number
  /** Blocks the cold sync walked (synced-header delta). */
  blocksWalked?: number
  /** Scopes scanned during note-discovery (best-effort; may be absent). */
  scopesScanned?: number
}

export interface DominantPhase {
  phase: string
  median: number
}

/** Labeled wall-clock timer. One instance per claim. */
export class PhaseTimer {
  private readonly marks = new Map<string, number>()
  private readonly durations: PhaseSample = {}

  begin(label: string): void {
    this.marks.set(label, performance.now())
  }

  end(label: string): void {
    const t0 = this.marks.get(label)
    if (t0 === undefined) throw new Error(`PhaseTimer.end("${label}") called before begin`)
    this.durations[label] = performance.now() - t0
    this.marks.delete(label)
  }

  /** Time an async phase. */
  async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.begin(label)
    try {
      return await fn()
    } finally {
      this.end(label)
    }
  }

  result(): PhaseSample {
    return { ...this.durations }
  }
}

/** Linear-interpolated quantile over a non-empty ascending-sorted array. */
function quantile(sorted: number[], q: number): number {
  const n = sorted.length
  if (n === 0) return NaN
  if (n === 1) return sorted[0]!
  const pos = (n - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  const lo = sorted[base]!
  const hi = sorted[base + 1]
  return hi !== undefined ? lo + rest * (hi - lo) : lo
}

export function aggregatePhase(phase: string, samples: number[]): PhaseStats {
  const sorted = [...samples].sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) {
    return { phase, min: NaN, median: NaN, max: NaN, samples, smallSample: true }
  }
  const smallSample = n < MIN_PERCENTILE_SAMPLES
  const stats: PhaseStats = {
    phase,
    min: sorted[0]!,
    median: quantile(sorted, 0.5),
    max: sorted[n - 1]!,
    samples,
    smallSample,
  }
  if (!smallSample) {
    stats.p10 = quantile(sorted, 0.1)
    stats.p90 = quantile(sorted, 0.9)
  }
  return stats
}

/** Aggregate per-rep phase samples into per-phase stats over the union of labels. */
export function aggregateReps(reps: PhaseSample[]): PhaseStats[] {
  const phases = new Set<string>()
  for (const rep of reps) for (const label of Object.keys(rep)) phases.add(label)
  return [...phases].map((phase) =>
    aggregatePhase(
      phase,
      reps.map((rep) => rep[phase]).filter((v): v is number => typeof v === "number"),
    ),
  )
}

function isNonRepresentative(phase: string): boolean {
  return (NON_REPRESENTATIVE_PHASES as readonly string[]).includes(phase)
}

/**
 * The phase with the largest median. By default excludes the non-representative
 * (WASM `prove`) phase so the headline is the device-meaningful leader; pass
 * `{ excludeNonRepresentative: false }` for the raw all-phase ranking.
 */
export function dominantPhase(
  stats: PhaseStats[],
  opts: { excludeNonRepresentative: boolean } = { excludeNonRepresentative: true },
): DominantPhase | undefined {
  const pool = opts.excludeNonRepresentative
    ? stats.filter((s) => !isNonRepresentative(s.phase))
    : stats
  if (pool.length === 0) return undefined
  const top = pool.reduce((m, s) => (s.median > m.median ? s : m), pool[0]!)
  return { phase: top.phase, median: top.median }
}

/** Long hex (addresses/secrets/keys) and any URL — the shapes a report must never carry. */
const SECRET_PATTERNS: RegExp[] = [/0x[0-9a-fA-F]{40,}/, /https?:\/\//i]

/** Throw if any string anywhere in `value` looks like a secret, key, or URL. */
export function assertNoSecrets(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    for (const re of SECRET_PATTERNS) {
      if (re.test(value)) {
        throw new Error(`coldClaimTimers: possible secret/URL in report at ${path}`)
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`))
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertNoSecrets(v, `${path}.${k}`)
  }
}

export interface ColdClaimReport {
  reps: number
  cold: { phases: PhaseStats[]; diagnostics: ClaimDiagnostics[] }
  warm: { phases: PhaseStats[]; diagnostics: ClaimDiagnostics[] }
  /** Headline: largest-median phase EXCLUDING the WASM prove phase. */
  representativeDominant?: DominantPhase
  /** Raw largest-median phase (prove flagged non-representative if it wins). */
  rawDominant?: DominantPhase
  /** Median cold-minus-warm per phase (positive = warm faster). */
  coldVsWarmDelta: Record<string, number>
  notes: string[]
}

export interface ColdClaimReportInput {
  coldReps: PhaseSample[]
  warmReps: PhaseSample[]
  coldDiagnostics: ClaimDiagnostics[]
  warmDiagnostics: ClaimDiagnostics[]
}

export function buildColdClaimReport(input: ColdClaimReportInput): ColdClaimReport {
  const coldPhases = aggregateReps(input.coldReps)
  const warmPhases = aggregateReps(input.warmReps)
  const rawDominant = dominantPhase(coldPhases, { excludeNonRepresentative: false })
  const representativeDominant = dominantPhase(coldPhases, { excludeNonRepresentative: true })

  const warmByPhase = new Map(warmPhases.map((p) => [p.phase, p.median]))
  const coldVsWarmDelta: Record<string, number> = {}
  for (const p of coldPhases) {
    const warmMedian = warmByPhase.get(p.phase)
    if (warmMedian !== undefined) coldVsWarmDelta[p.phase] = p.median - warmMedian
  }

  const notes: string[] = []
  if (input.coldReps.length < MIN_PERCENTILE_SAMPLES) {
    notes.push(`N=${input.coldReps.length}: min/median/max are a range, not tail estimates.`)
  }
  if (rawDominant && isNonRepresentative(rawDominant.phase)) {
    notes.push(
      `Raw dominant phase "${rawDominant.phase}" is host-WASM proving, NOT device-representative — ` +
        `headline uses the representative ranking instead.`,
    )
  }
  if (input.coldDiagnostics.some((d) => d.scopesScanned === undefined)) {
    notes.push("scopes-scanned diagnostic unavailable on some reps (best-effort).")
  }

  const report: ColdClaimReport = {
    reps: input.coldReps.length,
    cold: { phases: coldPhases, diagnostics: input.coldDiagnostics },
    warm: { phases: warmPhases, diagnostics: input.warmDiagnostics },
    representativeDominant,
    rawDominant,
    coldVsWarmDelta,
    notes,
  }
  // Fail closed: the report is persisted, so it must never carry a secret/URL.
  assertNoSecrets(report)
  return report
}
