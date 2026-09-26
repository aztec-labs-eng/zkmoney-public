import { DA_GAS_PER_FIELD, L2_GAS_PER_PRIVATE_LOG, PRIVATE_LOG_SIZE_IN_FIELDS } from "@aztec/constants"
import { Gas } from "@aztec/stdlib/gas"
import type { ExecutionPayload } from "@aztec/stdlib/tx"
import type { TxSimulationResultWithAppOffset } from "@aztec/aztec.js/wallet"

/**
 * Staged execution: the generic wallet-side primitive that lets a payload be
 * *finalized* against the wallet's own pre-simulation before proving.
 *
 * Some flows (today: the oxide/TEE oxide-token dispatch) cannot know their
 * production payload upfront — the payload depends on data derived from a
 * simulation of a *preparatory* payload (e.g. side effects that an external
 * signer attests over, whose signatures then ride capsules in the production
 * payload). Without this primitive those flows must run their own simulation
 * before `wallet.sendTx`, which then simulates AGAIN internally — two full
 * PXE passes (sync + private execution + public simulation) where one
 * suffices.
 *
 * With staged execution the wallet runs its single internal simulation
 * (authwit capture + gas estimation) on the preparatory payload, hands the
 * result to the caller-supplied {@link PayloadFinalizer}, and proves whatever
 * payload the finalizer returns. The wallet keeps ownership of:
 *
 *   - the simulation (and therefore the PXE sync point),
 *   - authwit capture (witnesses from the simulation are attached to the
 *     finalized payload),
 *   - gas limits: set to the simulation-derived estimate plus the
 *     finalizer-declared {@link FinalizedPayload.gasDelta},
 *   - enforcement: after proving, the wallet checks the proven tx's metered
 *     gas against the limits it set ({@link assertProvenGasWithinLimits})
 *     BEFORE submitting (the private kernel tail independently asserts the
 *     same bound in-circuit), so an under-declared delta fails locally with
 *     an actionable error instead of an opaque node rejection.
 *
 * The delta is declared as `Gas`, not as side-effect counts the wallet would
 * price itself: only PRIVATE additions have gas derivable from countable
 * effects. A finalizer that appends public calls has a delta measured by
 * execution, which no facts-based declaration can express. Finalizers whose
 * additions are private logs (today's only consumer: oxide `publish_da`)
 * can compute their delta with {@link priceDeclaredEffectDeltas}, which
 * mirrors the protocol's metering constants.
 *
 * This module is intentionally free of any oxide/TEE imports — the wallet is
 * aware of the *shape* (staged payloads with a declared gas delta), not of
 * any particular application protocol.
 */

/**
 * Private side effects a finalized payload emits beyond those observed in
 * the wallet's pre-simulation. This is NOT part of the wallet-facing
 * finalize contract (which takes a {@link FinalizedPayload.gasDelta} `Gas`
 * value) — it is the input shape of the producer-side pricing helper
 * {@link priceDeclaredEffectDeltas}, for finalizers whose additions are
 * private logs.
 *
 * Only private logs are representable today because that is the only delta
 * the current consumer (oxide `publish_da`) produces. Extend with
 * note-hash / nullifier / L2→L1-message counts if a future finalizer needs
 * them — and mirror the corresponding `meterGasUsed` terms in
 * {@link priceDeclaredEffectDeltas} when doing so.
 */
export interface DeclaredEffectDeltas {
  /**
   * One entry per additional private log, holding the log's *emitted length*
   * in fields (`PrivateLog.emittedLength`: the leading tag field plus the
   * payload fields actually written, NOT the padded maximum).
   */
  privateLogEmittedLengths: number[]
}

/** What a {@link PayloadFinalizer} returns. */
export interface FinalizedPayload {
  /**
   * The production payload to prove and submit. Must carry the same fee leg
   * (same `feePayer`, same fee-setup call shape) as the preparatory payload
   * the wallet simulated — the wallet's fee options were computed from that
   * payload and are NOT re-derived after finalization.
   */
  payload: ExecutionPayload
  /**
   * Additional gas `payload` consumes beyond the pre-simulation's estimate.
   * The wallet adds this to the simulation-derived gas limits verbatim;
   * both the private kernel tail (in-circuit) and the wallet's
   * pre-submission guard fail the send locally if the declaration was too
   * low. Omit when the finalized payload consumes exactly what was
   * simulated.
   *
   * Declared as `Gas` rather than as side-effect counts so the contract
   * covers finalizers whose additions include public calls (whose gas is
   * measured by execution, not derivable from effect counts). For pure
   * private-log additions, compute it with
   * {@link priceDeclaredEffectDeltas}.
   */
  gasDelta?: Gas
}

/**
 * Maps the wallet's pre-simulation result to the production payload.
 *
 * Invoked by `ObsidionWallet.sendTx` exactly once per send, after the
 * internal simulation and before fee-option freezing / proving. Runs OUTSIDE
 * the proving scope — a throw here surfaces as a plain `sendTx` rejection
 * with no proving-progress terminal state to clean up.
 *
 * Contract for implementers:
 *   - MUST NOT call back into `wallet.sendTx` (single-flight proving).
 *   - MUST return a payload whose fee leg matches the simulated payload's
 *     (enforced by a feePayer equality check in `sendTx`).
 *   - SHOULD complete promptly; this sits on the user-facing send path.
 *     Network legs (e.g. a remote signer) should carry their own timeouts.
 */
