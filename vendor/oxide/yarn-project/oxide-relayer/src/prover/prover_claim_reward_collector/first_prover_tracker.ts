import { RollupContract } from '@aztec-labs/ethereum/contracts/rollup';
import { maxBigint, minBigint } from '@aztec-labs/foundation/bigint';
import { CheckpointNumber, EpochNumber } from '@aztec-labs/foundation/branded-types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Logger, createLogger } from '@aztec-labs/foundation/log';
import { SerialQueue } from '@aztec-labs/foundation/queue';
import { RunningPromise } from '@aztec-labs/foundation/running-promise';
import { Checkpoint } from '@aztec-labs/stdlib/checkpoint';
import { AztecNode } from '@aztec-labs/stdlib/interfaces/server';

import { getFullCheckpoints } from '../node_block_stream_source.js';

export interface CapturedRange {
  epoch: EpochNumber;
  rangeStartCheckpoint: CheckpointNumber;
  // The proven prefix `[epochStart, captured]`. Its length is the sub-epoch proof length, and the
  // subset at or above `rangeStartCheckpoint` is the prover's newly-claimable checkpoints.
  epochCheckpoints: Checkpoint[];
}

export interface FirstProverHandlers {
  /** Accept a captured range. Resolves once the range is taken, not once its claims are done with. */
  onRange(range: CapturedRange): Promise<void>;
}

export interface FirstProverTrackerOptions {
  proverId: EthAddress;
  rollup: RollupContract;
  node: AztecNode;
  /**
   * First L1 block to scan L2ProofVerified events from. It must be at or below the capture floor (see
   * `resolveStartBlock`): the tracker does not look below it for the capture that sets a range's start.
   */
  fromBlock: bigint;
  /** Only act on events buried at least this many L1 blocks, so shallow reorgs never reach us. */
  confirmations: bigint;
  /** Max L1 blocks scanned per poll; while more than this remain, polls run back-to-back to catch up. */
  maxBlockRange: bigint;
  /** Wait between polls once caught up to the confirmed head. */
  pollIntervalMs: number;
  /** Size of the rollup's circular checkpoint-log buffer. */
  roundaboutSize: number;
  log?: Logger;
}

export class FirstProverTracker {
  private readonly log: Logger;
  private readonly runner: RunningPromise;
  private readonly queue = new SerialQueue();
  // The last processed L1 block number.
  private cursor: bigint;
  // Highest captured checkpoint by any prover seen so far.
  private highestCaptured = CheckpointNumber(0);
  private handlers?: FirstProverHandlers;
  private stopped = false;

  constructor(private readonly options: FirstProverTrackerOptions) {
    this.log = options.log ?? createLogger('atlatl:first-prover-tracker');
    this.cursor = options.fromBlock - 1n;
    this.runner = new RunningPromise(() => this.poll(), this.log, options.pollIntervalMs);
  }

  async start(handlers: FirstProverHandlers): Promise<void> {
    if (this.handlers) {
      throw new Error('FirstProverTracker already started');
    }
    this.handlers = handlers;

    // Clamp the cursor to the confirmed head so the scan does not touch blocks a shallow reorg can still change.
    const head = await this.options.rollup.client.getBlockNumber();
    this.cursor = minBigint(this.cursor, maxBigint(head - this.options.confirmations, -1n));

    // Begin emitting ranges. The first poll runs immediately.
    this.queue.start();
    this.runner.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.runner.stop();
    await this.queue.cancel();
  }

  private async poll(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const head = await this.options.rollup.client.getBlockNumber();
    const safeHead = head - this.options.confirmations;
    if (safeHead <= this.cursor) {
      return;
    }

    // Scan at most `maxBlockRange` per poll.
    const toBlock = minBigint(this.cursor + this.options.maxBlockRange, safeHead);

    const logs = await this.options.rollup
      .getContract()
      .getEvents.L2ProofVerified({}, { fromBlock: this.cursor + 1n, toBlock });
    this.processEvents(
      logs.map(log => ({
        checkpointNumber: CheckpointNumber.fromBigInt(log.args.checkpointNumber!),
        prover: EthAddress.fromString(log.args.proverId!),
      })),
    );
    this.cursor = toBlock;

    // If the confirmed head is still ahead we re-run immediately to catch up.
    if (toBlock < safeHead) {
      void this.runner.trigger();
    }
  }

