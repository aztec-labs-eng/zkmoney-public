// Tx-cycle time benchmark DTOs — pure data, zero runtime logic, zero workspace deps.
//
// Produced by @obsidion/sdk (extractor + per-op registry emit `BenchmarkSample`) and consumed by
// the web wallet's tx_timing analytics. Carries ONLY timing
// scalars + sample metadata — never tx payload, address, recipient/amount,
// txHash, oracle names, or RPC method names.
//
// One deliberate, bounded exception: `BenchmarkSample.simFunctions[].name`
// carries a private function/circuit symbol — but ONLY a first-party
// allowlisted one (else the redaction placeholder `"<non-allowlisted>"`). The
// allowlist gate lives in the sdk extractor (`extractSimFunctions`), not here;
// core stays a logic-free leaf. Oracle names and RPC method names remain
// excluded; `oracleMs` is a nameless aggregate.

/**
 * The five benchmarked Oxide tx flows. Mirrors `@obsidion/proving-progress`
 * `OriginalFlowKind` — kept as a standalone literal union so `@obsidion/core`
 * stays a dependency-free leaf. Sourced from the `kind` send-option at capture.
 */
export type BenchmarkFlow =
  | "send"
  | "withdraw"
  | "paylink-create"
  | "paylink-claim"
  | "paylink-refund"

/**
 * Per-sample status. `ok` = all phases present; `incomplete` = a leg or a
 * prove-side stats field was missing (recorded as `incomplete`, NEVER as
 * zeros-as-data); `failed` = the underlying send threw.
 */
export type BenchmarkSampleStatus = "ok" | "incomplete" | "failed"

/**
 * Wall-clock duration (ms) of each tx-cycle phase, on the single-simulation
 * staged-execution flow (PR #443: one sim + one witgen per send, manual PXE
 * sync). Mining is excluded.
 *
 *   - `sync`:         phase 1 — the explicit `pxe.sync()` at `sendTx` entry (THE
 *                     sync for the whole send under `autoSync: false`)
 *   - `simulation`:   phase 2 — `sendTx`'s single kernelless pre-simulation
 *                     (authwit capture + gas estimation + the offchain-effects
 *                     feed the TEE finalizer consumes)
 *   - `enclave`:      phase 3 — TEE signer spend-auth roundtrip, inside the
 *                     staged-execution finalizer
 *   - `userWitgen`:   phase 4 — `executePrivate` (app/account/entrypoint circuits)
 *   - `kernelWitgen`: phase 5 — `private_kernel_*` / `hiding_kernel` witgen
 *   - `proving`:      phase 6 — `createChonkProof` (client IVC)
 */
export interface PhaseDurations {
  sync: number
  simulation: number
  enclave: number
  userWitgen: number
  kernelWitgen: number
  proving: number
}

/**
 * Per-function timing of one private function executed during the
 * simulation. `name` is a first-party allowlisted symbol (e.g.
 * `OxideToken:transfer_private_to_private`) or `"<non-allowlisted>"` — the
 * allowlist gate is enforced by the sdk extractor, never here. `witgenMs` is the
 * upstream per-function witgen time; `oracleMs` is the aggregate oracle-resolution
 * time (no oracle names). `oracleMs` is NOT a guaranteed subset of `witgenMs`
 * (upstream may report witgen exclusive of nested calls), so consumers must not
 * assume `oracleMs <= witgenMs`.
 */
export interface SimFunctionTiming {
  name: string
  witgenMs: number
  oracleMs: number
}

/**
 * One benchmarked tx. `total` = the sum of the six phases
 * (`sync + simulation + enclave + userWitgen + kernelWitgen + proving`) —
 * except on `incomplete` orphan samples (a leg never arrived), where the
 * registry pins `total` to 0 rather than presenting a partial sum as a real
 * end-to-end figure. `unaccounted` is the prove-side `stats.unaccounted`
 * passthrough (prove-leg only). Emitters leave `cold` `false`. Carries no tx-identifying data.
 *
 * `simFunctions` is an OPTIONAL additive drill-down of the simulation phase:
 * per private function, its witgen + aggregate oracle ms, from the single
 * `sendTx` pre-simulation. **Omitted** means "no sim stats available" while a
 * **present empty array** means "stats observed, no rows". Its
 * presence/absence never affects `status`.
 */
export interface BenchmarkSample {
  flow: BenchmarkFlow
  phases: PhaseDurations
  total: number
  unaccounted: number
  cold: boolean
  status: BenchmarkSampleStatus
  note?: string
  simFunctions?: SimFunctionTiming[]
  /**
   * Number of token notes the tx nullifies (spends), from the TEE leg's
   * collected offchain effects. Count only — never values or owners. Enables
   * time-vs-note-count correlation; omitted when the TEE leg never reported.
   */
  notesUsed?: number
}
