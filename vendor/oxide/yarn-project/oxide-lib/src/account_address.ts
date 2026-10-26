// The passkey account helpers that clients use. The other account address helpers are in
// `@oxide/oxide-lib-tee/account_address.js`, which this module re-exports. The enclave does not use this code, so a change
// here does not change the enclave PCR0.
import { Fr } from '@aztec-labs/aztec.js/fields';
import { schemas, zodFor } from '@aztec-labs/foundation/schemas';

import {
  type PasskeyPublicKey,
  WEBAUTHN_AUTHENTICATOR_DATA_LEN,
  WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN,
  type WebAuthnAuth,
  computePasskeyHash,
} from '@oxide/oxide-lib-tee/account_address.js';
import { MAX_ACCOUNT_PASSKEYS } from '@oxide/oxide-lib-tee/oxide_constants.gen.js';

import { z } from 'zod';

export * from '@oxide/oxide-lib-tee/account_address.js';

function fixedBufferHexSchema(length: number, name: string) {
  return schemas.BufferHex.refine(b => b.length === length, `${name} must be ${length} bytes`);
}

export const PasskeyPublicKeySchema = zodFor<PasskeyPublicKey>()(
  z.object({
    x: fixedBufferHexSchema(32, 'x'),
    y: fixedBufferHexSchema(32, 'y'),
  }),
);

export const WebAuthnAuthSchema = zodFor<WebAuthnAuth>()(
  z.object({
    authenticatorData: fixedBufferHexSchema(WEBAUTHN_AUTHENTICATOR_DATA_LEN, 'authenticatorData'),
    clientDataJSON: schemas.BufferHex.refine(
      b => b.length <= WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN,
      `clientDataJSON must be at most ${WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN} bytes`,
    ),
    signature: fixedBufferHexSchema(64, 'signature'),
  }),
);

/**
 * Signs authorization messages with an account's passkey.
 */
export interface PasskeySigner {
  readonly publicKey: PasskeyPublicKey;
  /** Produce a WebAuthn assertion whose challenge is the 32-byte big-endian encoding of `message`. */
  sign(message: Fr): Promise<WebAuthnAuth>;
}

/**
 * The slots of a passkey set: the passkey hashes in ascending order, then zero up to `MAX_ACCOUNT_PASSKEYS`.
 */
export function passkeySetSlots(passkeyHashes: Fr[]): Fr[] {
  if (passkeyHashes.length === 0 || passkeyHashes.length > MAX_ACCOUNT_PASSKEYS) {
    throw new Error(`A passkey set holds 1 to ${MAX_ACCOUNT_PASSKEYS} passkeys, not ${passkeyHashes.length}`);
  }
  const sorted = [...passkeyHashes].sort((a, b) =>
    a.toBigInt() < b.toBigInt() ? -1 : a.toBigInt() === b.toBigInt() ? 0 : 1,
  );
  if (sorted.some((hash, i) => hash.isZero() || (i > 0 && hash.equals(sorted[i - 1])))) {
    throw new Error('A passkey set holds distinct nonzero passkey hashes');
  }
  return [...sorted, ...Array.from({ length: MAX_ACCOUNT_PASSKEYS - sorted.length }, () => Fr.ZERO)];
}

/** The slots of the passkey set of `passkeys`. */
export async function computePasskeySetSlots(passkeys: PasskeyPublicKey[]): Promise<Fr[]> {
  const passkeyHashes = await Promise.all(passkeys.map(computePasskeyHash));
  return passkeySetSlots(passkeyHashes);
}