  private processEvents(events: { checkpointNumber: CheckpointNumber; prover: EthAddress }[]): void {
    // The rollup records a first prover only for a proof that moves the proven tip. A proof whose end is not
    // above the highest checkpoint seen so far re-proved a proven range, so it captured nothing.
    for (const { checkpointNumber, prover } of events) {
      if (checkpointNumber <= this.highestCaptured) {
        continue;
      }
      if (prover.equals(this.options.proverId)) {
        // Each range's boundary is the previous capture by any prover.
        this.enqueueRange(checkpointNumber, this.highestCaptured);
      }
      this.highestCaptured = checkpointNumber;
    }
  }

  private enqueueRange(captured: CheckpointNumber, lastCaptured: CheckpointNumber): void {
    this.queue
      .put(() => this.emitRange(captured, lastCaptured))
      .catch(error => {
        this.log.error(`Failed to process captured range ${captured}: ${error}`);
        // Halt so no later range is emitted past a failed one; a restart replays the whole claimable window.
        void this.stop();
      });
  }

  private async emitRange(captured: CheckpointNumber, lastCaptured: CheckpointNumber): Promise<void> {
    if (this.stopped) {
      return;
    }

    // The rollup keeps a checkpoint's log only while `pending < checkpoint + roundaboutSize`. Past that the
    // epoch lookup below reverts, and so would every claim in this range. Skip it instead of halting: a capture
    // that can never be read again must not block the captures behind it.
    if (await this.#isCheckpointLogOverwritten(captured)) {
      this.log.error(
        `Skipping capture at checkpoint ${captured}: the rollup has overwritten its checkpoint log, so the ` +
          `prover tips in this range can no longer be claimed`,
      );
      return;
    }

    let epoch: EpochNumber;
    try {
      epoch = await this.options.rollup.getEpochNumberForCheckpoint(captured);
    } catch (error) {
      // The pending tip can cross the overwrite boundary between the check above and this call. Re-check, so
      // that race skips the range rather than halting the tracker.
      if (await this.#isCheckpointLogOverwritten(captured)) {
        this.log.error(`Skipping capture at checkpoint ${captured}: its checkpoint log was overwritten mid-read`);
        return;
      }
      throw error;
    }
    const prefix = (await this.options.node.getCheckpointsData({ epoch })).filter(
      data => data.checkpointNumber <= captured,
    );
    // The capture is on-chain, so the proven prefix must exist. Missing or short data means the node lags L1;
    // throw so the queue halts and a restart retries the range, never skipping a capture.
    if (prefix.length === 0 || prefix[prefix.length - 1].checkpointNumber !== captured) {
      throw new Error(`Node has no checkpoint data for epoch ${epoch} up to ${captured}; retry once it catches up`);
    }
    const epochStart = prefix[0].checkpointNumber;
    const epochCheckpoints = await getFullCheckpoints(this.options.node, epochStart, prefix.length);
    if (epochCheckpoints[epochCheckpoints.length - 1]?.number !== captured) {
      throw new Error(`Published checkpoints for epoch ${epoch} do not reach ${captured}; retry once node catches up`);
    }

    const rangeStartCheckpoint = CheckpointNumber(lastCaptured >= epochStart ? lastCaptured + 1 : epochStart);

    const range: CapturedRange = { epoch, rangeStartCheckpoint, epochCheckpoints };
    this.log.info(`Captured ${epoch}:[${rangeStartCheckpoint}, ${captured}] for prover ${this.options.proverId}`);
    await this.handlers!.onRange(range);
  }

  /** True once the rollup's circular buffer has overwritten `checkpoint`'s log, making it unreadable. */
  async #isCheckpointLogOverwritten(checkpoint: CheckpointNumber): Promise<boolean> {
    const pending = await this.options.rollup.getCheckpointNumber();
    return pending >= checkpoint + this.options.roundaboutSize;
  }
}
