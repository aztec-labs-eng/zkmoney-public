// The migration signer handle that clients use. The signature and its verification are in
// `@oxide/oxide-lib-tee/migration_signature.js`, which this module re-exports.
import { Fr, type GrumpkinScalar } from '@aztec-labs/aztec.js/fields';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import type { PublicKeys } from '@aztec-labs/stdlib/keys';

import { computeAccountAddress, computePasskeySetImmutablesHash } from '@oxide/oxide-lib-tee/account_address.js';
import type { AccountInstancePreimage } from '@oxide/oxide-lib-tee/account_address.js';

import type { PasskeySigner } from './account_address.js';

export * from '@oxide/oxide-lib-tee/migration_signature.js';

// ---------------------------------------------------------------------------
// Account handle.
// ---------------------------------------------------------------------------

/** Signs migrations with a passkey of the account. */
export interface PasskeyMigrationSigner {
  kind: 'passkey';
  passkeySigner: PasskeySigner;
  /** The slots of the account's passkey set. */
  passkeySet: Fr[];
}

/**
 * Signs migrations with the account's master fallback secret key. The key store and the TEE never hold this key, so
 * it is the second factor of an account without a passkey.
 */
export interface FallbackKeyMigrationSigner {
  kind: 'fallbackKey';
  fbskM: GrumpkinScalar;
}

export type MigrationSigner = PasskeyMigrationSigner | FallbackKeyMigrationSigner;

/**
 * Everything a caller needs to prove that it owns an account whose funds a refund recovers: the address, the public
 * keys and instance preimage that hash to it, and the signer of the mode that address selects.
 */
export interface RefundOwner {
  address: AztecAddress;
  publicKeys: PublicKeys;
  instance: AccountInstancePreimage;
  signer: MigrationSigner;
}

export async function deriveRefundOwnerAddress(owner: RefundOwner): Promise<AztecAddress> {
  const immutablesHash =
    owner.signer.kind === 'passkey' ? await computePasskeySetImmutablesHash(owner.signer.passkeySet) : Fr.ZERO;
  return computeAccountAddress(owner.publicKeys, owner.instance, immutablesHash);
}
