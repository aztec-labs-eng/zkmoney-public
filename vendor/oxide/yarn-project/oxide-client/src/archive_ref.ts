import { Fr } from '@aztec/aztec.js/fields';
import { BlockNumber, type CheckpointNumber } from '@aztec/foundation/branded-types';
import { L2Block } from '@aztec/stdlib/block';
import type { BlockResponse } from '@aztec/stdlib/interfaces/client';
import type { BlockHeader, TxHash } from '@aztec/stdlib/tx';

import type { ChainDataSource } from './chain_data_source.js';

/**
 * Minimum archive info every TEE-signed L1 finalization / refund proof needs.
 */
export interface ArchiveRef {
  root: Fr;
  checkpointNumber: CheckpointNumber;
  /** Header of the checkpoint's last L2 block; the operation anchor for the refund proof. */
  checkpointEndBlockHeader: BlockHeader;
  /**
   * Number of the block whose `lastArchive.root` equals `root`, used as the witness reference to
   * get the block-hash membership witness. The block need not exist.
   */
  witnessReferenceBlockNumber: BlockNumber;
}

/**
 * Build an `ArchiveRef` from a known archive root. Looks up the checkpoint-end block header
 * (whose archive IS `archiveRoot`) and derives the checkpoint number and witness-reference block
 * number.
 *
 * Throws if the checkpoint-end block isn't on the chain yet.
 */
export async function resolveArchive(chain: ChainDataSource, archiveRoot: Fr): Promise<ArchiveRef> {
  if (archiveRoot.equals(Fr.ZERO)) {
    throw new Error('resolveArchive called with zero archive root.');
  }
  const checkpointEnd = await chain.getBlockData({ archive: archiveRoot });
  if (!checkpointEnd) {
    throw new Error(`No L2 block found whose archive matches ${archiveRoot}.`);
  }
  return {
    root: archiveRoot,
    checkpointNumber: checkpointEnd.checkpointNumber,
    checkpointEndBlockHeader: checkpointEnd.header,
    witnessReferenceBlockNumber: BlockNumber(checkpointEnd.header.globalVariables.blockNumber + 1),
  };
}

/** True when `blockNumber` falls in `[startBlock, startBlock + blockCount)` of the checkpoint. */
export function checkpointContainsBlock(
  checkpoint: { startBlock: BlockNumber; blockCount: number },
  blockNumber: BlockNumber,
): boolean {
  return blockNumber >= checkpoint.startBlock && blockNumber < checkpoint.startBlock + checkpoint.blockCount;
}

/**
 * Resolve the archive root of the checkpoint containing the burn tx — the default anchor for a
 * withdrawal finalization.
 */
export async function resolveBurnCheckpointArchive(chain: ChainDataSource, txHash: TxHash): Promise<Fr> {
  const { slotNumber, blockNumber } = await chain.getTxReceipt(txHash);
  if (slotNumber === undefined || blockNumber === undefined) {
    throw new Error(`Burn tx ${txHash} is not yet in a checkpoint; cannot resolve its archive.`);
  }
  // The containing checkpoint is anchored at or before the burn's slot, so scan backwards from it.
  const [checkpoint] = await chain.getCheckpointsData({ fromSlot: slotNumber, limit: 1, reverse: true });
  if (!checkpoint || !checkpointContainsBlock(checkpoint, blockNumber)) {
    throw new Error(`No checkpoint containing burn block ${blockNumber} for tx ${txHash}.`);
  }
  return checkpoint.archive.root;
}

/** Wraps an `includeTransactions: true` block response in an `L2Block` so callers can use its
 *  `.hash()` / `.toBlockBlobData()` helpers. */
export function blockResponseToL2Block(r: BlockResponse<{ includeTransactions: true }>): L2Block {
  return new L2Block(r.archive, r.header, r.body, r.checkpointNumber, r.indexWithinCheckpoint);
}
