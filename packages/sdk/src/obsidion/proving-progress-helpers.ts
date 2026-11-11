import type { Logger } from "@aztec-labs/foundation/log"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { TxExecutionRequest, TxProvingResult } from "@aztec-labs/stdlib/tx"
import type { PXE } from "@aztec-labs/pxe/client/lazy"
import { ProvingStage } from "@obsidion/core/types"
import type { SendProgress } from "./sendTurns.js"

/**
 * Wraps a PXE proveTx call to report its stage. PXE reports no progress itself, so the stage comes
 * from our own call boundary: `simulating`, just before `pxe.proveTx`.
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
    /** Hears the stage under `operationId`: the send's. */
    progress?: SendProgress
    operationId?: string
  },
): Promise<TxProvingResult> {
  if (opts?.operationId) opts.progress?.stage(ProvingStage.Simulating, opts.operationId)
  if (opts?.sync) await pxe.sync()
  return pxe.proveTx(txRequest, proveOpts)
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
