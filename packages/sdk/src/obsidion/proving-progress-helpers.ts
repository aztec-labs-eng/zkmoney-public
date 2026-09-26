import type { Logger } from "@aztec/foundation/log"
import type { AztecAddress } from "@aztec/stdlib/aztec-address"
import type { TxExecutionRequest, TxProvingResult } from "@aztec/stdlib/tx"
import type { PXE } from "@aztec/pxe/client/lazy"
import {
  ProvingStage,
  provingProgress,
  type ProvingProgressEvent,
} from "@obsidion/proving-progress"

/**
 * Wraps a PXE proveTx call to emit proving progress. PXE reports no progress
 * itself, so the stages come from our own call boundaries.
 *
 * Emits `simulating` start immediately before `pxe.proveTx`. The matching
 * `simulating` complete + `witgen` + `proving` events fire only from an injected
 * prover that emits them. The upstream WASM prover does not, so progression is partial.
 */
export async function proveTxWithProgress(
  pxe: Pick<PXE, "proveTx" | "sync">, // Only list the functions we use to make stubbing in tests easy
  txRequest: TxExecutionRequest,
  proveOpts: { scopes: AztecAddress[]; senderForTags?: AztecAddress },
  opts?: {
    perfLog?: boolean
    logger?: Logger
    /**
     * Sync the PXE before proving.
     * Prove paths that run OUTSIDE `ObsidionWallet.sendTx` (test wallets)
     * pass `true`: with `autoSync: false` the PXE does not sync inside
     * `proveTx`, and settled-state reads fail against a stale anchor block. `sendTx`'s internal call omits it — its single
     * top-of-send sync already covers simulation, finalize, and proving.
     */
    sync?: boolean
  },
): Promise<TxProvingResult> {
  // Pass the registered op id so consumers (the synth-row stage-feed bridge,
  // the per-op stage snapshot) can correlate this stage event to a specific
  // in-flight tx. Falls back to undefined when called outside a scope (which
  // doesn't happen on the wallet's main path, but stays defensive).
  const opId = provingProgress.getCurrentOperationContext()?.operationId
  provingProgress.emitStageStart(ProvingStage.Simulating, opId)
  try {
    if (opts?.sync) {
      // Inside the try so a failure clears the Simulating stage via the
      // catch-block's `emitReset`.
      await pxe.sync()
    }
    return await pxe.proveTx(txRequest, proveOpts)
  } catch (err) {
    provingProgress.emitReset()
    throw err
  }
}

/**
 * Captures `[Perf][ProveTx]` bucket durations by subscribing to the
 * provingProgress singleton's stage events. Stable handler refs are bound
 * once in the constructor so off()-by-reference works correctly.
 *
 * Single-tx-in-flight assumption: the wallet UI gates sendTx behind a modal,
 * so only one tx is ever proving at a time. The accumulator does not
 * disambiguate events across concurrent txs — running two sendTx calls in
 * parallel will cross-contaminate timestamps. This is intentional; relax it
 * only if the UI ever permits concurrent proving.
 */
export class PerfBucketAccumulator {
  private starts: Partial<Record<ProvingStage, number>> = {}
  private ends: Partial<Record<ProvingStage, number>> = {}
  private readonly onStart: (e: ProvingProgressEvent) => void
  private readonly onComplete: (e: { stage: ProvingStage }) => void

  constructor() {
    this.onStart = (e) => {
      this.starts[e.stage] = e.startTime
    }
    this.onComplete = (e) => {
      this.ends[e.stage] = Date.now()
    }
  }

  subscribe(): void {
    provingProgress.on("stage-start", this.onStart)
    provingProgress.on("stage-complete", this.onComplete)
  }

  unsubscribe(): void {
    provingProgress.off("stage-start", this.onStart)
    provingProgress.off("stage-complete", this.onComplete)
  }

  snapshot(): { sim: number; witgen: number; prove: number } {
    return {
      sim: durationOf(this.starts[ProvingStage.Simulating], this.ends[ProvingStage.Simulating]),
      witgen: durationOf(this.starts[ProvingStage.Witgen], this.ends[ProvingStage.Witgen]),
      prove: durationOf(this.starts[ProvingStage.Proving], this.ends[ProvingStage.Proving]),
    }
  }
}

function durationOf(start: number | undefined, end: number | undefined): number {
  if (start === undefined || end === undefined) return 0
  return Math.max(0, end - start)
}

/** Reads the `proveTxPerfLogs` flag from `process.env.OBSIDION_PROVE_TX_PERF_LOGS`. Default: false. */
export function readPerfLogFlag(): boolean {
  if (typeof process !== "undefined" && process.env) {
    if (process.env.OBSIDION_PROVE_TX_PERF_LOGS === "true") return true
  }
  return false
}

/**
 * Runtime override for {@link readTimingBenchFlag}, for hosts without a build-time env.
 * A predicate is re-evaluated on every read — the browser wallet passes its live
 * analytics-consent gate, so capture follows the user's consent toggle.
 */
let timingBenchOverride: boolean | (() => boolean) | undefined

export function setTimingBenchFlag(on: boolean | (() => boolean) | undefined): void {
  timingBenchOverride = on
}

/**
 * Reads the dedicated time-performance benchmark flag (docs/plans/2026-06-03-001):
 *   1. the {@link setTimingBenchFlag} runtime override, when set
 *   2. process.env.OBSIDION_TX_TIMING_BENCH  (Node / tests)
 *
 * Independent of {@link readPerfLogFlag}. Default: false. When off, the
 * benchmark instrumentation in `ObsidionWallet.sendTx` / `buildTeeOperation`
 * is fully bypassed (no spans, no registry writes).
 */
export function readTimingBenchFlag(): boolean {
  if (typeof timingBenchOverride === "function") {
    try {
      return timingBenchOverride()
    } catch {
      return false
    }
  }
  if (timingBenchOverride !== undefined) return timingBenchOverride
  if (typeof process !== "undefined" && process.env) {
    if (process.env.OBSIDION_TX_TIMING_BENCH === "true") return true
  }
  return false
}
