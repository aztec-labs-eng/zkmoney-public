import { encodeBlockBlobData } from '@aztec/blob-lib/encoding';
import { ARCHIVE_HEIGHT } from '@aztec/constants';
import { BlockNumber } from '@aztec/foundation/branded-types';
import type { Fr } from '@aztec/foundation/curves/bn254';
import type { MembershipWitness } from '@aztec/foundation/trees';
import { BlockHash, L2Block } from '@aztec/stdlib/block';
import type { BlockHeader, TxEffect, TxHash } from '@aztec/stdlib/tx';

import type { ArchivedTxEffectsHints, TxBlockAnchorRelation, TxEffectsAtAnchorHints } from '@oxide/oxide-lib/types.js';

import { type ArchiveRef, blockResponseToL2Block } from './archive_ref.js';
import { PermanentError } from './errors.js';
import type { AnchoredNodeReads } from './node_read_memo.js';

/**
 * Produces hints that prove a transaction's effects belong to a block that is an ancestor of the given anchor block.
 *
 * @param chain - The chain data to query for blocks, effects, and membership witnesses.
 * @param txHash - Hash of the transaction whose effects we want to prove.
 * @param anchorBlockHash - Hash of the anchor block (the target block must be strictly before this one).
 * @returns The tx effects and the hints needed to verify ancestry.
 */
export async function produceTxEffectsAtAnchorHints(
  chain: AnchoredNodeReads,
  txHash: TxHash,
  anchorBlockHash: BlockHash,
): Promise<{ effects: TxEffect; hints: TxEffectsAtAnchorHints }> {
  // 1. Look up the tx effect
  const indexedTxEffect = await chain.getTxEffect(txHash);
  if (!indexedTxEffect) {
    throw new Error(`Tx effect not found for hash ${txHash}`);
  }

  // 2. Fetch the tx's block (including body so we can read tx effects + blob data)
  const txBlockResp = await chain.getBlock(indexedTxEffect.l2BlockNumber, { includeTransactions: true });
  if (!txBlockResp) {
    throw new Error(`Block ${indexedTxEffect.l2BlockNumber} not found`);
  }
  const txBlock = blockResponseToL2Block(txBlockResp);

  // 3. If the tx block is not the anchor block we will get a witness that it's some of the ancestors.
  const txBlockHash = await txBlock.hash();
  let anchorRelation: TxBlockAnchorRelation;
  if (txBlockHash.equals(anchorBlockHash)) {
    anchorRelation = { kind: 'txBlockIsAnchor' };
  } else {
    const archiveMembershipWitness = await chain.getBlockHashMembershipWitness(anchorBlockHash, txBlockHash);
    if (!archiveMembershipWitness) {
      throw new Error(
        `Tx block ${txBlock.number} is not an ancestor of anchor block (hash ${anchorBlockHash}). ` +
          `The anchor block's lastArchive does not contain the tx block's hash.`,
      );
    }
    anchorRelation = { kind: 'txBlockIsAncestorOfAnchor', archiveMembershipWitness };
  }

  // 4. Collect preceding blob fields and the predecessor header with its archive proof.
  const { previousBlocksBlobFields, previousBlockHeader, previousBlockArchiveMembershipWitness } =
    await computePreviousBlockHints(chain, txBlock, anchorBlockHash);

  return {
    effects: indexedTxEffect.data,
    hints: {
      anchorRelation,
      txEffectsHints: {
        txBlockHeader: txBlock.header,
        previousBlockHeader,
        previousBlockArchiveMembershipWitness,
        checkpointBlobFields: [...previousBlocksBlobFields, ...encodeBlockBlobData(txBlock.toBlockBlobData())],
        txBlockStartOffset: previousBlocksBlobFields.length,
        txIndexInBlock: indexedTxEffect.txIndexInBlock,
      },
    },
  };
}

/**
 * Produces hints that prove the effects of the tx with hash `txHash` belong to a block whose hash is in the given
 * `archive`. The witnesses are obtained from the provided `chain`.
 */
