import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { BlockHeader } from '@aztec-labs/stdlib/tx';

import { type Constrained, derive, markConstrained } from '@oxide/oxide-lib-tee/constrained.js';
import { verifyBlockHeaderInArchive, verifyTxEffectsTreeMembership } from '@oxide/oxide-lib-tee/membership.js';
import {
  type TeeTxEffect,
  computeTxEffectLeafFromHint,
  decodeTxEffectHint,
} from '@oxide/oxide-lib-tee/tx_effect_hint.js';
import type { ArchivedTxEffectsHints, TxEffectsAtAnchorHints, TxEffectsHints } from '@oxide/oxide-lib-tee/types.js';

/**
 * Verifies that the tx is in the anchor block or in an ancestor of the anchor block, and returns its verified effects.
 */
export async function verifyAndDecodeTxEffectsAtAnchor(
  hints: TxEffectsAtAnchorHints,
  anchorBlockHeader: Constrained<BlockHeader>,
): Promise<Constrained<TeeTxEffect>> {
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

  // 2. Verify that the tx effects are in the tx effects tree of the block.
  return verifyTxEffectInBlock(hints.txEffectsHints, txBlockHeader);
}

/**
 * Verifies that the tx is in a block of the archive `archiveRoot`, and returns its verified effects and block header.
 */
export async function verifyAndDecodeArchivedTxEffects(
  hints: ArchivedTxEffectsHints,
  archiveRoot: Constrained<Fr>,
): Promise<{ txEffect: Constrained<TeeTxEffect>; txBlockHeader: Constrained<BlockHeader> }> {
  const txBlockHeader = await verifyBlockHeaderInArchive(
    hints.txEffectsHints.txBlockHeader,
    hints.archiveMembershipWitness,
    archiveRoot,
  );
  const txEffect = await verifyTxEffectInBlock(hints.txEffectsHints, txBlockHeader);
  return { txEffect, txBlockHeader };
}

/** Decodes the tx effect hint and verifies that its leaf is in the tx effects tree of the block. */
export async function verifyTxEffectInBlock(
  hints: TxEffectsHints,
  txBlockHeader: Constrained<BlockHeader>,
): Promise<Constrained<TeeTxEffect>> {
  let txEffect: TeeTxEffect;
  try {
    txEffect = decodeTxEffectHint(hints.txEffect);
  } catch (err) {
    throw new Error(`Failed to decode tx effect hint: ${err instanceof Error ? err.message : err}`);
  }

  // Never accept a leaf from the caller: with variable-depth paths an internal node would pass as a leaf.
  const leaf = await computeTxEffectLeafFromHint(hints.txEffect);
  await verifyTxEffectsTreeMembership(
    leaf,
    hints.leafIndex,
    hints.siblingPath,
    derive(txBlockHeader, h => h.txEffectsTreeRoot),
  );
  return markConstrained(txEffect, 'leaf recomputed from the effects hashes to the authenticated tx effects tree root');
}
