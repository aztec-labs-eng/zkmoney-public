import { RollupContract } from '@aztec/ethereum/contracts';
import { ViemClient } from '@aztec/ethereum/types';
import { BlockNumber, CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { TimeoutError } from '@aztec/foundation/error';
import { type Logger, createLogger } from '@aztec/foundation/log';
import { retryUntil } from '@aztec/foundation/retry';
import { sleep } from '@aztec/foundation/sleep';
import { Checkpoint } from '@aztec/stdlib/checkpoint';
import { AztecNode, EpochProvingJobTerminalState, ProverNodeApi } from '@aztec/stdlib/interfaces/server';

import { CheckpointSource } from './checkpoint_source.js';
import * as config from './config.js';
import { PartialProofPolicy } from './types.js';

/** Poll/timeout/delay durations (ms). Defaults come from `config`; overridable to keep tests fast. */
export interface PartialEpochProofStarterTimings {
  settleDelayMs: number;
  completionPollIntervalMs: number;
  completionTimeoutMs: number;
}

export interface PartialEpochProofStarterCreateOptions {
  node: AztecNode;
  l1Client: ViemClient;
  partialProofPolicy: PartialProofPolicy;
  proverNode: ProverNodeApi;
  /** Block to begin syncing from. Defaults to the latest proven block. */
  fromBlock?: BlockNumber;
  pollingIntervalMS?: number;
  timings?: Partial<PartialEpochProofStarterTimings>;
  onError?: (error: unknown) => void | Promise<void>;
  log?: Logger;
}

export interface PartialEpochProofStarterOptions extends Omit<PartialEpochProofStarterCreateOptions, 'l1Client'> {
  epochDuration: number;
  fromBlock: BlockNumber;
}

export class PartialEpochProofStarter {
  private readonly source: CheckpointSource;
  private readonly log: Logger;
  private readonly timings: PartialEpochProofStarterTimings;

  // Latest checkpoint event awaiting evaluation. Overwritten by each new event so a long-running
  // proof never builds a backlog of stale prefixes — only the newest prefix is ever evaluated.
  private pending?: { epoch: EpochNumber; checkpoints: Checkpoint[] };
  // The single in-flight evaluation worker, if any.
  private worker?: Promise<void>;
  // Bumped on reorg / stop to cancel any in-flight wait and abandon the current evaluation.
  private generation = 0;
  // Checkpoint the policy has decided through for the epoch; prefixes at or below it are skipped. The
  // tip-extension re-price runs ahead of the block-stream events, which later redeliver the same
  // checkpoints. Reset on reorg.
  private evaluated?: { epoch: EpochNumber; checkpoint: CheckpointNumber };
  private stopped = false;

  constructor(private readonly options: PartialEpochProofStarterOptions) {
    this.log = options.log ?? createLogger('atlatl:partial-epoch-proof-starter');

    this.timings = {
      settleDelayMs: config.PROVER_NODE_SYNC__SETTLE_DELAY_MS,
      completionPollIntervalMs: config.PROOF_COMPLETION__POLL_INTERVAL_MS,
      completionTimeoutMs: config.PROOF_COMPLETION__TIMEOUT_MS,
      ...options.timings,
    };

    this.source = new CheckpointSource({
      node: options.node,
      epochDuration: options.epochDuration,
      fromBlock: options.fromBlock,
      pollingIntervalMS: options.pollingIntervalMS ?? config.CHECKPOINT_SOURCE__POLLING_INTERVAL_MS,
      log: this.log,
    });
  }

  static async create(options: PartialEpochProofStarterCreateOptions): Promise<PartialEpochProofStarter> {
    const { l1ContractAddresses } = await options.node.getNodeInfo();
    const rollup = new RollupContract(options.l1Client, l1ContractAddresses.rollupAddress.toString());
    const [epochDuration, fromBlock] = await Promise.all([
      rollup.getEpochDuration(),
      options.fromBlock ? Promise.resolve(options.fromBlock) : options.node.getBlockNumber('proven'),
    ]);

    return new PartialEpochProofStarter({ ...options, epochDuration, fromBlock });
  }

  start(): Promise<void> {
    return this.source.start({
      onEpochCheckpoints: (epoch, checkpoints) => this.onEpochCheckpoints(epoch, checkpoints),
      onChainPruned: blockNumber => this.onChainPruned(blockNumber),
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1; // cancels any in-flight wait
    this.pending = undefined;
    await this.source.stop();
    await this.worker;
  }

  private onEpochCheckpoints(epoch: EpochNumber, checkpoints: Checkpoint[]): void {
    // Record the latest prefix (overwrites any not-yet-evaluated one).
    this.pending = { epoch, checkpoints };

    // Start the worker if not already running.
    if (!this.worker) {
      this.worker = this.runWorker().finally(() => {
        this.worker = undefined;
      });
    }
  }

  private async runWorker(): Promise<void> {
    while (this.pending && !this.stopped) {
      // Process the latest available prefix.
      const { epoch, checkpoints } = this.pending;
      this.pending = undefined;
      await this.evaluateAndSubmit(epoch, checkpoints, this.generation);
    }
  }

  private async evaluateAndSubmit(epoch: EpochNumber, checkpoints: Checkpoint[], generation: number): Promise<void> {
    if (checkpoints.length === 0) {
      return;
    }

    const lastCheckpoint = checkpoints[checkpoints.length - 1].number;
    if (this.evaluated?.epoch === epoch && lastCheckpoint <= this.evaluated.checkpoint) {
      this.log.debug(`Epoch ${epoch} prefix through checkpoint ${lastCheckpoint} already evaluated, skipping`);
      return;
    }

    let prefix = checkpoints;
    try {
      // `startProof` proves whatever the prover node has synced, and its sync state is not observable over
      // RPC. Price the delivered prefix, then keep extending to this node's archiver tip and re-pricing until
      // the tip is stable, so only the window between the last read and `startProof` remains unpriced. Since
      // we can't control the prover node's proving range, the best we can do is minimize this window.
      while (true) {
        const decision = await this.options.partialProofPolicy.shouldSubmit({ epoch, checkpoints: prefix });
        this.log.debug(
          `Epoch ${epoch} prefix of ${prefix.length} checkpoint(s): ` +
            `${decision.submit ? 'submit' : 'wait'}${decision.reason ? ` (${decision.reason})` : ''}`,
        );
        if (!this.isCurrent(generation)) {
          return;
        }
        this.evaluated = { epoch, checkpoint: prefix[prefix.length - 1].number };
        if (!decision.submit) {
          return;
        }

        // Grace period for the prover node's CheckpointStore, which is populated behind the archiver by a
        // catch-up loop. Without this wait, `startProof` might snapshot a shorter prefix than priced. Sleeping
        // before the tip read keeps the final read adjacent to `startProof`.
        await sleep(this.timings.settleDelayMs);

        const tip = (await this.options.node.getChainTips()).checkpointed.checkpoint.number;
        if (tip <= prefix[prefix.length - 1].number) {
          break;
        }
        const extended = await this.source.getEpochPrefix(epoch, tip);
        if (extended.length <= prefix.length) {
          // The advance is past the epoch's end; the whole epoch prefix is already priced.
          break;
        }
        prefix = extended;
      }
    } catch (error) {
      this.log.error(`Error evaluating prefix for epoch ${epoch}: ${error}`);
      await this.options.onError?.(error);
      return;
    }

    if (!this.isCurrent(generation)) {
      return;
    }

    try {
      const jobId = await this.options.proverNode.startProof(epoch);
      this.log.info(`Started partial proof job ${jobId} for epoch ${epoch} (${prefix.length} checkpoint(s))`);

      // `getJobs` lists only live sessions: a job reaching a terminal state is pruned on the prover
      // node's next reconcile, which a successful proof triggers by advancing the proven tip. So the
      // completion signal is the started job either reporting a terminal status or vanishing — both mean
      // it is no longer in progress, freeing the worker to re-evaluate newer tipped withdrawals. Since
      // `startProof` returns only after the session exists, a subsequent absence can only be terminal-
      // then-pruned, never not-yet-created. `waitUntil` also returns early on reorg/stop.
      const finished = await this.waitUntil(
        async () => {
          const job = (await this.options.proverNode.getJobs()).find(j => j.uuid === jobId);
          return job === undefined || EpochProvingJobTerminalState.includes(job.status);
        },
        generation,
        this.timings.completionPollIntervalMs,
        this.timings.completionTimeoutMs,
        `partial proof job ${jobId} to finish`,
      );
      if (finished) {
        this.log.info(`Partial proof job ${jobId} for epoch ${epoch} no longer in progress`);
      } else if (this.isCurrent(generation)) {
        this.log.warn(`Timed out waiting for partial proof job ${jobId} for epoch ${epoch} to finish`);
      }
    } catch (error) {
      this.log.error(`Error starting partial proof for epoch ${epoch}: ${error}`);
      await this.options.onError?.(error);
    }
  }

  /** Whether this evaluation is still the current one (not superseded by a reorg, not stopped). */
  private isCurrent(generation: number): boolean {
    return !this.stopped && this.generation === generation;
  }

  /** Poll `check` every `intervalMs` until it is true. Returns false if the evaluation stops being current or
   *  the timeout elapses first. */
  private async waitUntil(
    check: () => Promise<boolean>,
    generation: number,
    intervalMs: number,
    timeoutMs: number,
    name: string,
  ): Promise<boolean> {
    try {
      const { ready } = await retryUntil(
        async () => {
          if (!this.isCurrent(generation)) {
            return { ready: false };
          }
          return (await check()) ? { ready: true } : undefined;
        },
        name,
        timeoutMs / 1000,
        intervalMs / 1000,
      );
      return ready;
    } catch (error) {
      if (error instanceof TimeoutError) {
        return false;
      }
      throw error;
    }
  }

  /** Handle a reorg immediately - not behind the worker's (possibly long) proof wait. */
  private async onChainPruned(blockNumber: BlockNumber): Promise<void> {
    this.log.debug(`Chain pruned to block ${blockNumber}`);
    // Cancels the in-flight evaluation.
    this.generation += 1;
    // Drops the now-stale pending prefix and evaluation watermark.
    this.pending = undefined;
    this.evaluated = undefined;
    try {
      await this.options.partialProofPolicy.handleReorg?.();
    } catch (error) {
      this.log.error(`Error handling reorg: ${error}`);
      await this.options.onError?.(error);
    }
  }
}
