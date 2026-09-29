import type { EthAddress } from '@aztec/aztec.js/addresses';
import { type Logger, createLogger } from '@aztec/foundation/log';
import { DateProvider } from '@aztec/foundation/timer';

import { OperationExecutorAbi } from '@oxide/l1-contracts';
import { L1OperationConditionKind } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { type Hex, type Log, type TransactionReceipt, encodeFunctionData, maxUint256 } from 'viem';

import { CauseTransitions } from '../cause_transitions.js';
import type { L1OperationsSubmissionConfig } from '../cli/config.js';
import {
  type L1SubmissionBatchSender,
  type L1SubmissionBatcher,
  L1SubmissionType,
  enqueueL1Submission,
} from '../l1_submission_batcher.js';
import { EXECUTOR_MIN_PAYOUT_CALLDATA_GAS } from '../l1_utils.js';
import type { ChainlinkPriceOracle } from '../price_oracle/chainlink_price_oracle.js';
import type { RelayerL1TxUtils, SentL1Tx } from '../relayer_l1_tx_utils.js';
import type { RelayerDeferReason, RelayerTelemetry } from '../relayer_telemetry.js';
import type { PendingL1Operation, PendingL1OperationReason, StateStore } from '../state/types.js';
import type { L1OperationScreener } from './l1_operation_screener.js';
import type { WithdrawalCompletion } from './withdrawal_completion.js';

/**
 * The fee ceiling is 112.5% of the market fee.
 *
 * Against this fee we compute OperationExecutor's minPayout such that the relayer is break even. If minPayout is not
 * satisfied or maxFeePerGas is lower than inclusion-time gas price the tx is simply dropped and realyers will retry
 * this.
 */
const FEE_CEILING_BUMP = 1_125n;

export interface L1OperationSubmitterDeps {
  /** OperationExecutor deployment the relayer executes through. */
  executor: EthAddress;
  l1TxUtils: RelayerL1TxUtils;
  l1SubmissionBatcher?: L1SubmissionBatcher;
  store: StateStore;
  priceOracle: ChainlinkPriceOracle;
  screener: L1OperationScreener;
  config: L1OperationsSubmissionConfig;
  withdrawalCompletion: WithdrawalCompletion;
  allowUnprofitable?: boolean;
  telemetry?: RelayerTelemetry;
  logger?: Logger;
  /** Injectable clock for deterministic backoff in tests. */
  dateProvider?: DateProvider;
}

/** Per-poll outcome counts, mostly for tests and logging. */
export interface L1OperationRunSummary {
  confirmed: number;
  submitted: number;
  dropped: number;
  deferred: number;
  /** Deferrals whose cause differs from the one the operation was last deferred with. The cycle summary reads this. */
  deferredChanged: number;
  blocked: number;
}

/**
 * Polls due L1 operations, simulates each through the executor, and submits the profitable ones.
 *
 * `weiToUSD` returns 18-decimal USD, which is a payout amount because the syncer stores only operations that pay out
 * in the portal underlying, an 18-decimal USD stablecoin.
 */
export class L1OperationSubmitter {
  private readonly log: Logger;
  private readonly dateProvider: DateProvider;
  private readonly backgroundSummary: L1OperationRunSummary = {
    confirmed: 0,
    submitted: 0,
    dropped: 0,
    deferred: 0,
    deferredChanged: 0,
    blocked: 0,
  };
  /** The cause each operation was last deferred with, so a held cause logs once. */
  private readonly deferrals = new CauseTransitions();
  private retryNextBatch = false;

  constructor(private readonly deps: L1OperationSubmitterDeps) {
    this.log = deps.logger ?? createLogger('oxide-relayer:l1-operation-submitter');
    this.dateProvider = deps.dateProvider ?? new DateProvider();
  }

  async runOnce(): Promise<L1OperationRunSummary> {
    const retry = this.retryNextBatch;
    this.retryNextBatch = false;
    return await enqueueL1Submission(this.deps.l1SubmissionBatcher, this.deps.l1TxUtils, {
      kind: L1SubmissionType.L1Operation,
      retry,
      submit: sender => this.runBatch(sender),
    });
  }

  private async runBatch(sender: L1SubmissionBatchSender): Promise<L1OperationRunSummary> {
    const summary = this.drainBackgroundSummary();
    const due = await this.deps.store.listPendingL1Operations({ dueAt: this.now() });
    if (due.length === 0) {
      return summary;
    }

    this.log.debug('Processing due L1 operations', { event: 'l1_operation_poll', dueCount: due.length });
    for (const operation of due) {
      await this.processOperation(sender, operation, summary);
    }
    return summary;
  }

