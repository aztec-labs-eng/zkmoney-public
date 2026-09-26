/**
 * Grumpkin-Schnorr-Poseidon2 signer for the fallback-key mode of the refund authorization. See the "Recovering stuck
 * funds" section of engineering-design-docs/oxide.md for the refund authorization model.
 *
 * This module mirrors the in-circuit challenge construction exactly so that signatures generated here verify in
 * `refund_lib::assert_refund_authorized`.
 */
import { Grumpkin } from '@aztec/foundation/crypto/grumpkin';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { Fr } from '@aztec/foundation/curves/bn254';
import { GrumpkinScalar, type Point } from '@aztec/foundation/curves/grumpkin';
import { derivePublicKeyFromSecretKey } from '@aztec/stdlib/keys';

import { SCHNORR_CHALLENGE_DST } from '@oxide/oxide-lib/grumpkin_schnorr_signature.js';
import { normalizeP256Signature } from '@oxide/oxide-lib/p256_signature.js';
import type { RefundAuthorization, RefundAuthorizer } from '@oxide/oxide-lib/refund_authorization.js';
import type { GrumpkinPoseidonSignature } from '@oxide/oxide-lib/types.js';

import { PermanentError } from './errors.js';

const TWO_POW_128 = 1n << 128n;

/**
 * Sign a refund authorization message with the owner's master fallback secret key (`fbsk_m`).
 *
 * @param masterFallbackSecretKey - The owner's `fbsk_m`. The owner's public keys commit to the matching `fbpk_m`.
 * @param authMessage - The refund auth message, built by one of the `compute*RefundAuthMessage` functions.
 */
export async function signRefundAuthMessageWithFallbackKey(
  masterFallbackSecretKey: GrumpkinScalar,
  authMessage: Fr,
): Promise<GrumpkinPoseidonSignature> {
  const publicKey = await derivePublicKeyFromSecretKey(masterFallbackSecretKey);
  return signGrumpkinSchnorrPoseidon(masterFallbackSecretKey, publicKey, authMessage);
}

/** The authorization `authorizer` produces over `authMessage`, in the mode the owner's address selects. */
export async function buildRefundAuthorization(
  authorizer: RefundAuthorizer,
  authMessage: Fr,
): Promise<RefundAuthorization> {
  if (authorizer.kind === 'passkey') {
    const webauthn = await authorizer.signer.sign(authMessage);

    // ECDSA signatures are malleable: `(r, s)` and `(r, n - s)` authorize the same thing. The circuit accepts only the
    // canonical low-s form, and an authenticator can emit either form.
    const signature = normalizeP256Signature(webauthn.signature);
    if (signature === undefined) {
      throw new PermanentError('passkey signature is not a P-256 signature, expected 64 bytes with r and s in [1, n)');
    }

    return {
      kind: 'passkey',
      passkey: authorizer.signer.publicKey,
      webauthn: { ...webauthn, signature },
    };
  }
  return {
    kind: 'fallbackKey',
    fbpkM: await derivePublicKeyFromSecretKey(authorizer.masterFallbackSecretKey),
    signature: await signRefundAuthMessageWithFallbackKey(authorizer.masterFallbackSecretKey, authMessage),
  };
}

/**
 * Grumpkin-Schnorr-Poseidon2 signing core. Produces a signature `(s, e)` over `authMessage` under `privateKey`,
 * matching the noir-lang/schnorr v0.4.0 verifier. Callers build their own `authMessage` with a domain-separated
 * Poseidon2 hash, so signatures from different flows are not cross-compatible.
 *
 * Challenge construction (mirrors noir-lang/schnorr v0.4.0):
 *   R = k * G                                  (k random, nonzero)
 *   e = poseidon2_hash([SCHNORR_CHALLENGE_DST, R.x, PK.x, PK.y, auth_message])
 *   s = k - e * sk   (mod grumpkin scalar order)
 */
async function signGrumpkinSchnorrPoseidon(
  privateKey: GrumpkinScalar,
  publicKey: Point,
  authMessage: Fr,
): Promise<GrumpkinPoseidonSignature> {
  // k = random nonzero nonce
  let k = GrumpkinScalar.random();
  while (k.isZero()) {
    k = GrumpkinScalar.random();
  }

  // R = k * G
  const R = await Grumpkin.mul(Grumpkin.generator, k);

  // e = poseidon2_hash([SCHNORR_CHALLENGE_DST, R.x, PK.x, PK.y, authMessage])
  const e = await poseidon2Hash([SCHNORR_CHALLENGE_DST, R.x, publicKey.x, publicKey.y, authMessage]);

  // s = k - e * sk (mod grumpkin scalar order)
  const order = GrumpkinScalar.MODULUS;
  const eBig = e.toBigInt();
  const kBig = k.toBigInt();
  const skBig = privateKey.toBigInt();
  const sBig = (((kBig - ((eBig * skBig) % order)) % order) + order) % order;

  const s = new GrumpkinScalar(sBig);

  return {
    sLo: s.lo,
    sHi: s.hi,
    eLo: new Fr(eBig & (TWO_POW_128 - 1n)),
    eHi: new Fr(eBig >> 128n),
  };
}
