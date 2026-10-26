import type { Logger } from "@aztec-labs/foundation/log"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { TxExecutionRequest, TxProvingResult } from "@aztec-labs/stdlib/tx"
import type { PXE } from "@aztec-labs/pxe/client/lazy"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"

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

/** Runtime override for {@link readPerfLogFlag}, for hosts without `process.env` (the browser). */
let perfLogOverride: boolean | undefined

export function setPerfLogFlag(on: boolean | undefined): void {
  perfLogOverride = on
}

/**
 * Reads the `[Perf][ProveTx]` log flag: the {@link setPerfLogFlag} override when set, else
 * `process.env.OBSIDION_PROVE_TX_PERF_LOGS`. Default: false.
 */
export function readPerfLogFlag(): boolean {
  if (perfLogOverride !== undefined) return perfLogOverride
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
