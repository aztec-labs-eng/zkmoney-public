import { ARCHIVE_HEIGHT } from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { MembershipWitness } from '@aztec-labs/foundation/trees';
import { BlockHash } from '@aztec-labs/stdlib/block';

import { describe, expect, it, jest } from '@jest/globals';

import { type AnchoredNodeReads, memoizeNodeReads } from './node_read_memo.js';

type AtArchive = AnchoredNodeReads['getBlockHashMembershipWitnessAtArchive'];
type AtAnchor = AnchoredNodeReads['getBlockHashMembershipWitness'];

function makeNode() {
  const atArchive = jest.fn<AtArchive>(({ archive }, blockHash) =>
    Promise.resolve(new MembershipWitness(ARCHIVE_HEIGHT, archive.toBigInt() + blockHash.toBigInt(), makePath())),
  );
  const atAnchor = jest.fn<AtAnchor>(() => Promise.resolve(MembershipWitness.empty(ARCHIVE_HEIGHT)));
  const node = {
    getBlockHashMembershipWitnessAtArchive: atArchive,
    getBlockHashMembershipWitness: atAnchor,
  } as unknown as AnchoredNodeReads;
  return { node, atArchive, atAnchor };
}

function makePath() {
  return MembershipWitness.empty(ARCHIVE_HEIGHT).siblingPath;
}

describe('memoizeNodeReads', () => {
  describe('getBlockHashMembershipWitnessAtArchive', () => {
    it('reads the node once per archive root and target block hash', async () => {
      const { node, atArchive } = makeNode();
      const memo = memoizeNodeReads(node);
      const archive = new Fr(10);
      const target = new BlockHash(new Fr(1));

      const first = await memo.getBlockHashMembershipWitnessAtArchive({ archive }, target);
      const second = await memo.getBlockHashMembershipWitnessAtArchive(
        { archive: new Fr(10) },
        new BlockHash(new Fr(1)),
      );

      expect(second).toBe(first);
      expect(atArchive).toHaveBeenCalledTimes(1);
    });

    it('keeps the witnesses of different archive roots and targets apart', async () => {
      const { node, atArchive } = makeNode();
      const memo = memoizeNodeReads(node);
      const target = new BlockHash(new Fr(1));

      const atFirstRoot = await memo.getBlockHashMembershipWitnessAtArchive({ archive: new Fr(10) }, target);
      const atSecondRoot = await memo.getBlockHashMembershipWitnessAtArchive({ archive: new Fr(20) }, target);
      const otherTarget = await memo.getBlockHashMembershipWitnessAtArchive(
        { archive: new Fr(10) },
        new BlockHash(new Fr(2)),
      );

      expect(atFirstRoot!.leafIndex).toBe(11n);
      expect(atSecondRoot!.leafIndex).toBe(21n);
      expect(otherTarget!.leafIndex).toBe(12n);
      expect(atArchive).toHaveBeenCalledTimes(3);
    });

    it('does not share entries with the anchor-header witness', async () => {
      // `{ archive }` names a root for one method and a reference block for the other, so a shared key would hand
      // back a witness against the wrong archive.
      const { node, atArchive, atAnchor } = makeNode();
      const memo = memoizeNodeReads(node);
      const archive = new Fr(10);
      const target = new BlockHash(new Fr(1));

      await memo.getBlockHashMembershipWitness({ archive }, target);
      await memo.getBlockHashMembershipWitnessAtArchive({ archive }, target);

      expect(atAnchor).toHaveBeenCalledTimes(1);
      expect(atArchive).toHaveBeenCalledTimes(1);
    });

    it('forwards only the archive selector', async () => {
      const { node, atArchive } = makeNode();
      const memo = memoizeNodeReads(node);
      const reference = { archive: new Fr(10), number: 3 } as unknown as { archive: Fr };

      await memo.getBlockHashMembershipWitnessAtArchive(reference, new BlockHash(new Fr(1)));

      expect(atArchive.mock.calls[0][0]).toEqual({ archive: new Fr(10) });
    });

    it('does not cache a failed read', async () => {
      const { node, atArchive } = makeNode();
      atArchive.mockRejectedValueOnce(new Error('unknown archive'));
      const memo = memoizeNodeReads(node);
      const archive = new Fr(10);
      const target = new BlockHash(new Fr(1));

      await expect(memo.getBlockHashMembershipWitnessAtArchive({ archive }, target)).rejects.toThrow('unknown archive');
      await expect(memo.getBlockHashMembershipWitnessAtArchive({ archive }, target)).resolves.toBeDefined();
      expect(atArchive).toHaveBeenCalledTimes(2);
    });
  });
});
