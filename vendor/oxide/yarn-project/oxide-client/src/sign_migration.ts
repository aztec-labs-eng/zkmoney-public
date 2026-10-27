/**
 * Signs a migration in either signing mode. See
 * [Migration signature](../../../engineering-design-docs/oxide.md#migration-signature) for what each mode signs.
 *
 * The fallback-key signature mirrors the in-circuit challenge construction exactly, so that it verifies in
 * `refund_lib::assert_valid_migration_signature`.
 *
 * This module does not use the generated contract bindings, so external clients can import it.
 */
import { Grumpkin } from '@aztec-labs/foundation/crypto/grumpkin';
import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { GrumpkinScalar, type Point } from '@aztec-labs/foundation/curves/grumpkin';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { derivePublicKeyFromSecretKey } from '@aztec-labs/stdlib/keys';

import { computePasskeyHash } from '@oxide/oxide-lib/account_address.js';
import { getUserPayloadHash } from '@oxide/oxide-lib/content_hash.js';
import { SCHNORR_CHALLENGE_DST } from '@oxide/oxide-lib/grumpkin_schnorr_signature.js';
import {
  type MigrationSignature,
  type MigrationSigner,
  type RefundOwner,
  computeRefundCommitment,
  deriveRefundOwnerAddress,
} from '@oxide/oxide-lib/migration_signature.js';
import { normalizeP256Signature } from '@oxide/oxide-lib/p256_signature.js';
import type { GrumpkinPoseidonSignature } from '@oxide/oxide-lib/types.js';

import { PermanentError } from './errors.js';

const TWO_POW_128 = 1n << 128n;

/** Throw unless `owner`'s preimage hashes to its address and, in passkey mode, its signer is in its passkey set. */
export async function assertRefundOwner(owner: RefundOwner): Promise<void> {
  const derived = await deriveRefundOwnerAddress(owner);
  if (!derived.equals(owner.address)) {
    throw new PermanentError(
      `Refund owner preimage hashes to ${derived}, expected ${owner.address}: the public keys, instance or signing mode do not belong to this account`,
    );
  }
  if (owner.signer.kind === 'passkey') {
    const passkeyHash = await computePasskeyHash(owner.signer.passkeySigner.publicKey);
    if (!owner.signer.passkeySet.some(slot => slot.equals(passkeyHash))) {
      throw new PermanentError("the signing passkey is not in the account's passkey set");
    }
  }
}

/**
 * Signs every refund to `executor` with `userPayloadHash`. In passkey mode, the passkey signs once.
 *
 * A wallet can save the signature (see `MigrationSignatureSchema` of `@oxide/oxide-lib/types.js`) and pass it to each
 * refund.
 */
export async function signMigration(args: {
  signer: MigrationSigner;
  executor: EthAddress;
  userPayloadHash: Fr;
}): Promise<MigrationSignature> {
  const { signer, executor, userPayloadHash } = args;
  const refundCommitment = await computeRefundCommitment(executor, userPayloadHash);

  if (signer.kind === 'fallbackKey') {
    const fbpkM = await derivePublicKeyFromSecretKey(signer.fbskM);
    return {
      kind: 'fallbackKey',
      fbpkM,
      fallbackSignature: await signGrumpkinSchnorrPoseidon(signer.fbskM, fbpkM, refundCommitment),
    };
  }

  const webauthn = await signer.passkeySigner.sign(refundCommitment);

  // ECDSA signatures are malleable: `(r, s)` and `(r, n - s)` authorize the same thing. The circuit accepts only the
  // canonical low-s form, and an authenticator can emit either form.
  const signature = normalizeP256Signature(webauthn.signature);
  if (signature === undefined) {
    throw new PermanentError('passkey signature is not a P-256 signature, expected 64 bytes with r and s in [1, n)');
  }

  return {
    kind: 'passkey',
    passkey: signer.passkeySigner.publicKey,
    passkeySet: signer.passkeySet,
    webauthn: { ...webauthn, signature },
  };
}

/** Signs, as `owner`, every refund to the executor of `executorCall` with its payload. */
export function signMigrationOf(
  owner: RefundOwner,
  executorCall: { executor: EthAddress; userPayload: Buffer },
): Promise<MigrationSignature> {
  return signMigration({
    signer: owner.signer,
    executor: executorCall.executor,
    userPayloadHash: getUserPayloadHash(executorCall.userPayload),
  });
}

/**
 * Grumpkin-Schnorr-Poseidon2 signing core. Produces a signature `(s, e)` over `message` under `privateKey`, matching
 * the noir-lang/schnorr v0.4.0 verifier.
 *
 * Challenge construction (mirrors noir-lang/schnorr v0.4.0):
 *   R = k * G                                  (k random, nonzero)
 *   e = poseidon2_hash([SCHNORR_CHALLENGE_DST, R.x, PK.x, PK.y, message])
 *   s = k - e * sk   (mod grumpkin scalar order)
 */
async function signGrumpkinSchnorrPoseidon(
  privateKey: GrumpkinScalar,
  publicKey: Point,
  message: Fr,
): Promise<GrumpkinPoseidonSignature> {
  // k = random nonzero nonce
  let k = GrumpkinScalar.random();
  while (k.isZero()) {
    k = GrumpkinScalar.random();
  }

  // R = k * G
  const R = await Grumpkin.mul(Grumpkin.generator, k);

  // e = poseidon2_hash([SCHNORR_CHALLENGE_DST, R.x, PK.x, PK.y, message])
  const e = await poseidon2Hash([SCHNORR_CHALLENGE_DST, R.x, publicKey.x, publicKey.y, message]);

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
