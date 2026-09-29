import { BlockNumber, CheckpointNumber } from '@aztec/foundation/branded-types';
import { type BlockHash, GENESIS_BLOCK_HEADER_HASH, L2Block, type L2BlockStream } from '@aztec/stdlib/block';
import { Checkpoint } from '@aztec/stdlib/checkpoint';
import type { AztecNode } from '@aztec/stdlib/interfaces/client';

type L2BlockStreamSource = ConstructorParameters<typeof L2BlockStream>[0];

/**
 * Lifts an {@link AztecNode} RPC client into the shape {@link L2BlockStream} expects. `getBlocks`
 * requests transaction bodies so real `L2Block` instances can be constructed; the stream no longer
 * fetches checkpoint payloads (`chain-checkpointed` is a thin tip event), so consumers fetch them
 * on demand.
 */
export function blockStreamSourceFromAztecNode(node: AztecNode): L2BlockStreamSource {
  return {
    getL2Tips: () => node.getChainTips(),
    async getBlockData(query) {
      const response = await node.getBlock(query);
      if (!response) {
        return undefined;
      }
      return {
        header: response.header,
        archive: response.archive,
        blockHash: response.hash,
        checkpointNumber: response.checkpointNumber,
        indexWithinCheckpoint: response.indexWithinCheckpoint,
      };
    },
    async getBlocks(query) {
      // Epoch lookups are not exposed on the public AztecNode RPC; only `from + limit` is.
      if (!('from' in query)) {
        throw new Error('getBlocks with epoch query not supported via AztecNode RPC');
      }
      if (query.onlyCheckpointed) {
        throw new Error('getBlocks with onlyCheckpointed not supported via AztecNode RPC');
      }
      const responses = await node.getBlocks(query.from, query.limit, { includeTransactions: true });
      return responses.map(r => new L2Block(r.archive, r.header, r.body, r.checkpointNumber, r.indexWithinCheckpoint));
    },
  };
}

/**
 * Hash the tips store anchors reorg detection on. Deployments with a non-default genesis (prefilled
 * public data, non-zero timestamp) report it via block 0; fall back to the static constant when the
 * node does not expose a genesis block.
 */
export async function getInitialBlockHash(node: AztecNode): Promise<BlockHash> {
  return (await node.getBlock(BlockNumber.ZERO))?.hash ?? GENESIS_BLOCK_HEADER_HASH;
}

/** Fetches `limit` checkpoints starting at `from` with full block payloads as `Checkpoint` instances. */
export async function getFullCheckpoints(
  node: AztecNode,
  from: CheckpointNumber,
  limit: number,
): Promise<Checkpoint[]> {
  const published = await node.getCheckpoints(from, limit, { includeBlocks: true, includeTransactions: true });
  return published.map(
    r =>
      new Checkpoint(
        r.archive,
        r.header,
        r.blocks.map(b => new L2Block(b.archive, b.header, b.body, b.checkpointNumber, b.indexWithinCheckpoint)),
        r.number,
        r.feeAssetPriceModifier,
      ),
  );
}
