import { BlockNumber, CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { type Logger, createLogger } from '@aztec/foundation/log';
import { SerialQueue } from '@aztec/foundation/queue';
import {
  L2BlockStream,
  type L2BlockStreamEvent,
  type L2BlockStreamEventHandler,
  L2TipsMemoryStore,
} from '@aztec/stdlib/block';
import { Checkpoint } from '@aztec/stdlib/checkpoint';
import { getEpochAtSlot } from '@aztec/stdlib/epoch-helpers';
import { AztecNode } from '@aztec/stdlib/interfaces/server';

import {
  blockStreamSourceFromAztecNode,
  getFullCheckpoints,
  getInitialBlockHash,
} from '../node_block_stream_source.js';

export interface CheckpointSourceOptions {
  node: AztecNode;
  epochDuration: number;
  fromBlock: BlockNumber;
  pollingIntervalMS: number;
  log?: Logger;
}

export interface CheckpointHandlers {
  /** Called when a checkpoint is added, with the epoch's canonical prefix: every checkpoint from
   *  the epoch's first up to (and including) the one just checkpointed. */
  onEpochCheckpoints(epoch: EpochNumber, checkpoints: Checkpoint[]): void | Promise<void>;
  onChainPruned(blockNumber: BlockNumber): void | Promise<void>;
}

export class CheckpointSource implements L2BlockStreamEventHandler {
  private blockStream?: L2BlockStream;
  private readonly eventQueue = new SerialQueue();
  private tipsStore?: L2TipsMemoryStore;
  private handlers?: CheckpointHandlers;
  private readonly log: Logger;

  constructor(private readonly options: CheckpointSourceOptions) {
    this.log = options.log ?? createLogger('atlatl:checkpoint-source');
  }

  async start(handlers: CheckpointHandlers): Promise<void> {
    this.handlers = handlers;
    this.tipsStore = new L2TipsMemoryStore(await getInitialBlockHash(this.options.node));
    this.blockStream = new L2BlockStream(
      blockStreamSourceFromAztecNode(this.options.node),
      this.tipsStore,
      this,
      this.log,
      {
        pollIntervalMS: this.options.pollingIntervalMS,
        startingBlock: this.options.fromBlock,
        skipFinalized: true,
      },
    );
    this.eventQueue.start();
    this.blockStream.start();
  }

  async stop(): Promise<void> {
    await this.blockStream?.stop();
    await this.eventQueue.end();
    this.handlers = undefined;
  }

  handleBlockStreamEvent(event: L2BlockStreamEvent): Promise<void> {
    return this.eventQueue.put(() => this.handle(event));
  }

  private async handle(event: L2BlockStreamEvent): Promise<void> {
    await this.tipsStore!.handleBlockStreamEvent(event);

    switch (event.type) {
      case 'chain-checkpointed': {
        // The event carries only the checkpoint id; fetch the header to locate its epoch.
        const response = await this.options.node.getCheckpoint(event.checkpoint.number);
        if (!response) {
          this.log.warn(`Checkpoint ${event.checkpoint.number} not found on node (reorg?); skipping event`);
          break;
        }
        const epoch = getEpochAtSlot(response.header.slotNumber, { epochDuration: this.options.epochDuration });
        const checkpoints = await this.getEpochPrefix(epoch, response.number);
        await this.handlers!.onEpochCheckpoints(epoch, checkpoints);
        break;
      }
      case 'chain-pruned':
        await this.handlers!.onChainPruned(event.block.number);
        break;
    }
  }

  /** The epoch's canonical checkpoint prefix from its first checkpoint up to (and including) `latest`. Caps at
   *  the epoch's own checkpoints, so a `latest` beyond the epoch boundary is safe. */
  async getEpochPrefix(epoch: EpochNumber, latest: CheckpointNumber): Promise<Checkpoint[]> {
    const inRange = (await this.options.node.getCheckpointsData({ epoch })).filter(
      data => data.checkpointNumber <= latest,
    );
    if (inRange.length === 0) {
      return [];
    }
    return getFullCheckpoints(this.options.node, inRange[0].checkpointNumber, inRange.length);
  }
}
