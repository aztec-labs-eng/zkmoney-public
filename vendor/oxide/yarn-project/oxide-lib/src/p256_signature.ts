/**
 * Canonical form for a P-256 ECDSA signature.
 *
 * ECDSA signatures are malleable: if `(r, s)` is valid then so is `(r, n - s)`, where `n` is the curve order. Noir's
 * `std::ecdsa_secp256r1::verify_signature` accepts only the low-s form, so an assertion whose authenticator emitted
 * the high-s form verifies in WebCrypto but cannot be proven. So the witness builder must normalise the signature
 * first.
 */
import { toBigIntBE } from '@aztec/foundation/bigint-buffer';

/** Order of the P-256 (secp256r1) curve group. */
export const P256_CURVE_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const HALF_P256_CURVE_ORDER = P256_CURVE_ORDER / 2n;

/**
 * Put a 64-byte `r || s` P-256 signature into the canonical low-s form, replacing `s` with `n - s` when `s > n / 2`.
 *
 * Returns `undefined` when the input is not 64 bytes, or when `r` or `s` is zero or at least `n`.
 */
export function normalizeP256Signature(signature: Buffer): Buffer | undefined {
  if (signature.length !== 64) {
    return undefined;
  }
  const r = toBigIntBE(signature.subarray(0, 32));
  const s = toBigIntBE(signature.subarray(32, 64));
  if (r === 0n || r >= P256_CURVE_ORDER || s === 0n || s >= P256_CURVE_ORDER) {
    return undefined;
  }
  if (s <= HALF_P256_CURVE_ORDER) {
    return Buffer.from(signature);
  }
  const normalized = Buffer.from(signature);
  normalized.write((P256_CURVE_ORDER - s).toString(16).padStart(64, '0'), 32, 'hex');
  return normalized;
}
