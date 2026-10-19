/**
 * In-browser prover for the golden ticket circuit (`packages/contracts/circuits/golden_ticket`).
 * Same machinery as the zkJWT prover: ACVM/noirc_abi `web/` WASM builds for the witness, bb.js
 * UltraHonk for the proof. Default verifier target on both sides; the account-service verifies with
 * the key pinned in `@obsidion/core`.
 */
import { fireOnboardingEvent } from "../../lib/analytics"
import {
  proveNoirCircuit,
  warmNoirProver,
  type NoirCircuit,
  type NoirProofLap,
} from "../../platform/noirProver"

const goldenTicketCircuit = async (): Promise<NoirCircuit> => {
  const m = await import(
    "../../../../contracts/src/artifacts/target/golden_ticket/golden_ticket.json"
  )
  return (m.default ?? m) as unknown as NoirCircuit
}

/** Loads the circuit and the prover ahead of the proof, which needs the passkey's owner. */
export function warmGoldenTicketProver(): Promise<void> {
  return Promise.all([goldenTicketCircuit(), warmNoirProver()]).then(() => undefined)
}

export async function proveGoldenTicketInBrowser(
  inputs: Record<string, unknown>,
): Promise<{ proof: Uint8Array; publicInputs: string[] }> {
  const circuit = await goldenTicketCircuit()
  const laps: Partial<Record<NoirProofLap, number>> = {}
  const started = performance.now()
  let status = "failed"
  try {
    const result = await proveNoirCircuit(
      circuit,
      inputs,
      "golden-ticket",
      (lap, ms) => (laps[lap] = ms),
    )
    status = "ok"
    return result
  } finally {
    // Each phase's own duration; a failed proof reports the phases it finished. No device class:
    // this event leaves the device before the consent answer.
    const between = (from?: number, to?: number) =>
      from === undefined || to === undefined ? undefined : to - from
    fireOnboardingEvent("golden_ticket_proof", {
      status,
      wasm_ms: laps.wasm,
      witness_ms: between(laps.wasm, laps.witness),
      backend_ms: between(laps.witness, laps.backend),
      prove_ms: between(laps.backend, laps.proof),
      total_ms: Math.round(performance.now() - started),
    })
  }
}
