import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { AztecNode } from '@aztec/aztec.js/node';
import type { ViemPublicClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';
import { type Logger, createLogger } from '@aztec/foundation/log';
import { RunningPromise } from '@aztec/foundation/running-promise';

import type { SanctionsList } from '@oxide/watcher-lib/sanctions';

import type { L1OperationsSubmissionConfig } from '../cli/config.js';
import type { L1SubmissionBatcher } from '../l1_submission_batcher.js';
import type { ChainlinkPriceOracle } from '../price_oracle/chainlink_price_oracle.js';
import type { RelayerL1TxUtils } from '../relayer_l1_tx_utils.js';
import type { RelayerTelemetry } from '../relayer_telemetry.js';
import type { StateStore } from '../state/types.js';
import { BalanceWatcher, OutboxWatcher } from './l1_operation_condition.js';
import { L1OperationScreener } from './l1_operation_screener.js';
import { L1OperationSyncer } from './l1_operation_syncer.js';
import { PredicateScreener, type PredicateScreenerConfig } from './predicate_screener.js';
import { L1OperationSubmitter } from './submitter.js';
import type { WithdrawalCompletion } from './withdrawal_completion.js';

export const DEFAULT_L1_OPERATIONS_POLL_INTERVAL_MS = 10_000;

/** Blocks per `eth_getLogs` call of the balance watcher's transfer scan. */
export const DEFAULT_LOG_SCAN_WINDOW = 1_000n;

export interface L1OperationRelayerConfig {
  node: AztecNode;
  publicClient: ViemPublicClient;
  store: StateStore;
  broadcaster: AztecAddress;
  payoutToken: EthAddress;
  supportedTokens: EthAddress[];
  logScanWindow?: bigint;
  /**
   * Submission policy; `executor`, `l1TxUtils`, and `sanctionsList` are required alongside it. Undefined runs
   * sync-only: operations are still discovered and persisted (the payload window is short-lived) but never executed.
   */
  l1OperationsSubmission?: L1OperationsSubmissionConfig;
  allowUnprofitable?: boolean;
  /** OperationExecutor that operations submit through; the env registry's published executor for the version. */
  executor?: EthAddress;
  l1TxUtils?: RelayerL1TxUtils;
  /** The list every address an operation touches is screened against before it is executed. */
  sanctionsList?: SanctionsList;
  /** When set, addresses the Predicate policy declines also block the operation. */
  predicate?: PredicateScreenerConfig;
  l1SubmissionBatcher?: L1SubmissionBatcher;
  withdrawalCompletion: WithdrawalCompletion;
  priceOracle: ChainlinkPriceOracle;
  telemetry?: RelayerTelemetry;
  pollIntervalMs?: number;
  logger?: Logger;
}

/**
 * Syncs broadcast L1 operations from L2 public logs and executes the profitable ones through the OperationExecutor.
 */
export class L1OperationRelayer {
  private readonly runningPromise: RunningPromise;

  private constructor(
    private readonly syncer: L1OperationSyncer,
    /** Undefined runs sync-only: operations are discovered but never executed. */
    private readonly submitter: L1OperationSubmitter | undefined,
    private readonly telemetry: RelayerTelemetry | undefined,
    private readonly log: Logger,
    pollIntervalMs: number,
  ) {
    this.runningPromise = new RunningPromise(() => this.runOnce(), this.log, pollIntervalMs);
    this.telemetry?.watcherStarted('l1_operation_broadcaster');
    this.telemetry?.watcherStarted('l1_operation_transfer_discovery');
  }

  static create(config: L1OperationRelayerConfig): L1OperationRelayer {
    const log = config.logger ?? createLogger('oxide-relayer:l1-operation-relayer');

    const syncer = new L1OperationSyncer({
      node: config.node,
      store: config.store,
      broadcaster: config.broadcaster,
      payoutToken: config.payoutToken,
      supportedTokens: config.supportedTokens,
      balanceWatcher: new BalanceWatcher({
        publicClient: config.publicClient,
        store: config.store,
        tokens: config.supportedTokens,
        logWindow: config.logScanWindow ?? DEFAULT_LOG_SCAN_WINDOW,
        logger: log.createChild('l1-operation-balance-watcher'),
      }),
      outboxWatcher: new OutboxWatcher({
        completion: config.withdrawalCompletion,
        store: config.store,
        telemetry: config.telemetry,
        logger: log.createChild('l1-operation-outbox-watcher'),
      }),
      telemetry: config.telemetry,
      logger: log.createChild('l1-operation-syncer'),
    });

    let submitter: L1OperationSubmitter | undefined;
    if (config.l1OperationsSubmission) {
      if (!config.l1TxUtils || !config.executor) {
        throw new Error('L1 operation submission requires l1TxUtils and an executor');
      }
      if (!config.sanctionsList) {
        throw new Error('L1 operation submission requires a sanctions list');
      }
      submitter = new L1OperationSubmitter({
        executor: config.executor,
        l1TxUtils: config.l1TxUtils,
        l1SubmissionBatcher: config.l1SubmissionBatcher,
        store: config.store,
        priceOracle: config.priceOracle,
        screener: new L1OperationScreener(
          config.sanctionsList,
          config.predicate ? new PredicateScreener(config.predicate) : undefined,
        ),
        config: config.l1OperationsSubmission,
        withdrawalCompletion: config.withdrawalCompletion,
        allowUnprofitable: config.allowUnprofitable,
        telemetry: config.telemetry,
        logger: log.createChild('l1-operation-submitter'),
      });
    }

    const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_L1_OPERATIONS_POLL_INTERVAL_MS;
    return new L1OperationRelayer(syncer, submitter, config.telemetry, log, pollIntervalMs);
  }

  public start(): void {
    if (!this.runningPromise.isRunning()) {
      this.log.info(`Starting L1 operation relayer${this.submitter ? '' : ' (read-only)'}`);
      this.runningPromise.start();
    }
  }

  public async stop(): Promise<void> {
    if (this.runningPromise.isRunning()) {
      this.log.verbose(`Stopping L1 operation relayer`);
      await this.runningPromise.stop();
      this.log.info(`Stopped L1 operation relayer`);
    }
  }

  public isRunning(): boolean {
    return this.runningPromise.isRunning();
  }

  /** Run one full poll cycle. Exposed for deterministic e2e tests and operator smoke checks. */
  public async runOnce(): Promise<void> {
    const { discovered, markedPending } = await this.syncer.runOnce();
    this.telemetry?.watcherPolled('l1_operation_broadcaster');
    this.telemetry?.watcherPolled('l1_operation_transfer_discovery');
    const summary = await this.submitter?.runOnce();
    const activity =
      discovered > 0 ||
      markedPending > 0 ||
      (summary !== undefined &&
        (summary.submitted > 0 ||
          summary.confirmed > 0 ||
          summary.deferredChanged > 0 ||
          summary.dropped > 0 ||
          summary.blocked > 0));
    if (activity) {
      this.log.info('L1 operation poll cycle finished', {
        event: 'l1_operation_poll_cycle',
        discovered,
        markedPending,
        readOnly: summary === undefined,
        submitted: summary?.submitted ?? 0,
        confirmed: summary?.confirmed ?? 0,
        deferred: summary?.deferred ?? 0,
        dropped: summary?.dropped ?? 0,
        blocked: summary?.blocked ?? 0,
      });
    }
  }
}
