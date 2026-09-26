import type { Fr, GrumpkinScalar } from '@aztec/aztec.js/fields';
import { sha256 } from '@aztec/foundation/crypto/sha256';
import { sha512ToGrumpkinScalar } from '@aztec/foundation/crypto/sha512';

/** Custom domain separator: sha256 of the concept name, trimmed to a u32. Keys derived under it are independent of
 *  every master key the protocol derives from the same secret (whose separators are small enum values). */
function customDomainSeparator(concept: string): number {
  return sha256(Buffer.from(concept)).readUInt32BE(0);
}

const SCHNORR_SIGNING_KEY_DOMAIN_SEPARATOR = customDomainSeparator('schnorr_signing_key');

/** Schnorr signing key for account contracts, derived from the account's master secret under its own domain. */
export function deriveSchnorrSigningKey(masterSecret: Fr): GrumpkinScalar {
  return sha512ToGrumpkinScalar([masterSecret, SCHNORR_SIGNING_KEY_DOMAIN_SEPARATOR]);
}