  private async processOperation(
    sender: L1SubmissionBatchSender,
    operation: PendingL1Operation,
    summary: L1OperationRunSummary,
  ): Promise<void> {
    let calldata: Hex;
    try {
      calldata = await this.resolveCalldata(operation);
    } catch (err) {
      this.log.warn('L1 operation calldata completion failed; deferring', {
        event: 'l1_operation_deferred',
        cause: 'completion_error',
        error: errMessage(err),
        ...operationLogFields(operation),
      });
      await this.defer(operation, 'completion_error', summary, { cause: 'completion_error' });
      return;
    }

    let simulation: Simulation;
    let gasPrice: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    try {
      const price = await this.deps.l1TxUtils.getGasPrice({ stallTimeMs: 0 });
      gasPrice = {
        maxFeePerGas: (price.maxFeePerGas * FEE_CEILING_BUMP) / 1_000n,
        maxPriorityFeePerGas: price.maxPriorityFeePerGas,
      };
      simulation = await this.simulateExecution(operation, calldata, gasPrice);
    } catch (err) {
      // A transport or provider error, not a revert: no attempt is charged, the same as a failed gas estimate.
      this.log.warn('L1 operation simulation failed; deferring', {
        event: 'l1_operation_deferred',
        cause: 'evaluation_error',
        error: errMessage(err),
        ...operationLogFields(operation),
      });
      await this.defer(operation, undefined, summary, { cause: 'evaluation_error' });
      return;
    }
    if (simulation.status === 'failure') {
      await this.handleSimulationFailure(operation, simulation.error, summary);
      return;
    }
    const { payout, logs } = simulation;

    let listed: EthAddress[];
    try {
      listed = await this.deps.screener.screen(operation, logs);
    } catch (err) {
      this.log.warn('L1 operation screening failed; deferring', {
        event: 'l1_operation_deferred',
        cause: 'screening_error',
        error: errMessage(err),
        ...operationLogFields(operation),
      });
      await this.defer(operation, 'screening_error', summary, { cause: 'screening_error' });
      return;
    }
    if (listed.length > 0) {
      await this.block(operation, listed, summary);
      return;
    }

    let gasLimit: bigint;
    let minPayout: bigint;
    try {
      // Require the quoted payout so an inner failure cannot produce a cheaper estimate.
      const sender = this.deps.l1TxUtils.getSenderAddress().toString();
      const estimatedGas = await this.deps.l1TxUtils.client.estimateGas({
        account: sender,
        to: this.deps.executor.toString(),
        data: this.executeCalldata(operation, calldata, payout),
        maxFeePerGas: gasPrice.maxFeePerGas,
        maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas,
        stateOverride: [{ address: sender, balance: maxUint256 }],
      });
      // The submitted minimum can have more non-zero bytes than the quoted payout.
      gasLimit = estimatedGas + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS;
      // The floor is the fee ceiling the tx carries, so execution can never run at a loss.
      minPayout = this.deps.allowUnprofitable
        ? 0n
        : await this.deps.priceOracle.weiToUSD(gasLimit * gasPrice.maxFeePerGas);
    } catch (err) {
      this.log.warn('L1 operation gas/minPayout evaluation failed; deferring', {
        event: 'l1_operation_deferred',
        cause: 'evaluation_error',
        error: errMessage(err),
        ...operationLogFields(operation),
      });
      await this.defer(operation, undefined, summary, { cause: 'evaluation_error' });
      return;
    }

    if (payout < minPayout) {
      const changed = await this.defer(operation, 'unprofitable', summary, { cause: 'unprofitable' });
      const write = changed ? this.log.info : this.log.debug;
      write.call(this.log, 'L1 operation deferred by minimum payout', {
        event: 'l1_operation_deferred',
        cause: 'unprofitable',
        payout: payout.toString(),
        minPayout: minPayout.toString(),
        ...operationLogFields(operation),
      });
      return;
    }

    await this.broadcast(
      sender,
      operation,
      this.executeCalldata(operation, calldata, minPayout),
      payout,
      gasLimit,
      gasPrice,
      summary,
    );
  }

  /** Settles the operation with the terminal status `blocked`; `listed` is why. */
  private async block(
    operation: PendingL1Operation,
    listed: EthAddress[],
    summary: L1OperationRunSummary,
  ): Promise<void> {
    await this.deps.store.setL1OperationStatus(operation.operationId, 'blocked');
    this.deferrals.forget(operation.operationId);
    summary.blocked++;
    this.deps.telemetry?.l1OperationOutcome('blocked');
    this.log.warn('L1 operation blocked by sanctions screening', {
      event: 'l1_operation_blocked',
      listed: listed.map(address => address.toString().toLowerCase()),
      ...operationLogFields(operation),
    });
  }

