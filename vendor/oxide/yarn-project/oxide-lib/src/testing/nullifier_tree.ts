import { Fr } from '@aztec/aztec.js/fields';
import { DomainSeparator, NULLIFIER_TREE_HEIGHT } from '@aztec/constants';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { type NullifierLeafPreimage, NullifierMembershipWitness } from '@aztec/stdlib/trees';

import { SparseTree } from './sparse_tree.js';

/**
 * Builds a nullifier tree with `leaves` from index 0. Returns the root and a function that gives the membership
 * witness for the leaf at an index. An empty preimage hashes to zero, as in the protocol, so it does not change
 * the root. To get a witness for an unused index, put `NullifierLeafPreimage.empty()` at that index in `leaves`.
 */
export async function nullifierTreeFixture(leaves: NullifierLeafPreimage[]) {
  const tree = await SparseTree.build(
    NULLIFIER_TREE_HEIGHT,
    await Promise.all(leaves.map(async leaf => (leaf.isEmpty() ? Fr.ZERO : await poseidon2Hash(leaf.toHashInputs())))),
    DomainSeparator.NULLIFIER_MERKLE,
  );
  return {
    root: tree.root,
    witness: (index: number) =>
      new NullifierMembershipWitness(
        BigInt(index),
        leaves[index]!,
        tree.siblingPathObject<typeof NULLIFIER_TREE_HEIGHT>(index),
      ),
  };
}
