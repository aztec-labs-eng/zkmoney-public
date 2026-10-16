/** Proves a plain Noir circuit in the browser, on bb.js UltraHonk's default verifier target. */
import initACVM, { compressWitness, executeCircuit } from "@aztec/noir-acvm_js/web/acvm_js.js"
import initABI, { abiEncode } from "@aztec/noir-noirc_abi/web/noirc_abi_wasm.js"
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js"

export interface NoirCircuit {
  bytecode: string
  abi: unknown
}

let wasmReady: Promise<void> | null = null
function initWasm(): Promise<void> {
  wasmReady ??= Promise.all([initACVM(), initABI()]).then(() => undefined)
  return wasmReady
}

export async function proveNoirCircuit(
  circuit: NoirCircuit,
  inputs: Record<string, unknown>,
  label: string,
): Promise<{ proof: Uint8Array; publicInputs: string[] }> {
  const started = performance.now()
  await initWasm()
  const step = (name: string) =>
    console.log(`[${label}] ${name} +${Math.round(performance.now() - started)}ms`)
  step("wasm ready")
  const witnessMap = abiEncode(circuit.abi as never, inputs as never)
  const bytecode = Uint8Array.from(atob(circuit.bytecode), (c) => c.charCodeAt(0))
  const solved = await executeCircuit(bytecode, witnessMap, () => {
    throw new Error(`${label} has no oracles — a foreign call means the wrong circuit`)
  })
  step("witness solved")
  const api = await Barretenberg.new({})
  try {
    const backend = new UltraHonkBackend(circuit.bytecode, api)
    step("backend ready")
    const result = await backend.generateProof(compressWitness(solved))
    console.log(`[${label}] proof in ${Math.round(performance.now() - started)}ms`)
    return result
  } finally {
    await api.destroy().catch(() => {})
  }
}
