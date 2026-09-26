import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import type { BlockHash } from '@aztec/stdlib/block';
import type { PublicDataWitness } from '@aztec/stdlib/trees';

import { computeSignerApprovalLeafSlot } from '@oxide/oxide-lib/hash.js';
import type { SecpPublicKey } from '@oxide/oxide-lib/types.js';

import type { ChainDataSource } from './chain_data_source.js';

/**
 * Fetches the public-data inclusion proof showing that the TEE signer with secp256k1 pubkey
 * `publicKey` is registered (value == 1) in the token's `approved_signers` map at
 * `referenceBlock`. The map key is `poseidon2_hash([x_hi, x_lo, y_hi, y_lo])` — the same four
 * (hi, lo) field halves the L2 contract writes from `consume_signer_registration`.
 */
export async function fetchSignerApprovalWitness(
  chain: Pick<ChainDataSource, 'getPublicDataWitness'>,
  tokenAddress: AztecAddress,
  publicKey: SecpPublicKey,
  referenceBlock: BlockHash,
): Promise<PublicDataWitness> {
  const leafSlot = await computeSignerApprovalLeafSlot(tokenAddress, publicKey);
  const witness = await chain.getPublicDataWitness(referenceBlock, leafSlot);
  if (!witness) {
    throw new Error(
      `No public data witness for signer approval slot ${leafSlot} (signer pubkey x=${publicKey.x}, y=${publicKey.y})` +
        ` at block ${referenceBlock}`,
    );
  }
  return witness;
}
