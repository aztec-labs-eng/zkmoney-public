// Merkle membership-witness verification helpers.
import { Fr } from '@aztec/aztec.js/fields';
import { ARCHIVE_HEIGHT, DomainSeparator, L1_TO_L2_MSG_TREE_HEIGHT } from '@aztec/constants';
import { poseidon2Hash, poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import type { BaseFr } from '@aztec/foundation/curves/bn254';
import { MembershipWitness } from '@aztec/foundation/trees';
import type { NullifierMembershipWitness, PublicDataWitness } from '@aztec/stdlib/trees';
import type { BlockHeader } from '@aztec/stdlib/tx';

import { type Constrained, derive, markConstrained } from './constrained.js';

type Hasher = (left: Fr, right: Fr) => Promise<Fr>;

function makeHasher(separator: number): Hasher {
  return (left, right) => poseidon2HashWithSeparator([left, right], separator);
}

const merkleHash = makeHasher(DomainSeparator.MERKLE_HASH);
const nullifierMerkleHash = makeHasher(DomainSeparator.NULLIFIER_MERKLE);
const publicDataMerkleHash = makeHasher(DomainSeparator.PUBLIC_DATA_MERKLE);

async function computeRootFromSiblingPath(
  leaf: Fr,
  siblingPath: readonly Fr[],
  leafIndex: bigint,
  hasher: Hasher,
): Promise<Fr> {
  const pathLength = siblingPath.length;
  if (leafIndex < 0n || leafIndex >= 1n << BigInt(pathLength)) {
    throw new Error(`leafIndex ${leafIndex} out of range for path length ${pathLength}`);
  }
  let result = leaf;
  let index = leafIndex;
  for (const sibling of siblingPath) {
    result = (index & 1n) === 1n ? await hasher(sibling, result) : await hasher(result, sibling);
    index >>= 1n;
  }
  return result;
}

async function verifyMembership<N extends number>(
  leaf: Fr,
  witness: MembershipWitness<N>,
  expectedRoot: Constrained<Fr>,
  label: string,
  hasher: Hasher,
): Promise<void> {
  const computedRoot = await computeRootFromSiblingPath(leaf, witness.siblingPath, witness.leafIndex, hasher);
  if (!computedRoot.equals(expectedRoot)) {
    throw new Error(`Membership witness verification failed for ${label}`);
  }
}

export async function verifyArchiveMembership(
  blockHash: BaseFr,
  witness: MembershipWitness<typeof ARCHIVE_HEIGHT>,
  expectedRoot: Constrained<Fr>,
): Promise<void> {
  await verifyMembership(new Fr(blockHash.toBuffer()), witness, expectedRoot, `block hash ${blockHash}`, merkleHash);
}

/** Verifies `header`'s hash is a leaf under a constrained archive root; returns the header constrained. */
export async function verifyBlockHeaderInArchive(
  header: BlockHeader,
  witness: MembershipWitness<typeof ARCHIVE_HEIGHT>,
  expectedRoot: Constrained<Fr>,
): Promise<Constrained<BlockHeader>> {
  await verifyArchiveMembership(await header.hash(), witness, expectedRoot);
  return markConstrained(header, 'archive membership');
}

/**
 * Constrains `frozenTip` to be the right-most leaf of the `frozenArchive`.
 *
 * TS-side mirror of `refund_lib::assert_is_frozen_tip`.
 */
export async function assertIsFrozenTip(
  frozenArchiveRoot: Constrained<Fr>,
  frozenTip: BlockHeader,
  archiveMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>,
): Promise<Constrained<BlockHeader>> {
  const blockHash = await frozenTip.hash();
  const witness = new MembershipWitness<typeof ARCHIVE_HEIGHT>(
    ARCHIVE_HEIGHT,
    BigInt(frozenTip.getBlockNumber()),
    archiveMembershipWitness.siblingPath,
  );
  await verifyArchiveMembership(blockHash, witness, frozenArchiveRoot);
  const constrainedHeader = markConstrained(frozenTip, 'archive membership: frozen archive tip');
  await verifyArchiveMembership(
    Fr.zero(),
    witness,
    derive(constrainedHeader, h => h.lastArchive.root),
  );
  return constrainedHeader;
}

export async function verifyL1ToL2MessageMembership(
  messageHash: Fr,
  witness: MembershipWitness<typeof L1_TO_L2_MSG_TREE_HEIGHT>,
  expectedRoot: Constrained<Fr>,
): Promise<void> {
  await verifyMembership(messageHash, witness, expectedRoot, `L1->L2 message ${messageHash}`, merkleHash);
}

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

export async function verifyNullifierNonMembership(
  nullifier: Fr,
  lowLeafWitness: NullifierMembershipWitness,
  nullifierRoot: Constrained<Fr>,
): Promise<void> {
  // 1. `nullifier != 0` — `Fr.zero()` is the canonical empty-slot sentinel and cannot be proven absent,
  if (nullifier.isZero()) {
    throw new Error('Cannot prove non-inclusion for zero nullifier');
  }

  // 2. the low leaf is non-empty — empty leaves are padding occupying the tree's untouched indices
  //    and have `nullifier == 0` with `nextKey == 0`, so they would vacuously satisfy the bound
  //    checks below and let any target slip through; they are never a valid low leaf,
  const leafPreimage = lowLeafWitness.leafPreimage;
  if (leafPreimage.leaf.isEmpty()) {
    throw new Error('Low-nullifier leaf is empty');
  }

  // 3. `lowLeaf.nullifier < nullifier` (low leaf is strictly below the target),
  const lowNullifier = leafPreimage.leaf.nullifier;
  if (!lowNullifier.lt(nullifier)) {
    throw new Error(`Low-nullifier witness ${lowNullifier} is not below nullifier ${nullifier}`);
  }

  // 4. either the low leaf is the rightmost (`nextIndex == 0`) or `nullifier < lowLeaf.nextKey`
  //    (the target falls in the gap the low leaf skips over),
  const nextNullifier = leafPreimage.nextKey;
  if (leafPreimage.nextIndex !== 0n && !nullifier.lt(nextNullifier)) {
    throw new Error(`Low-nullifier witness for ${nullifier} does not skip over it`);
  }

  // 5. the low leaf is actually in the tree (membership proof of its `poseidon2(toHashInputs())`).
  const leafHash = await poseidon2Hash(leafPreimage.toHashInputs());
  await verifyMembership(
    leafHash,
    lowLeafWitness.withoutPreimage(),
    nullifierRoot,
    `low-nullifier for ${nullifier}`,
    nullifierMerkleHash,
  );
}
