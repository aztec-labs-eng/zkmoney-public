import { RollupContract } from '@aztec/ethereum/contracts/rollup';
import { Fr } from '@aztec/foundation/curves/bn254';
import { EthAddress } from '@aztec/foundation/eth-address';
import { Logger, createLogger } from '@aztec/foundation/log';
import { AztecNode } from '@aztec/stdlib/interfaces/server';

import { OxidePortalContract } from '@oxide/l1-contracts/oxide_portal.js';

import type { PublicClient } from 'viem';

import type { L1TxQueue } from '../../l1/l1_tx_queue.js';
import { ChainlinkPriceOracle } from '../../price_oracle/chainlink_price_oracle.js';
import { ProverClaimDiscoverer, ProverClaimPortalConfig } from '../prover_claim_lib/index.js';
import { Binding } from '../types.js';
import { BatchPublisher } from './batch_publisher.js';
import * as config from './config.js';
import { FirstProverTracker, FirstProverTrackerOptions } from './first_prover_tracker.js';
import {
  ProfitableClaimBatchSubmitter,
  ProfitableClaimBatchSubmitterOptions,
} from './profitable_claim_batch_submitter.js';
import { ProverClaimBacklog } from './prover_claim_backlog.js';
import { ProverClaimIngester } from './prover_claim_ingester.js';
import { resolveStartBlock } from './start_block_resolver.js';

export type TrackerOptions = Pick<
  FirstProverTrackerOptions,
  'confirmations' | 'maxBlockRange' | 'pollIntervalMs' | 'fromBlock'
>;
export type ClaimBatchSubmitterOptions = Partial<Pick<ProfitableClaimBatchSubmitterOptions, 'intervalMs'>>;

export interface ProverClaimRewardCollectorCreateOptions {
  proverId: EthAddress;
  portal: OxidePortalContract;
  rollup: RollupContract;
  client: PublicClient;
  /**
   * Queue to submit through. The host shares one signer across subsystems, so every send goes on the one
   * queue and nonces cannot race. Its sender must be `proverId`.
   */
  l1TxQueue: Pick<L1TxQueue, 'enqueue' | 'address' | 'maxFeePerGasCap'>;
  node: AztecNode;
  portals: ProverClaimPortalConfig[];
  priceOracle: ChainlinkPriceOracle;
  /** Minimum batch profit in the oracle's common quote currency.
   *  Defaults to PROVER_CLAIM__MIN_BATCH_PROFIT. */
  minBatchProfit?: bigint;
  trackerOptions?: Partial<TrackerOptions>;
  claimBatchSubmitterOptions?: ClaimBatchSubmitterOptions;
  log?: Logger;
}

export interface ProverClaimRewardCollectorOptions extends ProverClaimRewardCollectorCreateOptions {
  binding: Binding;
  /** `epochDuration * (proofSubmissionEpochs + 1) + 1`: the rollup's checkpoint-log window. */
  roundaboutSize: number;
}

/**
 * Collects prover claim rewards for `proverId`: it finds the prover's first-prover captures on L1, discovers the
 * claims behind each capture, and submits the profitable ones to the Portal in batches.
 *
 * The class is the composition root of that pipeline. It only builds the components and forwards `start`/`stop`;
 * at runtime the components drive each other: the tracker hands each captured range to the ingester, the ingester
 * fills the backlog, and the submitter drains the backlog into the publisher.
 */
export class ProverClaimRewardCollector {
  private readonly tracker: FirstProverTracker;
  private readonly ingester: ProverClaimIngester;
  private readonly submitter: ProfitableClaimBatchSubmitter;
  private readonly backlog: ProverClaimBacklog;
  private readonly publisher: BatchPublisher;
  private readonly log: Logger;

