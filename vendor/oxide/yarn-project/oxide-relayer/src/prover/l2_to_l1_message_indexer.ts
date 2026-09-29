import { OUT_HASH_TREE_LEAF_COUNT } from '@aztec/constants';
import { Fr } from '@aztec/foundation/curves/bn254';
import { SiblingPath, UnbalancedMerkleTreeCalculator, computeUnbalancedShaRoot } from '@aztec/foundation/trees';
import { Checkpoint } from '@aztec/stdlib/checkpoint';

import { ObservedTx } from './types.js';

interface IndexedTx {
  checkpointIndex: number;
  blockIndex: number;
  txIndex: number;
  messageTree?: UnbalancedMerkleTreeCalculator;
}

export class L2ToL1MessageIndexer {
  private readonly txs = new Map<string, IndexedTx>();
  private readonly blockTrees: UnbalancedMerkleTreeCalculator[][] = [];
  private readonly checkpointTrees: UnbalancedMerkleTreeCalculator[] = [];
  private readonly epochTree: UnbalancedMerkleTreeCalculator;

  constructor(checkpoints: Checkpoint[]) {
    const checkpointOutHashes: Buffer[] = [];

    checkpoints.forEach((checkpoint, checkpointIndex) => {
      const blockTrees: UnbalancedMerkleTreeCalculator[] = [];
      const blockOutHashes = checkpoint.blocks.map((block, blockIndex) => {
        const txOutHashes = block.body.txEffects.map((txEffect, txIndex) => {
          const messages = txEffect.l2ToL1Msgs.map(msg => msg.toBuffer());
          const messageTree = messages.length ? UnbalancedMerkleTreeCalculator.create(messages) : undefined;
          this.txs.set(txKey(block.number, txIndex), { checkpointIndex, blockIndex, txIndex, messageTree });
          return computeUnbalancedShaRoot(messages);
        });
        const blockTree = buildCompressedTree(txOutHashes);
        blockTrees.push(blockTree);
        return blockTree.getRoot();
      });

      this.blockTrees.push(blockTrees);
      const checkpointTree = buildCompressedTree(blockOutHashes);
      this.checkpointTrees.push(checkpointTree);
      checkpointOutHashes.push(checkpointTree.getRoot());
    });

    this.epochTree = UnbalancedMerkleTreeCalculator.create(
      checkpointOutHashes.concat(
        Array.from({ length: OUT_HASH_TREE_LEAF_COUNT - checkpoints.length }, () => Buffer.alloc(32)),
      ),
    );
  }

  getLeafIndex(tx: ObservedTx, message: Fr, messageIndexInTx?: number): bigint {
    const targetTx = this.txs.get(txKey(tx.blockNumber, tx.txIndexInBlock));
    if (!targetTx) {
      throw new Error(`Tx ${tx.txEffect.txHash} is not in the indexed checkpoint set`);
    }

    const messagesInTx = tx.txEffect.l2ToL1Msgs;
    const resolvedMessageIndex = resolveMessageIndex(messagesInTx, message, messageIndexInTx);
    const { checkpointIndex, blockIndex, txIndex, messageTree } = targetTx;
    if (!messageTree) {
      throw new Error(`Target tx has no L2 to L1 messages`);
    }

    const blockTree = this.blockTrees[checkpointIndex][blockIndex];
    const checkpointTree = this.checkpointTrees[checkpointIndex];

    const messageLeafPosition = messageTree.getLeafLocation(resolvedMessageIndex);
    const txLeafPosition = blockTree.getLeafLocation(txIndex);
    const blockLeafPosition = checkpointTree.getLeafLocation(blockIndex);
    const checkpointLeafPosition = this.epochTree.getLeafLocation(checkpointIndex);
    const numLeavesInLeftCheckpoints = checkpointLeafPosition.index * (1 << blockLeafPosition.level);
    const indexAtCheckpointLevel = numLeavesInLeftCheckpoints + blockLeafPosition.index;
    const numLeavesInLeftBlocks = indexAtCheckpointLevel * (1 << txLeafPosition.level);
    const indexAtTxLevel = numLeavesInLeftBlocks + txLeafPosition.index;
    const numLeavesInLeftTxs = indexAtTxLevel * (1 << messageLeafPosition.level);
    return BigInt(numLeavesInLeftTxs + messageLeafPosition.index);
  }

  getSiblingPath(tx: ObservedTx, message: Fr, messageIndexInTx?: number): SiblingPath<number> {
    const indexedTx = this.txs.get(txKey(tx.blockNumber, tx.txIndexInBlock));
    if (!indexedTx) {
      throw new Error(`Tx ${tx.txEffect.txHash} is not in the indexed checkpoint set`);
    }

    const messagesInTx = tx.txEffect.l2ToL1Msgs;
    const resolvedMessageIndex = resolveMessageIndex(messagesInTx, message, messageIndexInTx);
    const { checkpointIndex, blockIndex, txIndex, messageTree } = indexedTx;
    if (!messageTree) {
      throw new Error(`Indexed tx has no L2 to L1 messages`);
    }
    const combinedPath = messageTree
      .getSiblingPathByLeafIndex(resolvedMessageIndex)
      .toBufferArray()
      .concat(this.blockTrees[checkpointIndex][blockIndex].getSiblingPathByLeafIndex(txIndex).toBufferArray())
      .concat(this.checkpointTrees[checkpointIndex].getSiblingPathByLeafIndex(blockIndex).toBufferArray())
      .concat(this.epochTree.getSiblingPathByLeafIndex(checkpointIndex).toBufferArray());

    return new SiblingPath(combinedPath.length, combinedPath);
  }
}

function resolveMessageIndex(messagesInTx: Fr[], message: Fr, messageIndexInTx?: number): number {
  if (messageIndexInTx !== undefined) {
    if (!messagesInTx[messageIndexInTx]?.equals(message)) {
      throw new Error(`Message at index ${messageIndexInTx} in tx does not match the expected message ${message}`);
    }
    return messageIndexInTx;
  }

  const indices = messagesInTx.reduce<number[]>((acc, msg, i) => {
    if (msg.equals(message)) {
      acc.push(i);
    }
    return acc;
  }, []);

  if (indices.length === 0) {
    throw new Error('The L2ToL1Message you are trying to prove inclusion of does not exist');
  }
  if (indices.length > 1) {
    throw new Error(
      `Multiple messages with the same value ${message} found in tx (indices: ${indices.join(', ')}). ` +
        `Provide messageIndexInTx to disambiguate.`,
    );
  }
  return indices[0];
}

function buildCompressedTree(leaves: Buffer[]) {
  return UnbalancedMerkleTreeCalculator.create(leaves, Buffer.alloc(32));
}

function txKey(blockNumber: number | bigint, txIndex: number): string {
  return `${blockNumber}:${txIndex}`;
}
