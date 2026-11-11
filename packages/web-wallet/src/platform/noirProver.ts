/** Proves a plain Noir circuit in the browser, on bb.js UltraHonk. */
import initACVM, {
  compressWitness,
  executeCircuit,
  type ExecutionError,
} from "@aztec-foundation/noir-acvm_js/web/acvm_js.js"
import initABI, {
  abiDecodeError,
  abiEncode,
} from "@aztec-foundation/noir-noirc_abi/web/noirc_abi_wasm.js"
import { UltraHonkBackend } from "@aztec-foundation/bb.js"
import type { VerifierTarget } from "@aztec-foundation/bb.js"
import { WalletError } from "@obsidion/core/errors"
import { proverBackend } from "./barretenberg"
import type { IosSettings } from "./barretenberg"

export interface NoirCircuit {
  bytecode: string
  abi: unknown
}

/** Starts the witness wasm. The page keeps one start; a worker starts it per proof. */
export const initNoirWasm = (): Promise<void> =>
  Promise.all([initACVM(), initABI()]).then(() => undefined)

/** The witness wasm a proof waits for. */
export type NoirWasm = () => Promise<void>

/** A proof's laps, each reported with the ms since the proof started. */
export type NoirProofLap = "wasm" | "witness" | "backend" | "proof"
type OnLap = (lap: NoirProofLap, ms: number) => void

/** Starts the witness wasm and the proving backend, so a later proof finds both ready. */
export function warmNoirProver(wasm: NoirWasm): Promise<void> {
  return Promise.all([wasm(), proverBackend()]).then(() => undefined)
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
  {
    wasm,
    onLap,
    ios,
    verifierTarget,
  }: { wasm: NoirWasm; onLap?: OnLap; ios?: IosSettings; verifierTarget?: VerifierTarget },
): Promise<{ proof: Uint8Array; publicInputs: string[] }> {
  const started = performance.now()
  await wasm()
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
    throw new WalletError(
      "invariant",
      `${label} has no oracles — a foreign call means the wrong circuit`,
    )
  }).catch((err: unknown) => {
    throw circuitError(circuit, err)
  })
  step("witness", "witness solved")
  const backend = new UltraHonkBackend(circuit.bytecode, await proverBackend(ios))
  step("backend", "backend ready")
  const result = await backend.generateProof(compressWitness(solved), { verifierTarget })
  console.log(`[${label}] proof in ${lap("proof")}ms`)
  return result
}
