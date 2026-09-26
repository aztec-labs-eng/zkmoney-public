/**
 * In-browser prover for the golden ticket circuit (`packages/contracts/circuits/golden_ticket`).
 * Same machinery as the zkJWT prover: ACVM/noirc_abi `web/` WASM builds for the witness, bb.js
 * UltraHonk for the proof. Default verifier target on both sides; the account-service verifies with
 * the key pinned in `@obsidion/core`.
 */
import initACVM, { compressWitness, executeCircuit } from "@aztec/noir-acvm_js/web/acvm_js.js"
import initABI, { abiEncode } from "@aztec/noir-noirc_abi/web/noirc_abi_wasm.js"
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js"

interface Circuit {
  bytecode: string
  abi: unknown
}

let _circuit: Promise<Circuit> | null = null
function getCircuit(): Promise<Circuit> {
  _circuit ??= import(
    "../../../../contracts/src/artifacts/target/golden_ticket/golden_ticket.json"
  ).then((m) => (m.default ?? m) as unknown as Circuit)
  return _circuit
}

let wasmReady: Promise<void> | null = null
function initWasm(): Promise<void> {
  wasmReady ??= Promise.all([initACVM(), initABI()]).then(() => undefined)
  return wasmReady
}

export async function proveGoldenTicketInBrowser(
  inputs: Record<string, unknown>,
): Promise<{ proof: Uint8Array; publicInputs: string[] }> {
  const started = performance.now()
  const [circuit] = await Promise.all([getCircuit(), initWasm()])
  const witnessMap = abiEncode(circuit.abi as never, inputs as never)
  const bytecode = Uint8Array.from(atob(circuit.bytecode), (c) => c.charCodeAt(0))
  const solved = await executeCircuit(bytecode, witnessMap, () => {
    throw new Error("golden ticket has no oracles — a foreign call means the wrong circuit")
  })
  const api = await Barretenberg.new({})
  try {
    const backend = new UltraHonkBackend(circuit.bytecode, api)
    const result = await backend.generateProof(compressWitness(solved))
    console.log(`[golden-ticket] proof in ${Math.round(performance.now() - started)}ms`)
    return result
  } finally {
    await api.destroy().catch(() => {})
  }
}