export async function produceArchivedTxEffectsHints(
  chain: AnchoredNodeReads,
  txHash: TxHash,
  archive: ArchiveRef,
): Promise<ArchivedTxEffectsHints> {
  // 1. Look up the tx effect
  const indexedTxEffect = await chain.getTxEffect(txHash);
  if (!indexedTxEffect) {
    throw new Error(`Tx effect not found for hash ${txHash}`);
  }

  // 2. Fetch the tx's block (including body so we can read tx effects + blob data)
  const txBlockResp = await chain.getBlock(indexedTxEffect.l2BlockNumber, { includeTransactions: true });
  if (!txBlockResp) {
    throw new Error(`Block ${indexedTxEffect.l2BlockNumber} not found`);
  }
  const txBlock = blockResponseToL2Block(txBlockResp);

  // 3. Get archive membership witness proving txBlock is in the archive.
  const txBlockHash = await txBlock.hash();
  const archiveMembershipWitness = await chain.getBlockHashMembershipWitness(
    archive.witnessReferenceBlockNumber,
    txBlockHash,
  );
  if (!archiveMembershipWitness) {
    throw new Error(`Tx block ${txBlockHash} is not in the archive ${archive.root}`);
  }

  // 4. Collect preceding blob fields and the predecessor header with its archive proof.
  const { previousBlocksBlobFields, previousBlockHeader, previousBlockArchiveMembershipWitness } =
    await computePreviousBlockHints(chain, txBlock, archive.witnessReferenceBlockNumber);

  return {
    archiveMembershipWitness,
    txEffectsHints: {
      txBlockHeader: txBlock.header,
      previousBlockHeader,
      previousBlockArchiveMembershipWitness,
      checkpointBlobFields: [...previousBlocksBlobFields, ...encodeBlockBlobData(txBlock.toBlockBlobData())],
      txBlockStartOffset: previousBlocksBlobFields.length,
      txIndexInBlock: indexedTxEffect.txIndexInBlock,
    },
  };
}

/**
 * Collects blob fields from checkpoint start up to the target block, plus the predecessor header and archive proof.
 * The enclave uses these fields to reconstruct the sponge and uses the predecessor proof to check the boundary.
 */
async function computePreviousBlockHints(
  chain: AnchoredNodeReads,
  txBlock: L2Block,
  archiveReferenceBlock: BlockNumber | BlockHash,
): Promise<{
  previousBlocksBlobFields: Fr[];
  previousBlockHeader: BlockHeader;
  previousBlockArchiveMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;
}> {
  if (txBlock.number === 0) {
    throw new PermanentError('Target block is genesis block, which is not supported as a target.');
  }

  const previousBlocksBlobFields: Fr[] = [];
  if (txBlock.indexWithinCheckpoint > 0) {
    // Collect all prior blocks in this checkpoint in order.
    const firstBlockInCheckpoint = BlockNumber(txBlock.number - txBlock.indexWithinCheckpoint);
    const previousBlocks = await chain.getBlocks(firstBlockInCheckpoint, txBlock.indexWithinCheckpoint, {
      includeTransactions: true,
    });
    if (previousBlocks.length !== txBlock.indexWithinCheckpoint) {
      throw new Error(
        `Expected ${txBlock.indexWithinCheckpoint} previous blocks in the checkpoint, got ${previousBlocks.length}`,
      );
    }
    for (const block of previousBlocks) {
      previousBlocksBlobFields.push(...encodeBlockBlobData(blockResponseToL2Block(block).toBlockBlobData()));
    }
  }

  // Fetch the immediate predecessor (target.blockNumber - 1) and its archive membership witness.
  // Its sponge hash authenticates the boundary between the preceding fields and the target block.
  // A different slot proves that the target block starts a new checkpoint.
  const prevBlockNumber = BlockNumber(txBlock.number - 1);
  const previousBlockData = await chain.getBlockData(prevBlockNumber);
  if (!previousBlockData) {
    throw new Error(`Previous block ${prevBlockNumber} header not found`);
  }
  const previousBlockHeader = previousBlockData.header;
  const previousBlockHash = previousBlockData.blockHash;
  const previousBlockArchiveMembershipWitness = await chain.getBlockHashMembershipWitness(
    archiveReferenceBlock,
    previousBlockHash,
  );
  if (!previousBlockArchiveMembershipWitness) {
    throw new Error(`Previous block ${prevBlockNumber} not found in anchor's archive.`);
  }

  return {
    previousBlocksBlobFields,
    previousBlockHeader,
    previousBlockArchiveMembershipWitness,
  };
}
