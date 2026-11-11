/**
 * Email-locked claim glue: a claimer-bound zkJWT proof, from the account's sealed proofs or via
 * Google OAuth (nonce = poseidon2(preimage, claimer address)) + the in-browser WASM prove.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import type { Address } from "viem"
import {
  assertJwtEmailMatchesCommitment,
  EmailMismatchError,
  PaylinkService,
  paylinkL1Caller,
  plainUserPayload,
} from "@obsidion/sdk"
import { generateZkJwtProof, type ZkJwtProof, type ZkJwtProofs } from "@obsidion/front-core"
import type { Session } from "../../session/session"
import { MskWebCryptoProvider } from "../../platform/storage/MskWebCryptoProvider"
import { signInWithGoogleIdToken } from "./googleRelay"
import { WebZkJwtProver } from "./zkJwtProver"

/** The proof shape the paylink claim submits. */
export interface CachedZkProof {
  vkey: string[]
  proof: string[]
  public_inputs: string[]
  email: string
  provider: "google" | "apple"
}

const claimProof = ({ proof, vkey, publicInputs, metadata }: ZkJwtProof): CachedZkProof => ({
  proof,
  vkey,
  public_inputs: publicInputs,
  email: metadata.email,
  provider: metadata.provider,
})

/** What a claim reads its proofs through: the account's key and its sealed proofs. */
export interface EmailClaimOwner extends Pick<Session, "page"> {
  auth: ConstructorParameters<typeof MskWebCryptoProvider>[0]
  zkJwtProofs: ZkJwtProofs
}

export type EmailClaimStage = "signing-in" | "proving-jwt"

/** What an email-locked claim proves against: the note's commitment and the lane's email. */
export type EmailLock = { paylinkType: string; commitment?: string; email?: string }

/**
 * The zkJWT `caller` an email link's L1 claim binds: the deployment's plain withdrawal executor and
 * the payload paying `payee` — the recipient, or the swap escrow on a swap route.
 */
export function emailL1Caller(executor: Address, payee: Address): Promise<Fr> {
  return paylinkL1Caller({
    executor: EthAddress.fromString(executor),
    userPayload: plainUserPayload(EthAddress.fromString(payee)),
  })
}

/**
 * Invoke directly from a click: the popup opens before the first await, so `caller` comes from
 * {@link emailL1Caller} ahead of it. No account/cache access.
 */
export async function obtainEmailL1Proof(
  { config, noirWasm }: Pick<Session["page"], "config" | "noirWasm">,
  caller: Fr,
  params: EmailLock,
  onStage: (stage: EmailClaimStage) => void,
  isActive: () => boolean,
  signal?: AbortSignal,
): Promise<CachedZkProof> {
  if (!params.commitment) throw new Error("This link's escrow has not been read yet — try again")
  const clientId = config.googleClientId
  if (!clientId) throw new Error("Google sign-in is not configured here")
  const preimage = Fr.random().toBigInt()
  const nonce = PaylinkService.computeNonce(preimage, caller.toBigInt())
  onStage("signing-in")
  const jwt = await signInWithGoogleIdToken(nonce, clientId, params.email, signal)
  if (!isActive()) throw new Error("Cancelled")
  assertJwtEmailMatchesCommitment(jwt, "google", BigInt(params.commitment), params.email)
  onStage("proving-jwt")
  const bundle = await generateZkJwtProof(
    new WebZkJwtProver(noirWasm),
    jwt,
    "google",
    preimage,
    caller.toString(),
    () => {
      if (!isActive()) throw new Error("Cancelled")
    },
  )
  if (!isActive()) throw new Error("Cancelled")
  if (BigInt(bundle.publicInputs[0]!) !== caller.toBigInt()) {
    throw new Error("Email proof does not match the withdrawal destination")
  }
  if (BigInt(bundle.publicInputs[2]!) !== BigInt(params.commitment)) {
    throw new EmailMismatchError({ lockedTo: params.email })
  }
  return claimProof(bundle)
}

/**
 * A zkJWT proof bound to `claimerAddress` for this link's email commitment. A saved proof skips
 * OAuth entirely; otherwise the Google id_token (nonce-bound to the claimer) feeds the WASM prover
 * and the proof is saved for the week the registry accepts it.
 */
export async function obtainEmailClaimProof(
  own: EmailClaimOwner,
  claimerAddress: { toString(): string; toBigInt(): bigint },
  params: EmailLock,
  onStage?: (stage: EmailClaimStage) => void,
  signal?: AbortSignal,
): Promise<CachedZkProof> {
  const commitment = params.commitment
  if (!commitment) throw new Error("This link's escrow has not been read yet — try again")
  const caller = claimerAddress.toString()
  const sealer = new MskWebCryptoProvider(own.auth, "zkjwt-store")

  const saved = await own.zkJwtProofs.find(sealer, caller, commitment)
  if (saved) return claimProof(saved)

  const clientId = own.page.config.googleClientId
  if (!clientId) {
    throw new Error("Google sign-in is not configured here — claim this link in the zk.money app")
  }
  onStage?.("signing-in")
  const preimage = Fr.random().toBigInt()
  const nonce = PaylinkService.computeNonce(preimage, claimerAddress.toBigInt())
  const jwt = await signInWithGoogleIdToken(nonce, clientId, params.email, signal)

  // Wrong-account guard: catches a commitment mismatch before the expensive prove.
  assertJwtEmailMatchesCommitment(jwt, "google", BigInt(commitment), params.email)

  // The claims the registry + circuit check: aud must be in the registry allowlist, iss/jwk
  // must match its seeded keys, email must hash to the link's commitment, iat must be fresh.
  onStage?.("proving-jwt")
  const prover = new WebZkJwtProver(own.page.noirWasm)
  const proof = await generateZkJwtProof(prover, jwt, "google", preimage, caller)
  await own.zkJwtProofs.save(sealer, proof)
  return claimProof(proof)
}