  private async broadcast(
    sender: L1SubmissionBatchSender,
    operation: PendingL1Operation,
    data: Hex,
    payout: bigint,
    gasLimit: bigint,
    gasPrice: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    summary: L1OperationRunSummary,
  ): Promise<void> {
    let sent: SentL1Tx;
    try {
      sent = await sender.sendTransactionWithGasPrice(
        { to: this.deps.executor.toString(), data },
        { gasLimit },
        gasPrice,
      );
    } catch (err) {
      this.log.warn('L1 operation broadcast failed; deferring', {
        event: 'l1_operation_deferred',
        cause: 'broadcast_failed',
        error: errMessage(err),
        ...operationLogFields(operation),
      });
      await this.defer(operation, undefined, summary, {
        cause: 'broadcast_failed',
        deferReason: 'broadcast_failed',
      });
      return;
    }
    const { txHash, state, settled } = sent;
    this.log.info('Submitted L1 operation', {
      event: 'l1_operation_submitted',
      txHash,
      nonce: state.nonce,
      payout: payout.toString(),
      gasLimit: gasLimit.toString(),
      ...operationLogFields(operation),
    });
    summary.submitted++;
    this.deps.telemetry?.l1OperationOutcome('submitted');

    const pendingMarker = Symbol('pending');
    let pending = false;
    try {
      pending = (await Promise.race([settled, Promise.resolve(pendingMarker)])) === pendingMarker;
    } catch {
      // An already rejected monitor is terminal and must be processed before this run returns.
    }
    const monitor = this.monitorBroadcast(sent, operation, pending ? this.backgroundSummary : summary);
    if (!pending) {
      await monitor;
    }
  }

  private async monitorBroadcast(
    sent: SentL1Tx,
    operation: PendingL1Operation,
    summary: L1OperationRunSummary,
  ): Promise<void> {
    const { txHash, state, settled } = sent;
    let receipt: TransactionReceipt;
    try {
      receipt = await settled;
    } catch (err) {
      // A dropped tx (private mempools drop reverting txs silently) or a monitor error: defer without charging
      // an attempt. If someone else executed the operation, the next simulation reverts and the retry budget drops it.
      this.log.warn('L1 operation tx finished without success; will re-evaluate', {
        event: 'l1_operation_tx_failed',
        txHash,
        nonce: state.nonce,
        error: errMessage(err),
        ...operationLogFields(operation),
      });
      // No receipt, so there is no gas to record here.
      this.deps.telemetry?.l1OperationOutcome('failed');
      this.retryNextBatch = true;
      await this.defer(operation, undefined, summary, { cause: 'tx_unsuccessful', countDeferred: false });
      return;
    }
    if (receipt.status !== 'success') {
      // A revert-protected relay drops a reverting tx; a public mempool (Sepolia, dev) mines it and charges the gas.
      this.log.warn('L1 operation tx reverted; will re-evaluate', {
        event: 'l1_operation_tx_failed',
        txHash,
        nonce: state.nonce,
        receiptStatus: receipt.status,
        ...operationLogFields(operation),
      });
      this.deps.telemetry?.gasSpentWei('l1_operation', receipt.gasUsed * receipt.effectiveGasPrice);
      this.deps.telemetry?.l1OperationOutcome('failed');
      await this.defer(operation, undefined, summary, { cause: 'tx_reverted', countDeferred: false });
      return;
    }

    await this.deps.store.setL1OperationStatus(operation.operationId, 'executed');
    this.deferrals.forget(operation.operationId);
    summary.confirmed++;
    this.deps.telemetry?.l1OperationOutcome('confirmed');
    this.deps.telemetry?.gasSpentWei('l1_operation', receipt.gasUsed * receipt.effectiveGasPrice);
    this.log.info('L1 operation executed on L1', {
      event: 'l1_operation_executed',
      txHash,
      nonce: state.nonce,
      ...operationLogFields(operation),
    });
  }

  private drainBackgroundSummary(): L1OperationRunSummary {
    const summary = { ...this.backgroundSummary };
    this.backgroundSummary.confirmed = 0;
    this.backgroundSummary.submitted = 0;
    this.backgroundSummary.dropped = 0;
    this.backgroundSummary.deferred = 0;
    this.backgroundSummary.deferredChanged = 0;
    this.backgroundSummary.blocked = 0;
    return summary;
  }

