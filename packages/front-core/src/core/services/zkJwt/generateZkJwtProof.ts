import { prepareJwtFromProvider, PublicKeyRegistry, type JwtProvider } from "@obsidion/sdk"
import { ZKJWT_PUBLIC_INPUT_COUNT } from "@obsidion/core/constants"
import type { IZkJwtProver } from "./IZkJwtProver"
import { ZKJWT_EMAIL_HASH_VERSION, type ProofBundle } from "./ZkJwtStorage"

/** Generate a proof without storage; callers decide whether it should be cached. */
export async function generateZkJwtProof(
  prover: IZkJwtProver,
  jwt: string,
  provider: JwtProvider,
  noncePreimage: bigint,
  callerAddress: string,
  onProving?: () => void,
): Promise<ProofBundle> {
  const { input, jwk_id, email } = await prepareJwtFromProvider(
    jwt,
    noncePreimage,
    new PublicKeyRegistry(),
    provider,
  )
  onProving?.()
  const result = await prover.prove(input, callerAddress)
  if (result.publicInputs.length !== ZKJWT_PUBLIC_INPUT_COUNT) {
    throw new Error(
      `zkJWT proof returned ${result.publicInputs.length} public inputs; expected ${ZKJWT_PUBLIC_INPUT_COUNT}`,
    )
  }
  return {
    ...result,
    metadata: {
      hashVersion: ZKJWT_EMAIL_HASH_VERSION,
      iat: Number(BigInt(result.publicInputs[4]!)),
      jwkId: jwk_id,
      issHash: result.publicInputs[6]!,
      audHash: result.publicInputs[3]!,
      commitment: result.publicInputs[2]!,
      callerAddress,
      cachedAt: Date.now(),
      provider,
      email,
    },
  }
}
