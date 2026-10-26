import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import {
  L2BlockStream,
  type L2BlockStreamEvent,
  type L2BlockStreamEventHandler,
  L2TipsMemoryStore,
} from '@aztec-labs/stdlib/block';
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client';

import type { FinalizationRequestSource } from './finalization_request_source.js';
import { blockStreamSourceFromAztecNode, getInitialBlockHash } from './node_block_stream_source.js';

/** Wait between the polls for new L2 blocks of a {@link FinalizationRequestWatcher}. */
const WATCHER_POLL_INTERVAL_MS = 1_000;

/**
 * Reads the finalization requests of each new L2 block into a {@link FinalizationRequestSource}, while the node still
 * serves the block's txs. The node drops a tx when its block is finalized. The claim collector discovers a withdrawal
 * only when the proof of its block lands, and an early proof can finalize the block before that.
 */
export class FinalizationRequestWatcher implements L2BlockStreamEventHandler {
  private blockStream?: L2BlockStream;
  private tipsStore?: L2TipsMemoryStore;
  private readonly log: Logger;

  constructor(
    private readonly node: AztecNode,
    private readonly requestSource: FinalizationRequestSource,
    logger?: Logger,
  ) {
    this.log = logger ?? createLogger('oxide-relayer:finalization-request-watcher');
  }

  async start(): Promise<void> {
    this.tipsStore = new L2TipsMemoryStore(await getInitialBlockHash(this.node));
    // Finalized blocks are skipped: the node no longer serves their txs.
    this.blockStream = new L2BlockStream(blockStreamSourceFromAztecNode(this.node), this.tipsStore, this, this.log, {
      pollIntervalMS: WATCHER_POLL_INTERVAL_MS,
      skipFinalized: true,
    });
    this.blockStream.start();
  }

  async stop(): Promise<void> {
    await this.blockStream?.stop();
  }

  async handleBlockStreamEvent(event: L2BlockStreamEvent): Promise<void> {
    await this.tipsStore!.handleBlockStreamEvent(event);
    if (event.type !== 'blocks-added') {
      return;
    }
    for (const block of event.blocks) {
      for (const effect of block.body.txEffects) {
        // A withdrawal sends an L2-to-L1 message, so a tx without one has no request to read.
        if (effect.l2ToL1Msgs.length === 0) {
          continue;
        }
        try {
          await this.requestSource.requestsFor(effect.txHash, effect);
        } catch (error) {
          this.log.warn('Could not read the finalization requests of a tx', {
            txHash: effect.txHash.toString(),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}
