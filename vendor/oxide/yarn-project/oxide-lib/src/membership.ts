// The public data membership check. The other membership checks are in `@oxide/oxide-lib-tee/membership.js`, which this
// module re-exports. The enclave does not use this code, so a change here does not change the enclave PCR0.
import type { Fr } from '@aztec-labs/aztec.js/fields';
import { DomainSeparator } from '@aztec-labs/constants';
import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon';
import type { PublicDataWitness } from '@aztec-labs/stdlib/trees';

import type { Constrained } from '@oxide/oxide-lib-tee/constrained.js';
import { makeHasher, verifyMembership } from '@oxide/oxide-lib-tee/membership.js';

export * from '@oxide/oxide-lib-tee/membership.js';

const publicDataMerkleHash = makeHasher(DomainSeparator.PUBLIC_DATA_MERKLE);

export async function verifyPublicDataMembership(
  witness: PublicDataWitness,
  expectedRoot: Constrained<Fr>,
): Promise<void> {
  const leafHash = await poseidon2Hash(witness.leafPreimage.toHashInputs());
  await verifyMembership(
    leafHash,
    witness.withoutPreimage(),
    expectedRoot,
    `public data leaf at slot ${witness.leafPreimage.leaf.slot}`,
    publicDataMerkleHash,
  );
}
