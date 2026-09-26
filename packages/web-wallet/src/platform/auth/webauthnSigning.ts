import { p256 } from "@noble/curves/p256"
import { provingProgress } from "@obsidion/proving-progress"
import type { WebAuthnSignResult } from "@obsidion/sdk"
import { signedDigest, type PasskeyAssertResult, type PasskeyCeremony } from "@obsidion/passkey-web"
import { activeSigningFlow, passkeyTelemetry } from "../../lib/passkeyTelemetry"

/**
 * The passkey signed, but not with the key this browser holds for it. The recorded key is wrong —
 * a sign-in adopted the other candidate of its signature — and nothing signed with it can verify.
 */
export class SignerKeyMismatchError extends Error {
  constructor() {
    super(
      "This passkey's signature doesn't match the key this browser recorded for it. Clear this site's data and sign in again.",
    )
    this.name = "SignerKeyMismatchError"
  }
}

/** Whether `result` is `pubkey`'s (64-byte x||y) signature over its own WebAuthn message. */
export async function signatureMatchesKey(
  result: WebAuthnSignResult,
  pubkey: Uint8Array,
): Promise<boolean> {
  const point = new Uint8Array(65)
  point[0] = 0x04
  point.set(pubkey, 1)
  return p256.verify(result.signature, await signedDigest(result), point, { format: "compact" })
}

/** Where the browser's sheet should open for a credential, and what each answer teaches. */
export interface SigningSteering {
  /** Transports to send with the credential; `inferred` when this browser worked them out itself. */
  transports(): Promise<{ transports: readonly string[]; inferred: boolean } | undefined>
  /** The assertion that answered. */
  learned(assertion: PasskeyAssertResult): void
  /**
   * A request steered by an inference ended without an answer. Nothing here can cancel a
   * signature on purpose, so every failure counts: the steer is only a hint, dropping it costs
   * one picker, and a browser that rejects the hint outright must not be asked the same way again.
   */
  refused(): void
}

/**
 * signFn for `WebAuthnAlphaAuthProvider`: assert with the 32-byte messageHash as the WebAuthn
 * challenge and convert the DER signature to the 64-byte low-S r||s the account contract
 * verifies. The assertion reads no PRF: a signature never unlocks a session, and the contract
 * verifies the signature against the enrolled key whatever device produced it. The steering only
 * opens the browser's sheet on the device the credential is known to live on (a hardware key);
 * the signature is checked against `pubkey` here, so a wrong recorded key fails before anything
 * is proven or sent.
 *
 * The ceremony is bracketed by `signing-start` / `signing-end`: it is a user-paced system modal,
 * and it is the last beat a send or withdrawal needs the user for. On `signing-end` the flow's
 * modal hands the proof to the bell (`OperationHandOff`). A cancelled or failed assertion ends the
 * bracket with `failed`, so those modals stay for the error. Each signature is one `approve_tx`
 * passkey attempt, named for the proving flow that holds the screen when the signature is asked for.
 */
export function makeWebauthnSignFn(
  ceremony: PasskeyCeremony,
  rpId: string,
  credentialId: string,
  pubkey: Uint8Array,
  steering?: SigningSteering,
): (challenge: Buffer) => Promise<WebAuthnSignResult> {
  return async (challenge: Buffer) => {
    // Before any await: another flow can take the screen while the steering loads.
    const flow = activeSigningFlow()
    provingProgress.emitSigningStart()
    let result: WebAuthnSignResult
    try {
      const steer = await steering?.transports()
      result = await passkeyTelemetry.track({ ceremony: "approve_tx", flow }, async (own) => {
        let assertion: PasskeyAssertResult
        try {
          assertion = await own(ceremony).assert({
            rpId,
            challenge: new Uint8Array(challenge),
            credentialIds: [credentialId],
            ...(steer ? { transports: steer.transports } : {}),
          })
        } catch (e) {
          if (steer?.inferred) steering?.refused()
          throw e
        }
        steering?.learned(assertion)
        const signed: WebAuthnSignResult = {
          signature: p256.Signature.fromDER(assertion.signatureDer)
            .normalizeS()
            .toCompactRawBytes(),
          authenticatorData: assertion.authenticatorData,
          clientDataJSON: assertion.clientDataJSON,
        }
        if (!(await signatureMatchesKey(signed, pubkey))) throw new SignerKeyMismatchError()
        return signed
      })
    } catch (e) {
      provingProgress.emitSigningEnd(undefined, true)
      throw e
    }
    provingProgress.emitSigningEnd()
    return result
  }
}
