import { SpongeBlob } from '@aztec/blob-lib';
import { type BlockBlobData, decodeBlockBlobData } from '@aztec/blob-lib/encoding';
import { Fr } from '@aztec/foundation/curves/bn254';
import { FieldReader } from '@aztec/foundation/serialize';
import { type BlockHeader, TxEffect } from '@aztec/stdlib/tx';

import { type Constrained, derive, markConstrained } from '@oxide/oxide-lib/constrained.js';
import { verifyBlockHeaderInArchive } from '@oxide/oxide-lib/membership.js';
import type { ArchivedTxEffectsHints, TxEffectsAtAnchorHints, TxEffectsHints } from '@oxide/oxide-lib/types.js';

/**
 * Proves that the tx was included in the chain at anchor block or one of its ancestors, and returns its effects
 * decoded from the block's DA-committed blob fields.
 */
export async function verifyAndDecodeTxEffectsAtAnchor(
  hints: TxEffectsAtAnchorHints,
  anchorBlockHeader: Constrained<BlockHeader>,
): Promise<Constrained<TxEffect>> {
  const archiveRoot = derive(anchorBlockHeader, h => h.lastArchive.root);

  // 1. Verify that the block in which the tx was included is either the anchor block or is one of the anchor block's
  // ancestors.
  let txBlockHeader: Constrained<BlockHeader>;
  switch (hints.anchorRelation.kind) {
    case 'txBlockIsAnchor': {
      const anchorBlockHash = await anchorBlockHeader.hash();
      const txBlockHash = await hints.txEffectsHints.txBlockHeader.hash();
      if (!anchorBlockHash.equals(txBlockHash)) {
        throw new Error('Tx block claims to be the anchor block but its hash differs from the anchor block hash');
      }
      txBlockHeader = markConstrained(hints.txEffectsHints.txBlockHeader, 'hash equals anchor block hash');
      break;
    }
    case 'txBlockIsAncestorOfAnchor':
      txBlockHeader = await verifyBlockHeaderInArchive(
        hints.txEffectsHints.txBlockHeader,
        hints.anchorRelation.archiveMembershipWitness,
        archiveRoot,
      );
      break;
    default: {
      // Just to be sure we don't accidentally introduce a typo which would result in the check being skipped.
      const unknownRelation: never = hints.anchorRelation;
      throw new Error(`Unknown anchor relation kind: ${JSON.stringify(unknownRelation)}`);
    }
  }

  // 2. Authenticate the blob field stream against the block's sponge blob hash and decode the tx effect from it
  return authenticateBlobFieldsAndDecodeTxEffect(hints.txEffectsHints, txBlockHeader, archiveRoot);
}

/**
 * Proves that the tx was included in a block whose hash is a leaf of the given archive root, and returns its effects
 * decoded from the block's DA-committed blob fields, along with the constrained block header.
 */
export async function verifyAndDecodeArchivedTxEffects(
  hints: ArchivedTxEffectsHints,
  archiveRoot: Constrained<Fr>,
): Promise<{ txEffect: Constrained<TxEffect>; txBlockHeader: Constrained<BlockHeader> }> {
  const txBlockHeader = await verifyBlockHeaderInArchive(
    hints.txEffectsHints.txBlockHeader,
    hints.archiveMembershipWitness,
    archiveRoot,
  );
  const txEffect = await authenticateBlobFieldsAndDecodeTxEffect(hints.txEffectsHints, txBlockHeader, archiveRoot);
  return { txEffect, txBlockHeader };
}

/** Authenticates the block's blob field stream and decodes the tx effect at txIndexInBlock from it. */
async function authenticateBlobFieldsAndDecodeTxEffect(
  hints: TxEffectsHints,
  txBlockHeader: Constrained<BlockHeader>,
  archiveRoot: Constrained<Fr>,
): Promise<Constrained<TxEffect>> {
  if (
    !Number.isInteger(hints.txBlockStartOffset) ||
    hints.txBlockStartOffset < 0 ||
    hints.txBlockStartOffset >= hints.checkpointBlobFields.length
  ) {
    throw new Error(
      `txBlockStartOffset ${hints.txBlockStartOffset} is out of range [0, ${hints.checkpointBlobFields.length})`,
    );
  }

  const { isFirstBlockInCheckpoint, previousBlockEndSpongeBlob } = await reconstructPreviousBlockEndSponge(
    hints,
    txBlockHeader,
    archiveRoot,
  );

  const blockBlobData = await verifyAndDecodeBlockBlobFields(
    previousBlockEndSpongeBlob,
    hints.checkpointBlobFields.slice(hints.txBlockStartOffset),
    isFirstBlockInCheckpoint,
    derive(txBlockHeader, h => h.spongeBlobHash),
  );

  if (hints.txIndexInBlock < 0 || hints.txIndexInBlock >= blockBlobData.txs.length) {
    throw new Error(`txIndexInBlock ${hints.txIndexInBlock} is out of range [0, ${blockBlobData.txs.length})`);
  }
  return derive(blockBlobData, d => TxEffect.fromTxBlobData(d.txs[hints.txIndexInBlock]));
}