  /**
   * A reverting simulation usually means the operation was executed by someone else or was never valid; either way it
   * burns one attempt and the operation is dropped once the retry budget is spent.
   */
  private async handleSimulationFailure(
    operation: PendingL1Operation,
    err: unknown,
    summary: L1OperationRunSummary,
  ): Promise<void> {
    const attempts = operation.attempts + 1;
    if (attempts >= this.deps.config.maxRetries) {
      await this.deps.store.setL1OperationStatus(operation.operationId, 'dropped');
      this.deferrals.forget(operation.operationId);
      summary.dropped++;
      this.deps.telemetry?.l1OperationOutcome('dropped');
      this.log.warn('L1 operation dropped after exhausting simulation retries', {
        event: 'l1_operation_dropped',
        attempts,
        error: errMessage(err),
        ...operationLogFields(operation),
      });
      return;
    }
    this.log.info('L1 operation simulation reverted; deferring', {
      event: 'l1_operation_deferred',
      cause: 'simulation_reverted',
      attempts,
      error: errMessage(err),
      ...operationLogFields(operation),
    });
    await this.defer(operation, 'simulation_reverted', summary, {
      cause: 'simulation_reverted',
      incrementAttempts: true,
    });
  }

  /**
   * Simulates the payout and transfer logs with the submission fee settings and a zero minimum payout.
   */
  private async simulateExecution(
    operation: PendingL1Operation,
    calldata: Hex,
    gasPrice: GasPrice,
  ): Promise<Simulation> {
    const sender = this.deps.l1TxUtils.getSenderAddress().toString();
    const latestBlock = await this.deps.l1TxUtils.client.getBlock({ blockTag: 'latest' });
    const [block] = await this.deps.l1TxUtils.client.simulateBlocks({
      blockNumber: latestBlock.number,
      blocks: [
        {
          // Keep the base fee consistent with gas estimation.
          blockOverrides: { baseFeePerGas: latestBlock.baseFeePerGas ?? 0n },
          stateOverrides: [{ address: sender, balance: maxUint256 }],
          calls: [
            {
              to: this.deps.executor.toString(),
              abi: OperationExecutorAbi,
              functionName: 'execute',
              args: [operation.target.toString(), calldata, operation.payoutToken.toString(), 0n],
              from: sender,
              ...gasPrice,
            },
          ],
        },
      ],
      traceTransfers: true,
    });
    const [call] = block.calls;
    if (call.status === 'failure') {
      return { status: 'failure', error: call.error };
    }
    return { status: 'success', payout: call.result, logs: call.logs ?? [] };
  }

  private executeCalldata(operation: PendingL1Operation, calldata: Hex, minPayout: bigint): Hex {
    return encodeFunctionData({
      abi: OperationExecutorAbi,
      functionName: 'execute',
      args: [operation.target.toString(), calldata, operation.payoutToken.toString(), minPayout],
    });
  }

  /**
   * A `MessageInOutbox` broadcast carries `Pool.processWithdrawals` with an empty batch; every other condition
   * broadcasts calldata that is already complete. Rebuilt on every attempt, never persisted.
   */
  private async resolveCalldata(operation: PendingL1Operation): Promise<Hex> {
    if (operation.condition.kind !== L1OperationConditionKind.MessageInOutbox) {
      return `0x${operation.calldata.toString('hex')}`;
    }
    return await this.deps.withdrawalCompletion.resolveCalldata(operation);
  }

  /** Records the deferral and returns whether its cause is new for this operation. */
  private async defer(
    operation: PendingL1Operation,
    reason: PendingL1OperationReason | undefined,
    summary: L1OperationRunSummary,
    opts: { cause: string; countDeferred?: boolean; incrementAttempts?: boolean; deferReason?: RelayerDeferReason },
  ): Promise<boolean> {
    const now = this.now();
    const updated = await this.deps.store.updatePendingL1OperationRetry(operation.operationId, {
      lastCheckedAt: now,
      nextCheckAt: new Date(now.getTime() + this.deps.config.retryBackoffMs),
      lastReason: reason,
      incrementAttempts: opts.incrementAttempts,
    });
    // The operation reached a terminal status while this one ran. Nothing was deferred, so nothing is counted.
    if (!updated) {
      this.deferrals.forget(operation.operationId);
      return false;
    }
    summary.deferred++;
    // A terminal-failure retry (countDeferred: false) is already counted as 'failed'; only count genuine defers.
    if (opts.countDeferred !== false) {
      this.deps.telemetry?.l1OperationOutcome('deferred', opts.deferReason ?? reason ?? 'other');
    }
    const changed = this.deferrals.changed(operation.operationId, opts.cause);
    if (changed) {
      summary.deferredChanged++;
    }
    return changed;
  }

  private now(): Date {
    return this.dateProvider.nowAsDate();
  }
}

type Simulation = { status: 'success'; payout: bigint; logs: Log[] } | { status: 'failure'; error: unknown };
type GasPrice = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function operationLogFields(operation: PendingL1Operation): { operationId: string; target: string } {
  return {
    operationId: operation.operationId,
    target: operation.target.toString().toLowerCase(),
  };
}
