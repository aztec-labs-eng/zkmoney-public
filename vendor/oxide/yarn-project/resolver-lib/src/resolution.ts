// TS mirror of noir-projects/resolver_circuit, pinned by the shared test vector in
// resolution.test.ts. The shared constants come from the generated source.
import { toBufferBE } from '@aztec/foundation/bigint-buffer';
import { sha256ToField } from '@aztec/foundation/crypto/sha256';
import { Fr } from '@aztec/foundation/curves/bn254';

import { DOM_SEP__STEALTH_K, MAX_NONCE } from '@oxide/oxide-lib/oxide_constants.gen.js';

import { secp256k1 } from './libsecp256k1.js';
import { Secp256k1Point } from './secp256k1_point.js';

/**
 * Computes the scalar `k = H(DOM_SEP__STEALTH_K, day, nonce)` used to tweak the private key
 * (via `privateKeyTweakMul`) before the ECDH step in {@link computeSharedSecretSalt}. "Tweak" is
 * libsecp256k1's term for a public, deterministic scalar that modifies an existing key — this
 * value is not itself a key or a secret.
 *
 * A BN254 digest fits the secp256k1 scalar field, so the reinterpretation never reduces.
 */
function computeSharedSecretTweak(day: number, nonce: number): Buffer {
  assertU32(day, 'day');
  assertU32(nonce, 'nonce');
  if (nonce >= MAX_NONCE) {
    throw new Error(`nonce out of range: ${nonce} >= ${MAX_NONCE}`);
  }
  const digest = sha256ToField([
    new Fr(DOM_SEP__STEALTH_K).toBuffer(),
    toBufferBE(BigInt(day), 32),
    toBufferBE(BigInt(nonce), 32),
  ]);
  return digest.toBuffer();
}

export function computeSharedSecretSalt(
  userPublicKey: Secp256k1Point,
  resolverPrivateKey: Uint8Array,
  day: number,
  nonce: number,
): Fr {
  const k = computeSharedSecretTweak(day, nonce);
  userPublicKey.assertOnCurve();
  if (resolverPrivateKey.length !== 32 || !secp256k1.privateKeyVerify(resolverPrivateKey)) {
    throw new Error('private key not in field');
  }
  // privateKeyTweakMul works in place, so we pass a copy.
  const combinedScalar = secp256k1.privateKeyTweakMul(Buffer.from(resolverPrivateKey), k);
  const sharedPoint = secp256k1.publicKeyTweakMul(userPublicKey.toSec1(), combinedScalar, false);
  return sha256ToField([Buffer.from(sharedPoint.subarray(1, 65))]);
}

export { deriveRecoveryCommitment } from '@oxide/oxide-lib/sipa_recovery.js';

function assertU32(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${name} is not a u32: ${value}`);
  }
}
