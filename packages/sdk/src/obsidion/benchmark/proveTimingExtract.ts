// Prove-side phase extractor (docs/plans/2026-06-03-001, U2). Pure.
//
// Maps upstream `@aztec-labs/pxe` `ProvingTimings` (returned on `TxProvingResult.stats`)
// to the benchmark's prove-side phase scalars. Splits `perFunction[]` by
// `functionName` prefix into UserWitgen vs KernelWitgen. Reads ONLY numeric
// timing fields — never `oracles` / `nodeRPCCalls` (privacy).

import type { ProvingTimings } from "@aztec-labs/stdlib/tx"

/**
 * `performance.now()` guarded so a benchmark clock failure can never throw into
 * the send path — it returns 0 instead of propagating, so the worst case is a
 * bogus span value on that one rep, never a failed send. Used by every
 * benchmark span (`ObsidionWallet.sendTx`, `buildTeeOperation`) to uphold the
 * "capture may produce incomplete data, never a send failure" invariant.
 */
export function benchNow(): number {
  try {
    return performance.now()
  } catch {
    return 0
  }
}

/** Prove-side phase scalars (ms) — phases 4/5/6 + the residual sync + cross-check totals. */
export interface ProveTimingScalars {
  /**
   * Residual prove-side sync reported by upstream stats. ~0 under the
   * manual-sync PXE (`proveTx` no longer syncs internally; `sendTx` syncs
   * once at entry and spans that itself) — summed into the sample's `sync`
   * phase alongside the wallet's entry-sync span so any upstream residual
   * stays visible instead of silently dropped.
   */
  sync: number
  /** phase 4 — sum of non-kernel perFunction times (app/account/entrypoint) */
  userWitgen: number
  /** phase 5 — sum of private_kernel_* / hiding_kernel perFunction times */
  kernelWitgen: number
  /** phase 6 — createChonkProof (client IVC) */
  proving: number
  /** cross-check: upstream-reported total */
  total: number
  /** cross-check: upstream-reported unaccounted remainder */
  unaccounted: number
}

/** Function-name prefixes whose witgen time is the protocol-kernel phase. */
const KERNEL_PREFIXES = ["private_kernel_", "hiding_kernel"] as const

function isKernelFunction(functionName: string): boolean {
  return KERNEL_PREFIXES.some((prefix) => functionName.startsWith(prefix))
}

function splitWitgen(perFunction: ProvingTimings["perFunction"]): {
  userWitgen: number
  kernelWitgen: number
} {
  let userWitgen = 0
  let kernelWitgen = 0
  for (const fn of perFunction) {
    if (isKernelFunction(fn.functionName)) kernelWitgen += fn.time
    else userWitgen += fn.time
  }
  return { userWitgen, kernelWitgen }
}

/**
 * Extract prove-side phase scalars from upstream `ProvingTimings`.
 *
 * Returns `null` when `timings` is absent or its `proving` field is undefined
 * (sim/fakeProofs build, or a misconfigured run) — the caller marks the sample
 * `incomplete` rather than recording zeros-as-data. Never copies `oracles`.
 */
export function extractProveTimings(
  timings: ProvingTimings | undefined,
): ProveTimingScalars | null {
  if (!timings || timings.proving === undefined) return null

  const { userWitgen, kernelWitgen } = splitWitgen(timings.perFunction)

  return {
    sync: timings.sync ?? 0,
    userWitgen,
    kernelWitgen,
    proving: timings.proving,
    total: timings.total,
    unaccounted: timings.unaccounted,
  }
}

/**
 * The `[Perf][ProveTx]` console line. The prove-side split comes from the PXE's own proving stats;
 * `proving=none` means the PXE made no proof (fake proofs).
 */
export function formatProveTxPerfLine(parts: {
  preProveMs: number
  simulationMs: number
  proveTimings: ProvingTimings | undefined
  totalMs: number
}): string {
  const ms = (v: number): string => `${Math.round(v)}ms`
  const fields = [`pre_prove=${ms(parts.preProveMs)}`, `sim=${ms(parts.simulationMs)}`]
  const t = parts.proveTimings
  if (t) {
    const { userWitgen, kernelWitgen } = splitWitgen(t.perFunction)
    fields.push(
      `sync=${ms(t.sync ?? 0)}`,
      `user_witgen=${ms(userWitgen)}`,
      `kernel_witgen=${ms(kernelWitgen)}`,
      `proving=${t.proving === undefined ? "none" : ms(t.proving)}`,
      `pxe_total=${ms(t.total)}`,
    )
  } else {
    fields.push("prove_stats=none")
  }
  fields.push(`total=${ms(parts.totalMs)}`)
  return `[Perf][ProveTx] ${fields.join(" ")}`
}
