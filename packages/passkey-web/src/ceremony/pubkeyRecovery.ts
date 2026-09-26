import { p256 } from "@noble/curves/p256"
import { bytesToHex, hexToBytes } from "./bytes.js"
import type { PasskeyAssertResult } from "./passkeyCeremony.js"

/**
 * Recover a credential's P-256 public key from its assertions, for the
 * fresh-browser case where no local identity-map record holds the pubkey
 * (assertion responses never carry it).
 *
 * ECDSA public-key recovery yields two candidates per signature; both verify
 * that same signature, so one assertion cannot disambiguate. Two assertions
 * over different payloads share exactly one candidate — the credential's key.
 */

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource))
}

/** The digest a WebAuthn signature is over: SHA-256(authenticatorData ‖ SHA-256(clientDataJSON)). */
export async function signedDigest(
  assertion: Pick<PasskeyAssertResult, "authenticatorData" | "clientDataJSON">,
): Promise<Uint8Array> {
  const cdjHash = await sha256(assertion.clientDataJSON)
  const payload = new Uint8Array(assertion.authenticatorData.length + cdjHash.length)
  payload.set(assertion.authenticatorData, 0)
  payload.set(cdjHash, assertion.authenticatorData.length)
  return sha256(payload)
}

/** The (up to two) candidate pubkeys a single assertion's signature recovers to, as 64-byte x||y hex. */
export async function candidatePubkeys(assertion: PasskeyAssertResult): Promise<string[]> {
  const digest = await signedDigest(assertion)
  const signature = p256.Signature.fromDER(assertion.signatureDer)
  const candidates: string[] = []
  for (const recoveryBit of [0, 1]) {
    try {
      const point = signature.addRecoveryBit(recoveryBit).recoverPublicKey(digest)
      candidates.push(bytesToHex(point.toRawBytes(false).slice(1)))
    } catch {
      // A recovery bit can be invalid for a given r — skip it.
    }
  }
  return candidates
}

/** Returns the 64-byte x||y shared by both assertions' candidate sets. */
export async function recoverPubkeyFromAssertions(
  first: PasskeyAssertResult,
  second: PasskeyAssertResult,
): Promise<Uint8Array> {
  const a = await candidatePubkeys(first)
  const b = new Set(await candidatePubkeys(second))
  const shared = a.filter((hex) => b.has(hex))
  if (shared.length !== 1) {
    throw new Error(
      `Public-key recovery is ambiguous (${shared.length} shared candidates); ` +
        "assertions must come from the same credential over different payloads",
    )
  }
  return hexToBytes(shared[0]!)
}
