import { Fr } from '@aztec/aztec.js/fields';
import { ARCHIVE_HEIGHT, DomainSeparator } from '@aztec/constants';
import { BlockNumber } from '@aztec/foundation/branded-types';
import { AppendOnlyTreeSnapshot } from '@aztec/stdlib/trees';
import { BlockHeader, GlobalVariables, type StateReference } from '@aztec/stdlib/tx';

import { SparseTree } from './sparse_tree.js';

/** The block number of the frozen tip. Earlier blocks come before it, so its sibling path has left siblings. */
const TIP_BLOCK_NUMBER = 7;

/**
 * A frozen archive whose block 7 is `frozenTip`, with `state` as the tip's state and random earlier blocks. With no
 * `laterBlocks`, the tip is the latest block. Each later block is a random leaf after the tip, which keeps the tip a
 * member of the archive but not its latest block.
 */
export async function frozenTipFixture(opts: { state?: StateReference; laterBlocks?: number } = {}) {
  const earlierBlocks = Array.from({ length: TIP_BLOCK_NUMBER }, () => Fr.random());
  const lastArchive = await SparseTree.build(ARCHIVE_HEIGHT, earlierBlocks, DomainSeparator.MERKLE_HASH);
  const frozenTip = BlockHeader.empty({
    lastArchive: new AppendOnlyTreeSnapshot(lastArchive.root, TIP_BLOCK_NUMBER),
    globalVariables: GlobalVariables.empty({ blockNumber: BlockNumber(TIP_BLOCK_NUMBER) }),
    ...(opts.state ? { state: opts.state } : {}),
  });
  const blockHash = new Fr((await frozenTip.hash()).toBuffer());
  const laterBlocks = Array.from({ length: opts.laterBlocks ?? 0 }, () => Fr.random());
  const archive = await SparseTree.build(
    ARCHIVE_HEIGHT,
    [...earlierBlocks, blockHash, ...laterBlocks],
    DomainSeparator.MERKLE_HASH,
  );
  return {
    frozenArchiveRoot: archive.root,
    frozenTip,
    frozenTipMembershipWitness: archive.membershipWitness<typeof ARCHIVE_HEIGHT>(TIP_BLOCK_NUMBER),
  };
}
