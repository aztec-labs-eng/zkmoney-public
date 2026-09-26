/**
 * In-browser zkJWT prover — the `IZkJwtProver` behind email-locked paylink claims on web.
 *
 * Witness generation goes through the ACVM/noirc_abi WASM builds directly (the `web/` entrypoints;
 * the packages' default export is the Node build, which reaches for `fs`), and proving through
 * bb.js's UltraHonk on the `noir-recursive` target — the settings PaylinkEmail's
 * `verify_proof_with_type` expects. The vkey is NOT
 * derived here: it is pinned in `@obsidion/core/constants` (`getZkJwtVkey`, hash-checked against
 * the per-deposit `ZKJWT_VKEY_HASH` binding), and deriving it would cost a second proving-length
 * operation.
 */
import initACVM, { compressWitness, executeCircuit } from "@aztec/noir-acvm_js/web/acvm_js.js"
import initABI, { abiEncode } from "@aztec/noir-noirc_abi/web/noirc_abi_wasm.js"
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js"
import { Fr } from "@aztec/aztec.js/fields"
import { getZkJwtVkey, type JwtInput } from "@obsidion/sdk"
import { PROOF_FIELD_COUNT } from "@obsidion/core/constants"
import type { IZkJwtProver, ZkJwtProofResult } from "@obsidion/front-core"

interface ZkJwtCircuit {
  bytecode: string
  abi: unknown
}

// Lazy: the compiled circuit is a multi-MB JSON — fetched on the first proof, not at page load.
let _circuit: Promise<ZkJwtCircuit> | null = null

function getZkJwtCircuit(): Promise<ZkJwtCircuit> {
  _circuit ??= import("../../../../contracts/src/artifacts/target/zkJWT/zkJWT.json").then(
    (m) => (m.default ?? m) as unknown as ZkJwtCircuit,
  )
  return _circuit
}

let wasmReady: Promise<void> | null = null

function initWasm(): Promise<void> {
  wasmReady ??= Promise.all([initACVM(), initABI()]).then(() => undefined)
  return wasmReady
}

/** The circuit's `main(jwt, caller)` parameters as an ABI InputMap — the Prover.toml layout
 * (`renderZkJwtProverToml` in the sdk test utils) as JS values. */
function zkJwtInputMap(input: JwtInput, caller: string) {
  return {
    caller: Fr.fromHexString(caller).toString(),
    jwt: {
      base64_decode_offset: input.base64_decode_offset,
      signature_limbs: input.signature_limbs.map((x) => "0x" + BigInt(x).toString(16)),
      public_key_e: "0x" + BigInt(input.public_key_e).toString(16),
      public_key_limbs: input.public_key_limbs.map((x) => "0x" + BigInt(x).toString(16)),
      public_key_redc_limbs: input.public_key_redc_limbs.map((x) => "0x" + BigInt(x).toString(16)),
      nonce_preimage: "0x" + input.nonce_preimage.toString(16).padStart(64, "0"),
      header_and_payload: {
        len: input.header_and_payload.len,
        storage: input.header_and_payload.storage,
      },
    },
  }
}

async function proveZkJwtInBrowser(
  jwtInput: JwtInput,
  caller: string,
): Promise<ZkJwtProofResult> {
  const started = performance.now()
  const [circuit, vkeyFields] = await Promise.all([getZkJwtCircuit(), getZkJwtVkey(), initWasm()])

  const witnessMap = abiEncode(circuit.abi as never, zkJwtInputMap(jwtInput, caller) as never)
  const bytecode = Uint8Array.from(atob(circuit.bytecode), (c) => c.charCodeAt(0))
  const solved = await executeCircuit(bytecode, witnessMap, () => {
    throw new Error("zkJWT has no oracles — a foreign call means the wrong circuit")
  })
  const witnessMs = Math.round(performance.now() - started)

  const api = await Barretenberg.new({})
  try {
    const backend = new UltraHonkBackend(circuit.bytecode, api)
    const { proof, publicInputs } = await backend.generateProof(compressWitness(solved), {
      verifierTarget: "noir-recursive",
    })
    // The public-input count is validated by ZkJwtService, which owns the canonical constant.
    const fields: string[] = []
    for (let i = 0; i < proof.length; i += 32) {
      fields.push(Fr.fromBuffer(Buffer.from(proof.subarray(i, i + 32))).toString())
    }
    if (fields.length < PROOF_FIELD_COUNT) {
      throw new Error(`zkJWT proof too short: need ${PROOF_FIELD_COUNT} fields, got ${fields.length}`)
    }
    console.log(
      `[zkjwt-prover] proof in ${Math.round(performance.now() - started)}ms (witness ${witnessMs}ms)`,
    )
    return {
      proof: fields.slice(0, PROOF_FIELD_COUNT),
      vkey: vkeyFields.map((f) => f.toString()),
      publicInputs: publicInputs.map((hex) => Fr.fromHexString(hex).toString()),
    }
  } finally {
    await api.destroy().catch(() => {})
  }
}

export class WebZkJwtProver implements IZkJwtProver {
  prove(jwtInput: JwtInput, caller: string): Promise<ZkJwtProofResult> {
    return proveZkJwtInBrowser(jwtInput, caller)
  }
}
