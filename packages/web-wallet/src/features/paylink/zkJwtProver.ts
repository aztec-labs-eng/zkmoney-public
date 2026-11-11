/**
 * In-browser zkJWT prover — the `IZkJwtProver` behind email-locked paylink claims on web.
 *
 * It proves with bb.js's UltraHonk on the `noir-recursive` target — the settings PaylinkEmail's
 * `verify_proof_with_type` expects. The vkey is NOT
 * derived here: it is pinned in `@obsidion/core/constants` (`getZkJwtVkey`, hash-checked against
 * the per-deposit `ZKJWT_VKEY_HASH` binding), and deriving it would cost a second proving-length
 * operation.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { getZkJwtVkey, zkJwtInputMap, type JwtInput } from "@obsidion/sdk"
import { PROOF_FIELD_COUNT } from "@obsidion/core/constants"
import { WalletError } from "@obsidion/core/errors"
import type { IZkJwtProver, ZkJwtProofResult } from "@obsidion/front-core"
import { proveNoirCircuit, type NoirCircuit, type NoirWasm } from "../../platform/noirProver"

// Lazy: the compiled circuit is a multi-MB JSON — fetched on the first proof, not at page load.
const getZkJwtCircuit = (): Promise<NoirCircuit> =>
  import("../../../../contracts/src/artifacts/target/zkJWT/zkJWT.json").then(
    (m) => (m.default ?? m) as unknown as NoirCircuit,
  )

async function proveZkJwtInBrowser(jwtInput: JwtInput, caller: string, wasm: NoirWasm) {
  const [circuit, vkeyFields] = await Promise.all([getZkJwtCircuit(), getZkJwtVkey(), wasm()])
  const { proof, publicInputs } = await proveNoirCircuit(
    circuit,
    zkJwtInputMap(jwtInput, caller),
    "zkJWT",
    { wasm, verifierTarget: "noir-recursive" },
  )
  // The public-input count is validated by generateZkJwtProof, which owns the canonical constant.
  const fields: string[] = []
  for (let i = 0; i < proof.length; i += 32) {
    fields.push(Fr.fromBuffer(Buffer.from(proof.subarray(i, i + 32))).toString())
  }
  if (fields.length < PROOF_FIELD_COUNT) {
    throw new WalletError(
      "invariant",
      `zkJWT proof too short: need ${PROOF_FIELD_COUNT} fields, got ${fields.length}`,
    )
  }
  return {
    proof: fields.slice(0, PROOF_FIELD_COUNT),
    vkey: vkeyFields.map((f) => f.toString()),
    publicInputs: publicInputs.map((hex) => Fr.fromHexString(hex).toString()),
  }
}

export class WebZkJwtProver implements IZkJwtProver {
  constructor(private readonly wasm: NoirWasm) {}

  prove(jwtInput: JwtInput, caller: string): Promise<ZkJwtProofResult> {
    return proveZkJwtInBrowser(jwtInput, caller, this.wasm)
  }
}