/** Authenticates a raw block blob field stream against the block's published sponge blob hash, then decodes it. */
export async function verifyAndDecodeBlockBlobFields(
  previousBlockEndSpongeBlob: Constrained<SpongeBlob>,
  blockBlobFields: Fr[],
  isFirstBlockInCheckpoint: boolean,
  expectedSpongeBlobHash: Constrained<Fr>,
): Promise<Constrained<BlockBlobData>> {
  const sponge = previousBlockEndSpongeBlob.clone();
  await sponge.absorb(blockBlobFields);
  const computedSpongeBlobHash = await sponge.squeeze();
  if (!computedSpongeBlobHash.equals(expectedSpongeBlobHash)) {
    throw new Error(
      `Sponge blob hash mismatch: computed ${computedSpongeBlobHash}, expected ${expectedSpongeBlobHash}`,
    );
  }

  const reader = new FieldReader(blockBlobFields);
  let blockBlobData: BlockBlobData;
  try {
    blockBlobData = decodeBlockBlobData(reader, isFirstBlockInCheckpoint);
  } catch (err) {
    throw new Error(`Failed to decode verified block blob fields: ${err instanceof Error ? err.message : err}`);
  }
  if (!reader.isFinished()) {
    throw new Error(`Block blob fields carry ${reader.remainingFields()} trailing fields past the block end data`);
  }
  return markConstrained(blockBlobData, 'blob fields absorb to constrained sponge hash');
}

/** Reconstructs the sponge from checkpoint start and authenticates the boundary before the target block. */
async function reconstructPreviousBlockEndSponge(
  hints: TxEffectsHints,
  txBlockHeader: Constrained<BlockHeader>,
  archiveRoot: Constrained<Fr>,
): Promise<{ isFirstBlockInCheckpoint: boolean; previousBlockEndSpongeBlob: Constrained<SpongeBlob> }> {
  const previousBlockHeader = await verifyBlockHeaderInArchive(
    hints.previousBlockHeader,
    hints.previousBlockArchiveMembershipWitness,
    archiveRoot,
  );

  // The authenticated previous block must be the immediate predecessor.
  const prevBlockNumber = previousBlockHeader.getBlockNumber();
  const txBlockNumber = txBlockHeader.getBlockNumber();
  if (prevBlockNumber + 1 !== txBlockNumber) {
    throw new Error(
      `Previous block is not the immediate predecessor: prev blockNumber ${prevBlockNumber} + 1 !== target blockNumber ${txBlockNumber}`,
    );
  }

  // Derive is-first-in-checkpoint from slot comparison (each checkpoint has a unique slot).
  const prevSlot = previousBlockHeader.globalVariables.slotNumber;
  const targetSlot = txBlockHeader.globalVariables.slotNumber;
  const isFirstBlockInCheckpoint = prevSlot !== targetSlot;

  // Never accept a continuation state from the caller. A squeezed hash does not authenticate the full state.
  const sponge = SpongeBlob.init();
  if (isFirstBlockInCheckpoint) {
    if (hints.txBlockStartOffset !== 0) {
      throw new Error('First block in checkpoint must have txBlockStartOffset 0');
    }
  } else {
    await sponge.absorb(hints.checkpointBlobFields.slice(0, hints.txBlockStartOffset));
    // Check a clone so the reconstructed sponge can continue into the target block without a squeeze.
    // This check authenticates the split between preceding fields and target fields.
    const squeezed = await sponge.clone().squeeze();
    if (!squeezed.equals(previousBlockHeader.spongeBlobHash)) {
      throw new Error(
        `Previous blocks blob hash mismatch: computed ${squeezed}, expected ${previousBlockHeader.spongeBlobHash}`,
      );
    }
  }

  return {
    isFirstBlockInCheckpoint,
    previousBlockEndSpongeBlob: markConstrained(
      sponge,
      'reconstructed from init; block boundary checked against authenticated predecessor',
    ),
  };
}