export type PayloadFinalizer = (
  simulationResult: TxSimulationResultWithAppOffset,
) => Promise<FinalizedPayload>

/**
 * Thrown by {@link priceDeclaredEffectDeltas} when a declaration is
 * structurally invalid (non-integer / out-of-range log length). Indicates a
 * finalizer bug, not a chain condition.
 */
export class InvalidEffectDeltasError extends Error {
  override readonly name = "InvalidEffectDeltasError"
}

/**
 * Producer-side pricing helper: converts {@link DeclaredEffectDeltas} into
 * the additional `Gas` a finalized payload will consume over the
 * pre-simulation's `gasUsed`, for finalizers whose additions are private
 * logs. The result is what such a finalizer returns as
 * {@link FinalizedPayload.gasDelta}.
 *
 * Mirrors the private-log terms of the kernel-side `meterGasUsed`
 * (`@aztec/pxe` `contract_function_simulator.js`), which both the kernelless
 * simulation mirror and the real private-kernel-tail circuit implement:
 *
 *   - DA gas:  every private log contributes `emittedLength + 1` fields
 *     (the `+ 1` is the log-length field the tx effect serialization adds),
 *     each costing `DA_GAS_PER_FIELD`.
 *   - L2 gas:  `L2_GAS_PER_PRIVATE_LOG` per log. NOTE: unlike note hashes /
 *     nullifiers, the per-log L2 constant is the same in the private-only
 *     and with-public-calls metering branches, so this pricing is valid for
 *     both tx shapes.
 *
 * The result is intentionally exact — no padding. `sendTx` adds the
 * returned delta to the simulation-derived `gasLimits` (which upstream
 * `getGasLimits` computes with padding `0` in this wallet) and the proven
 * tx is checked against the sum (in-circuit by the kernel tail, and via
 * {@link assertProvenGasWithinLimits} before submission), so any drift
 * between this formula and the protocol's fails loudly before anything
 * reaches the node.
 */
export function priceDeclaredEffectDeltas(deltas: DeclaredEffectDeltas | undefined): Gas {
  const lengths = deltas?.privateLogEmittedLengths ?? []
  if (lengths.length === 0) {
    return Gas.empty()
  }
  for (const len of lengths) {
    if (!Number.isInteger(len) || len < 1 || len > PRIVATE_LOG_SIZE_IN_FIELDS) {
      throw new InvalidEffectDeltasError(
        `Invalid declared private log emittedLength ${len}: must be an integer in [1, ${PRIVATE_LOG_SIZE_IN_FIELDS}]`,
      )
    }
  }
  const daFields = lengths.reduce((acc, len) => acc + len + 1, 0)
  return Gas.from({
    daGas: daFields * DA_GAS_PER_FIELD,
    l2Gas: lengths.length * L2_GAS_PER_PRIVATE_LOG,
  })
}

/**
 * Thrown by `sendTx` right before submission when the proven tx's metered
 * gas (`provenTx.publicInputs.gasUsed` — the private-kernel-tail accounting,
 * which embeds the teardown gas LIMITS plus the fixed tx overhead) exceeds
 * the gas limits the wallet set on the tx request.
 *
 * Defense-in-depth: the private kernel tail already asserts
 * `gasUsed <= gasLimits` in-circuit, so an over-limit tx normally fails
 * during `proveTx` with "Circuit execution failed: The gas used exceeds the
 * gas limits" and never reaches this check. This guard exists for any path
 * where a proven tx materializes over-limit anyway (kernel semantics drift
 * across versions) — it is nearly free and turns a node-side rejection into
 * a typed local error.
 *
 * For staged sends, over-limit means the finalizer's
 * {@link DeclaredEffectDeltas} under-declared what the finalized payload
 * emits. For plain sends it means the simulation-derived estimate diverged
 * from proving (e.g. PXE state changed between the two) — also worth
 * surfacing loudly.
 */
export class ProvenGasExceedsLimitsError extends Error {
  override readonly name = "ProvenGasExceedsLimitsError"
  constructor(
    public readonly gasUsed: Gas,
    public readonly gasLimits: Gas,
    detail: string,
  ) {
    super(
      `Proven tx gas exceeds the limits set at estimation time ` +
        `(used da=${gasUsed.daGas} l2=${gasUsed.l2Gas}, ` +
        `limits da=${gasLimits.daGas} l2=${gasLimits.l2Gas}). ${detail}`,
    )
  }
}

/**
 * Pre-submission guard: assert the proven tx's metered gas fits the limits
 * the wallet set. See {@link ProvenGasExceedsLimitsError} for semantics.
 */
export function assertProvenGasWithinLimits(gasUsed: Gas, gasLimits: Gas, detail: string): void {
  if (gasUsed.daGas > gasLimits.daGas || gasUsed.l2Gas > gasLimits.l2Gas) {
    throw new ProvenGasExceedsLimitsError(gasUsed, gasLimits, detail)
  }
}
