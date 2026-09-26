import type { JwtInput } from "@obsidion/sdk"

export interface ZkJwtProofResult {
  proof: string[]
  vkey: string[]
  publicInputs: string[]
}

export interface IZkJwtProver {
  prove(jwtInput: JwtInput, caller: string): Promise<ZkJwtProofResult>
}
