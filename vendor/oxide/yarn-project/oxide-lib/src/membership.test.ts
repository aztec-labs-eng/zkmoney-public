import { Fr } from '@aztec/aztec.js/fields';
import { AppendOnlyTreeSnapshot, NullifierLeaf, NullifierLeafPreimage } from '@aztec/stdlib/trees';
import { PartialStateReference, StateReference } from '@aztec/stdlib/tx';

import { describe, expect, it } from '@jest/globals';

import { testConstrained } from './constrained.js';
import { assertIsFrozenTip, verifyNullifierNonMembership } from './membership.js';
import { frozenTipFixture } from './testing/frozen_tip.js';
import { nullifierTreeFixture } from './testing/nullifier_tree.js';

const NULLIFIER = new Fr(1000);

function leaf(nullifier: Fr, nextNullifier: Fr = Fr.ZERO, nextIndex = 0n): NullifierLeafPreimage {
  return new NullifierLeafPreimage(new NullifierLeaf(nullifier), nextNullifier, nextIndex);
}

async function nullifierTree(leaves: NullifierLeafPreimage[]) {
  const { root, witness } = await nullifierTreeFixture(leaves);
  return { root: testConstrained(root), witness };
}

describe('verifyNullifierNonMembership', () => {
  // Before the insert, the low leaf skips over the nullifier to the next leaf, so it is the low leaf of the nullifier
  // and of no other key. The insert appends the nullifier and points the low leaf at it.
  const low = NULLIFIER.sub(new Fr(1));
  const next = leaf(NULLIFIER.add(new Fr(1)));
  const beforeInsert = [leaf(low, next.leaf.nullifier, 1n), next];
  const afterInsert = [leaf(low, NULLIFIER, 2n), next, leaf(NULLIFIER, next.leaf.nullifier, 1n)];

  it('accepts the low leaf of a nullifier that the tree does not hold', async () => {
    const { root, witness } = await nullifierTree(beforeInsert);

    await expect(verifyNullifierNonMembership(NULLIFIER, witness(0), root)).resolves.toBeUndefined();
  });

  it('accepts the rightmost leaf as the low leaf of a nullifier above every key', async () => {
    const { root, witness } = await nullifierTree([leaf(low)]);

    await expect(verifyNullifierNonMembership(NULLIFIER, witness(0), root)).resolves.toBeUndefined();
  });

  it('refuses the zero nullifier', async () => {
    const { root, witness } = await nullifierTree(beforeInsert);

    await expect(verifyNullifierNonMembership(Fr.ZERO, witness(0), root)).rejects.toThrow(
      'Cannot prove non-inclusion for zero nullifier',
    );
  });

  // The empty leaf at an unused index is in the tree and skips over every key.
  it('refuses an empty leaf at an unused index as the low leaf', async () => {
    const { root, witness } = await nullifierTree([...afterInsert, NullifierLeafPreimage.empty()]);

    await expect(verifyNullifierNonMembership(NULLIFIER, witness(3), root)).rejects.toThrow(
      'Low-nullifier leaf is empty',
    );
  });

  it('refuses a low leaf that is not below the nullifier', async () => {
    const { root, witness } = await nullifierTree(afterInsert);

    await expect(verifyNullifierNonMembership(NULLIFIER, witness(2), root)).rejects.toThrow(
      `Low-nullifier witness ${NULLIFIER} is not below nullifier ${NULLIFIER}`,
    );
  });

  it('refuses the current low leaf of a nullifier that the tree holds', async () => {
    const { root, witness } = await nullifierTree(afterInsert);

    await expect(verifyNullifierNonMembership(NULLIFIER, witness(0), root)).rejects.toThrow(
      `Low-nullifier witness for ${NULLIFIER} does not skip over it`,
    );
  });

  // The low leaf and path from before the insert pass every range check. Only the root that holds the nullifier
  // refuses them.
  it('refuses a stale low leaf from before the nullifier was inserted', async () => {
    const before = await nullifierTree(beforeInsert);
    const after = await nullifierTree(afterInsert);

    await expect(verifyNullifierNonMembership(NULLIFIER, before.witness(0), after.root)).rejects.toThrow(
      `Membership witness verification failed for low-nullifier for ${NULLIFIER}`,
    );
  });
});

describe('assertIsFrozenTip', () => {
  it('accepts the latest block of the frozen archive', async () => {
    const { frozenArchiveRoot, frozenTip, frozenTipMembershipWitness } = await frozenTipFixture();

    await expect(
      assertIsFrozenTip(testConstrained(frozenArchiveRoot), frozenTip, frozenTipMembershipWitness),
    ).resolves.toBe(frozenTip);
  });

  it('refuses a header that the frozen archive does not hold', async () => {
    const { frozenArchiveRoot, frozenTipMembershipWitness } = await frozenTipFixture();
    const { frozenTip: other } = await frozenTipFixture({
      state: new StateReference(new AppendOnlyTreeSnapshot(Fr.random(), 1), PartialStateReference.empty()),
    });

    await expect(
      assertIsFrozenTip(testConstrained(frozenArchiveRoot), other, frozenTipMembershipWitness),
    ).rejects.toThrow(`Membership witness verification failed for block hash ${await other.hash()}`);
  });

  // The zero leaf names the check that the archive holds no block after the tip.
  it('refuses a member of the frozen archive that a later block follows', async () => {
    const { frozenArchiveRoot, frozenTip, frozenTipMembershipWitness } = await frozenTipFixture({ laterBlocks: 1 });

    await expect(
      assertIsFrozenTip(testConstrained(frozenArchiveRoot), frozenTip, frozenTipMembershipWitness),
    ).rejects.toThrow(`Membership witness verification failed for block hash ${Fr.ZERO}`);
  });
});
