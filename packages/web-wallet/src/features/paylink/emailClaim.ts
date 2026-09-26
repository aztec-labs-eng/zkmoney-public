/**
 * Email-locked claim glue: a claimer-bound zkJWT proof, from the encrypted cache or via Google
 * OAuth (nonce = poseidon2(preimage, claimer address)) + the in-browser WASM prove. The proof
 * cache persists the user's email + address, so it rides an MSK-derived `EncryptedStorageAdapter`
 * (`ZkJwtStorage` refuses a plain adapter).
 */
import { Fr } from "@aztec/aztec.js/fields"
import { EthAddress } from "@aztec/aztec.js/addresses"
import type { Address } from "viem"
import {
  assertJwtEmailMatchesCommitment,
  EmailMismatchError,
  PaylinkService,
  paylinkL1Caller,
  plainUserPayload,
} from "@obsidion/sdk"
import {
  EncryptedStorageAdapter,
  ZkJwtService,
  ZkJwtStorage,
  generateZkJwtProof,
  type CachedZkProof,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { MskWebCryptoProvider } from "../../platform/storage/MskWebCryptoProvider"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { signInWithGoogleIdToken } from "./googleAuth"
import { WebZkJwtProver } from "./zkJwtProver"

const ZKJWT_STORE_DOMAIN = "zkjwt-store"

let service: ZkJwtService | null = null

function zkJwtService(): ZkJwtService {
  service ??= new ZkJwtService({
    prover: new WebZkJwtProver(),
    storage: new ZkJwtStorage(
      new EncryptedStorageAdapter(
        webStorage,
        new MskWebCryptoProvider(getAuthService(), ZKJWT_STORE_DOMAIN),
      ),
    ),
  })
  return service
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
  caller: Fr,
  params: EmailLock,
  onStage: (stage: EmailClaimStage) => void,
  isActive: () => boolean,
  signal?: AbortSignal,
): Promise<CachedZkProof> {
  if (!params.commitment) throw new Error("This link's escrow has not been read yet — try again")
  const clientId = getConfig().googleClientId
  if (!clientId) throw new Error("Google sign-in is not configured here")
  const preimage = Fr.random().toBigInt()
  const nonce = PaylinkService.computeNonce(preimage, caller.toBigInt())
  onStage("signing-in")
  const jwt = await signInWithGoogleIdToken(nonce, clientId, params.email, signal)
  if (!isActive()) throw new Error("Cancelled")
  assertJwtEmailMatchesCommitment(jwt, "google", BigInt(params.commitment), params.email)
  onStage("proving-jwt")
  const bundle = await generateZkJwtProof(
    new WebZkJwtProver(),
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
  return {
    proof: bundle.proof,
    vkey: bundle.vkey,
    public_inputs: bundle.publicInputs,
    email: bundle.metadata.email,
    provider: "google",
  }
}

/**
 * A zkJWT proof bound to `claimerAddress` for this link's email commitment. Cache hit skips OAuth
 * entirely; otherwise the Google id_token (nonce-bound to the claimer) feeds the WASM prover and
 * the result is cached for the week the registry accepts it.
 */
export async function obtainEmailClaimProof(
  claimerAddress: { toString(): string; toBigInt(): bigint },
  params: EmailLock,
  onStage?: (stage: EmailClaimStage) => void,
  signal?: AbortSignal,
): Promise<CachedZkProof> {
  const commitment = params.commitment
  if (!commitment) throw new Error("This link's escrow has not been read yet — try again")
  const caller = claimerAddress.toString()
  const svc = zkJwtService()

  const cached = await svc.matchProofForPaylink(caller, params.paylinkType, commitment)
  if (cached) return cached

  const clientId = getConfig().googleClientId
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
  await new Promise<void>((resolve, reject) => {
    svc.proveInBackground(jwt, "google", preimage, caller, {
      onComplete: resolve,
      onError: reject,
    })
  })
  // The account already matched the commitment above, so a miss here is the cache, not the email:
  // the prove stored the proof under a key this lookup did not find.
  const proof = await svc.getCachedZkProof(caller, commitment)
  if (!proof) throw new Error("Your email was verified but the proof could not be found afterwards. Try again.")
  return proof
}