  constructor(options: ProverClaimRewardCollectorOptions) {
    this.log = options.log ?? createLogger('atlatl:prover-claim-collector');

    const discoverer = new ProverClaimDiscoverer({ binding: options.binding, portals: options.portals, log: this.log });

    this.publisher = new BatchPublisher({
      portal: options.portal,
      client: options.client,
      l1TxQueue: options.l1TxQueue,
      confirmations: options.trackerOptions?.confirmations ?? config.FIRST_PROVER_TRACKER__MIN_CONFIRMATIONS,
      log: this.log,
    });

    this.backlog = new ProverClaimBacklog();

    this.ingester = new ProverClaimIngester({
      discoverer,
      backlog: this.backlog,
      roundaboutSize: options.roundaboutSize,
      log: this.log,
    });

    this.submitter = new ProfitableClaimBatchSubmitter({
      intervalMs: config.PROVER_CLAIM__BATCH_SUBMITTER_POLL_INTERVAL_MS,
      ...options.claimBatchSubmitterOptions,
      portal: options.portal,
      rollup: options.rollup,
      portals: options.portals,
      backlog: this.backlog,
      priceOracle: options.priceOracle,
      getFeeValues: () => options.client.estimateFeesPerGas(),
      maxFeePerGasCap: options.l1TxQueue.maxFeePerGasCap,
      publisher: this.publisher,
      senderAddress: EthAddress.fromString(options.l1TxQueue.address),
      minBatchProfit: options.minBatchProfit ?? config.PROVER_CLAIM__MIN_BATCH_PROFIT,
      onError: error => this.log.error(`Prover claim batch submitter error: ${error}`),
      log: this.log,
    });

    this.tracker = new FirstProverTracker({
      fromBlock: 0n,
      confirmations: config.FIRST_PROVER_TRACKER__MIN_CONFIRMATIONS,
      maxBlockRange: config.FIRST_PROVER_TRACKER__MAX_BLOCK_RANGE,
      pollIntervalMs: config.FIRST_PROVER_TRACKER__POLL_INTERVAL_MS,
      ...options.trackerOptions,
      proverId: options.proverId,
      portal: options.portal,
      rollup: options.rollup,
      node: options.node,
      roundaboutSize: options.roundaboutSize,
      log: this.log,
    });
  }

  static async create(options: ProverClaimRewardCollectorCreateOptions): Promise<ProverClaimRewardCollector> {
    const l1Client = options.client;

    const sender = EthAddress.fromString(options.l1TxQueue.address);
    if (!sender.equals(options.proverId)) {
      throw new Error(
        `Prover claim collector must sign with the prover's key: sender is ${sender}, proverId is ${options.proverId}`,
      );
    }

    const rollup = options.rollup;
    const [rollupVersion, chainId, epochDuration, proofSubmissionEpochs, { ethereumSlotDuration }] = await Promise.all([
      rollup.getVersion(),
      l1Client.getChainId(),
      rollup.getEpochDuration(),
      rollup.getProofSubmissionEpochs(),
      options.node.getL1Constants(),
    ]);
    const binding = {
      rollupVersion: new Fr(rollupVersion),
      chainId: new Fr(chainId),
      epochDuration,
    };
    // Mirrors `STFLib.roundaboutSize()`: the rollup keeps a checkpoint's log while
    // `pending < checkpointNumber + roundaboutSize`, and every claim reads one.
    const roundaboutSize = epochDuration * (proofSubmissionEpochs + 1) + 1;

    const trackerFromBlock =
      options.trackerOptions?.fromBlock ??
      (await resolveStartBlock({
        client: l1Client,
        rollup,
        roundaboutSize,
        ethereumSlotDuration,
        maxBlockRange: options.trackerOptions?.maxBlockRange ?? config.FIRST_PROVER_TRACKER__MAX_BLOCK_RANGE,
        log: options.log,
      }));
    const trackerOptions = {
      ...options.trackerOptions,
      fromBlock: trackerFromBlock,
    };

    return new ProverClaimRewardCollector({
      ...options,
      binding,
      trackerOptions,
      roundaboutSize,
    });
  }

  async start(): Promise<void> {
    this.log.info('Starting prover claim collector');
    // Downstream components start first, so the tracker never emits a range with nothing to receive it.
    this.publisher.start();
    this.submitter.start();
    await this.tracker.start({
      onRange: range => this.ingester.onRange(range),
    });
  }

  async stop(): Promise<void> {
    // Reverse order: silence the source first, then drain the components behind it.
    await this.tracker.stop();
    await this.submitter.stop();
    await this.publisher.stop();
  }
}
