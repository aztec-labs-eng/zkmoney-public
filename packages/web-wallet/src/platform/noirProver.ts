/** Proves a plain Noir circuit in the browser, on bb.js UltraHonk's default verifier target. */
import initACVM, {
  compressWitness,
  executeCircuit,
  type ExecutionError,
} from "@aztec-foundation/noir-acvm_js/web/acvm_js.js"
import initABI, {
  abiDecodeError,
  abiEncode,
} from "@aztec-foundation/noir-noirc_abi/web/noirc_abi_wasm.js"
import { Barretenberg, UltraHonkBackend } from "@aztec-foundation/bb.js"
import { createLogger } from "@aztec-labs/foundation/log"
import { barretenbergWasm } from "./bbWasmPath"

export interface NoirCircuit {
  bytecode: string
  abi: unknown
}

let wasmReady: Promise<void> | null = null
/** A failed init is not kept, so a warm-up that failed leaves the proof its own attempt. */
function initWasm(): Promise<void> {
  if (!wasmReady) {
    const ready = Promise.all([initACVM(), initABI()]).then(() => undefined)
    ready.catch(() => {
      if (wasmReady === ready) wasmReady = null
    })
    wasmReady = ready
  }
  return wasmReady
}

/** A proof's laps, each reported with the ms since the proof started. */
export type NoirProofLap = "wasm" | "witness" | "backend" | "proof"

/**
 * bb.js's page-wide instance, the one the PXE's ClientIVC prover takes too, so the wasm module, its
 * worker pool and the reference string load once. It outlives every proof. The logger is the one
 * the PXE's prover would pass, so its thread-count line still prints.
 */
export function proverBackend(): Promise<Barretenberg> {
  return Barretenberg.initSingleton({
    logger: createLogger("pxe:prover").verbose,
    ...barretenbergWasm(),
  })
}

/** The simulator's wasm, which the PXE shares: started ahead of a page's first simulation. */
export const warmNoirWasm = initWasm

/** Starts the witness wasm and the proving backend, so a later proof finds both ready. */
export function warmNoirProver(): Promise<void> {
  return Promise.all([initWasm(), proverBackend()]).then(() => undefined)
}

/** A failed assert as the circuit's own message, when its ABI names one; else the error as thrown. */
function circuitError(circuit: NoirCircuit, err: unknown): unknown {
  const payload = (err as ExecutionError | undefined)?.rawAssertionPayload
  if (!payload) return err
  try {
    const message: unknown = abiDecodeError(circuit.abi as never, payload)
    return typeof message === "string" ? new Error(message, { cause: err }) : err
  } catch {
    return err
  }
}

export async function proveNoirCircuit(
  circuit: NoirCircuit,
  inputs: Record<string, unknown>,
  label: string,
  onLap?: (lap: NoirProofLap, ms: number) => void,
): Promise<{ proof: Uint8Array; publicInputs: string[] }> {
  const started = performance.now()
  await initWasm()
  const lap = (name: NoirProofLap) => {
    const ms = Math.round(performance.now() - started)
    onLap?.(name, ms)
    return ms
  }
  const step = (name: NoirProofLap, text: string) =>
    console.log(`[${label}] ${text} +${lap(name)}ms`)
  step("wasm", "wasm ready")
  const witnessMap = abiEncode(circuit.abi as never, inputs as never)
  const bytecode = Uint8Array.from(atob(circuit.bytecode), (c) => c.charCodeAt(0))
  const solved = await executeCircuit(bytecode, witnessMap, () => {
    throw new Error(`${label} has no oracles — a foreign call means the wrong circuit`)
  }).catch((err: unknown) => {
    throw circuitError(circuit, err)
  })
  step("witness", "witness solved")
  const backend = new UltraHonkBackend(circuit.bytecode, await proverBackend())
  step("backend", "backend ready")
  const result = await backend.generateProof(compressWitness(solved))
  console.log(`[${label}] proof in ${lap("proof")}ms`)
  return result
}
