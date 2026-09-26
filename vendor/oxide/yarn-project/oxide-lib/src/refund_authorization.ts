/**
 * The owner's authorization of a refund, in either of the two modes the refund circuits accept.
 *
 * This module mirrors `noir-projects/refund_lib/src/authorization.nr` exactly.
 */
import { Fr, type GrumpkinScalar } from '@aztec/aztec.js/fields';
import { Point as GrumpkinPoint, type Point } from '@aztec/foundation/curves/grumpkin';
import { schemas, zodFor } from '@aztec/foundation/schemas';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import { type PublicKeys, hashPublicKey } from '@aztec/stdlib/keys';

import { z } from 'zod';

import {
  type AccountInstancePreimage,
  type PasskeyPublicKey,
  PasskeyPublicKeySchema,
  type PasskeySigner,
  type WebAuthnAuth,
  WebAuthnAuthSchema,
  computeAccountAddress,
  computePasskeyImmutablesHash,
  verifyWebAuthnAuth,
} from './account_address.js';
import { verifyGrumpkinPoseidonSignature } from './grumpkin_schnorr_signature.js';
import type { GrumpkinPoseidonSignature } from './types.js';

// ---------------------------------------------------------------------------
// The authorization itself.
// ---------------------------------------------------------------------------

/**
 * Passkey mode: the account address commits to `passkey` through its `immutables_hash`, and the owner authorizes the
 * refund with a WebAuthn assertion.
 */
export interface PasskeyRefundAuthorization {
  kind: 'passkey';
  passkey: PasskeyPublicKey;
  webauthn: WebAuthnAuth;
}

/**
 * Fallback-key mode: the account address commits to no passkey (`immutables_hash` is zero), and the owner authorizes
 * the refund with a Grumpkin-Schnorr signature under the master fallback key the address commits to through its public
 * keys. A fallback-key owner, such as an escrow contract whose keys derive from a shared secret, uses this mode.
 */
export interface FallbackKeyRefundAuthorization {
  kind: 'fallbackKey';
  fbpkM: Point;
  signature: GrumpkinPoseidonSignature;
}

export type RefundAuthorization = PasskeyRefundAuthorization | FallbackKeyRefundAuthorization;

/** Hex-buffer schema of a {@link RefundAuthorization}. `types.ts` carries the base64 transport variant. */
export const RefundAuthorizationSchema = zodFor<RefundAuthorization>()(
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('passkey'),
      passkey: PasskeyPublicKeySchema,
      webauthn: WebAuthnAuthSchema,
    }),
    z.object({
      kind: z.literal('fallbackKey'),
      fbpkM: GrumpkinPoint.schema,
      signature: z.object({
        sLo: schemas.Fr,
        sHi: schemas.Fr,
        eLo: schemas.Fr,
        eHi: schemas.Fr,
      }),
    }),
  ]),
);

/** The `immutables_hash` the owner's address preimage carries in `auth`'s mode. */
export function computeRefundImmutablesHash(auth: RefundAuthorization): Promise<Fr> {
  return auth.kind === 'passkey' ? computePasskeyImmutablesHash(auth.passkey) : Promise.resolve(Fr.ZERO);
}

/**
 * The address the refund circuits derive for an owner that authorizes with `auth`.
 *
 * Mirrors the address check of `refund_lib::assert_refund_authorized`.
 */
export async function computeRefundOwnerAddress(
  publicKeys: PublicKeys,
  instance: AccountInstancePreimage,
  auth: RefundAuthorization,
): Promise<AztecAddress> {
  return computeAccountAddress(publicKeys, instance, await computeRefundImmutablesHash(auth));
}

/**
 * Check that `auth` authorizes `authMessage` for `owner`, with the same rules as
 * `refund_lib::assert_refund_authorized`: `publicKeys` and `instance` must hash to `owner` under the mode's immutables
 * hash, and the mode's authorization must verify. Never throws on malformed input; returns false instead.
 */
export async function verifyRefundAuthorization(
  publicKeys: PublicKeys,
  instance: AccountInstancePreimage,
  owner: AztecAddress,
  authMessage: Fr,
  auth: RefundAuthorization,
): Promise<boolean> {
  let derived: AztecAddress;
  try {
    derived = await computeRefundOwnerAddress(publicKeys, instance, auth);
  } catch {
    return false;
  }
  if (!derived.equals(owner)) {
    return false;
  }

  if (auth.kind === 'passkey') {
    return await verifyWebAuthnAuth(auth.passkey, authMessage, auth.webauthn);
  }

  try {
    const fbpkMHash = await hashPublicKey(auth.fbpkM);
    if (!fbpkMHash.equals(publicKeys.fbpkMHash)) {
      return false;
    }
    return await verifyGrumpkinPoseidonSignature(auth.fbpkM, auth.signature, authMessage);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Account handle.
// ---------------------------------------------------------------------------

/** Authorizes refunds with the account's passkey. */
export interface PasskeyRefundAuthorizer {
  kind: 'passkey';
  signer: PasskeySigner;
}

/**
 * Authorizes refunds with the account's master fallback secret key. The one address-preimage key the key store and
 * the TEE never hold, so it is the second factor an account without a passkey still has.
 */
export interface FallbackKeyRefundAuthorizer {
  kind: 'fallbackKey';
  masterFallbackSecretKey: GrumpkinScalar;
}

export type RefundAuthorizer = PasskeyRefundAuthorizer | FallbackKeyRefundAuthorizer;

/**
 * Everything a caller needs to prove that it owns an account whose funds a refund recovers: the address, the public
 * keys and instance preimage that hash to it, and the authorizer of the mode that address selects.
 */
export interface RefundOwner {
  address: AztecAddress;
  publicKeys: PublicKeys;
  instance: AccountInstancePreimage;
  authorizer: RefundAuthorizer;
}

/**
 * The address `owner`'s preimage hashes to, with the immutables hash of the mode its authorizer uses. Equal to
 * `owner.address` for a well-formed handle, and to something else when the caller paired the preimage with the wrong
 * mode or the wrong keys. Needs no signature, unlike {@link computeRefundOwnerAddress}.
 */
export async function deriveRefundOwnerAddress(owner: RefundOwner): Promise<AztecAddress> {
  const immutablesHash =
    owner.authorizer.kind === 'passkey'
      ? await computePasskeyImmutablesHash(owner.authorizer.signer.publicKey)
      : Fr.ZERO;
  return computeAccountAddress(owner.publicKeys, owner.instance, immutablesHash);
}
