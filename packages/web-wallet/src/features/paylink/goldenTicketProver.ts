/**
 * In-browser prover for the golden ticket circuit (`packages/contracts/circuits/golden_ticket`).
 * Same machinery as the zkJWT prover: ACVM/noirc_abi `web/` WASM builds for the witness, bb.js
 * UltraHonk for the proof. Default verifier target on both sides; the account-service verifies with
 * the key pinned in `@obsidion/core`.
 */
import { proveNoirCircuit, type NoirCircuit } from "../../platform/noirProver"

export async function proveGoldenTicketInBrowser(
  inputs: Record<string, unknown>,
): Promise<{ proof: Uint8Array; publicInputs: string[] }> {
  const m = await import(
    "../../../../contracts/src/artifacts/target/golden_ticket/golden_ticket.json"
  )
  return proveNoirCircuit((m.default ?? m) as unknown as NoirCircuit, inputs, "golden-ticket")
}
