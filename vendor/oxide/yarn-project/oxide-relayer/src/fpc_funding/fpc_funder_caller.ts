import { EthAddress } from '@aztec/foundation/eth-address';
import { type Logger, createLogger } from '@aztec/foundation/log';
import { RunningPromise } from '@aztec/foundation/running-promise';

import { ErrorsAbi, IFPCFunderAbi, OperationExecutorAbi } from '@oxide/l1-contracts';

import { type Hex, encodeFunctionData } from 'viem';

import { CauseTransitions } from '../cause_transitions.js';
import {
  type L1SubmissionBatchSender,
  type L1SubmissionBatcher,
  L1SubmissionType,
  enqueueL1Submission,
} from '../l1_submission_batcher.js';
import { EXECUTOR_MIN_PAYOUT_CALLDATA_GAS } from '../l1_utils.js';
import type { ChainlinkPriceOracle } from '../price_oracle/chainlink_price_oracle.js';
import type { RelayerL1TxUtils, SentL1Tx } from '../relayer_l1_tx_utils.js';

export const DEFAULT_FPC_FUNDING_POLL_INTERVAL_MS = 60_000;

export interface FpcFunderCallerConfig {
  fpcFunder: EthAddress;
  /** OperationExecutor the call is wrapped in, so a raced call reverts on its payout floor. */
  executor: EthAddress;
  l1TxUtils: RelayerL1TxUtils;
  l1SubmissionBatcher?: L1SubmissionBatcher;
  priceOracle: ChainlinkPriceOracle;
  /** Call whenever the quote is nonzero, skipping the break-even check. */
  allowUnprofitable: boolean;
  pollIntervalMs?: number;
  logger?: Logger;
}

/**
 * Polls the FPCFunder's bounty quote and calls `swapAndDepositAsFeeJuice()` when the bounty covers the gas cost.
 * The call goes through the OperationExecutor with the break-even floor as `minPayout`.
 */
export class FpcFunderCaller {
  private readonly runningPromise: RunningPromise;
  private inputToken?: EthAddress;
  /** The cause the funder was last deferred with, so an idle funder logs once for each state it enters. */
  private readonly deferrals = new CauseTransitions();
  private retryNextBatch = false;

  private constructor(
    private readonly config: FpcFunderCallerConfig,
    private readonly log: Logger,
    pollIntervalMs: number,
  ) {
    this.runningPromise = new RunningPromise(() => this.runOnce(), this.log, pollIntervalMs);
  }

  static create(config: FpcFunderCallerConfig): FpcFunderCaller {
    const log = config.logger ?? createLogger('oxide-relayer:fpc-funder-caller');
    return new FpcFunderCaller(config, log, config.pollIntervalMs ?? DEFAULT_FPC_FUNDING_POLL_INTERVAL_MS);
  }

  public start(): void {
    if (!this.runningPromise.isRunning()) {
      this.log.info(`Starting FPC funder caller (funder ${this.config.fpcFunder})`);
      this.runningPromise.start();
    }
  }

  public async stop(): Promise<void> {
    await this.runningPromise.stop();
  }

  /** One poll cycle: quote, gate, and submit. Public so tests can drive it without the loop. */
  public async runOnce(): Promise<void> {
    const retry = this.retryNextBatch;
    this.retryNextBatch = false;
    const sent = await enqueueL1Submission(this.config.l1SubmissionBatcher, this.config.l1TxUtils, {
      kind: L1SubmissionType.FpcFunding,
      retry,
      submit: sender => this.prepareAndSubmit(sender),
    });
    if (!sent) {
      return;
    }
    try {
      await sent.settled;
    } catch (error) {
      this.retryNextBatch = true;
      throw error;
    }
  }

  private async prepareAndSubmit(sender: L1SubmissionBatchSender): Promise<SentL1Tx | undefined> {
    const l1TxUtils = this.config.l1TxUtils;
    const to = this.config.executor.toString();
    const inputToken = await this.getInputToken();

    let bounty: bigint;
    try {
      bounty = await this.quotePayout(inputToken);
    } catch (err) {
      // Below the fundable minimum the call reverts. That is the funder's idle state, not a fault, so it logs once
      // for each balance it holds. Any other revert is unexpected and keeps its level on every occurrence.
      const belowMinimum = balanceBelowMinimum(err);
      if (!belowMinimum) {
        // Record the state even though the line is unconditional, so a return to the same balance logs again.
        this.deferrals.changed(this.deferralKey(), 'simulation_reverted');
        this.log.info('FPC funding simulation reverted; deferring', {
          event: 'fpc_funding_deferred',
          cause: 'simulation_reverted',
          error: errMessage(err),
        });
        return;
      }
      const { balance, minimum } = belowMinimum;
      const changed = this.deferrals.changed(this.deferralKey(), `balance_below_minimum:${balance}:${minimum}`);
      const write = changed ? this.log.info : this.log.debug;
      write.call(this.log, 'FPC funder balance is below the fundable minimum; deferring', {
        event: 'fpc_funding_deferred',
        cause: 'balance_below_minimum',
        balance: balance.toString(),
        minimum: minimum.toString(),
      });
      return;
    }

    // Estimate against a zero floor: the execution path is identical, and estimation cannot be raced into
    // a revert by a bounty change between the quote and here.
    const estimatedGas = await l1TxUtils.estimateGas(l1TxUtils.getSenderAddress().toString(), {
      to,
      data: this.executeCalldata(inputToken, 0n),
    });
    // Non-zero `minPayout` costs extra calldata gas, so add it here.
    const gasLimit = estimatedGas + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS;
    const price = await l1TxUtils.getGasPrice();

    let floor = 0n;
    if (!this.config.allowUnprofitable) {
      // Break-even for the exact tx being sent, in payout-token units. The bounty ramp is the margin: an
      // unprofitable call becomes profitable by waiting.
      floor = await this.config.priceOracle.weiToUSD(gasLimit * price.maxFeePerGas);
    }
    if (bounty < floor) {
      // The bounty ramps every block, so the amounts change while the state does not. Only the state opens the gate.
      const changed = this.deferrals.changed(this.deferralKey(), 'unprofitable');
      const write = changed ? this.log.info : this.log.debug;
      write.call(this.log, 'FPC funding deferred by bounty floor', {
        event: 'fpc_funding_deferred',
        cause: 'unprofitable',
        bounty: bounty.toString(),
        floor: floor.toString(),
      });
      return;
    }

    const sent = await sender.sendTransactionWithGasPrice(
      { to, data: this.executeCalldata(inputToken, floor) },
      { gasLimit },
      { maxFeePerGas: price.maxFeePerGas, maxPriorityFeePerGas: price.maxPriorityFeePerGas },
    );
    const { txHash, state } = sent;
    this.deferrals.forget(this.deferralKey());
    this.log.info('Submitted FPC funding call', {
      event: 'fpc_funding_submitted',
      txHash,
      nonce: state.nonce,
      bounty: bounty.toString(),
      minPayout: floor.toString(),
      gasLimit: gasLimit.toString(),
    });
    return sent;
  }

  private deferralKey(): string {
    return this.config.fpcFunder.toString().toLowerCase();
  }

  /** `executor.execute(funder, swapAndDepositAsFeeJuice, inputToken, minPayout)` calldata. */
  private executeCalldata(inputToken: EthAddress, minPayout: bigint): Hex {
    return encodeFunctionData({
      abi: OperationExecutorAbi,
      functionName: 'execute',
      args: [
        this.config.fpcFunder.toString(),
        encodeFunctionData({ abi: IFPCFunderAbi, functionName: 'swapAndDepositAsFeeJuice' }),
        inputToken.toString(),
        minPayout,
      ],
    });
  }

  private async quotePayout(inputToken: EthAddress): Promise<bigint> {
    const { result } = await this.config.l1TxUtils.client.simulateContract({
      abi: [...OperationExecutorAbi, ...ErrorsAbi],
      address: this.config.executor.toString(),
      functionName: 'execute',
      args: [
        this.config.fpcFunder.toString(),
        encodeFunctionData({ abi: IFPCFunderAbi, functionName: 'swapAndDepositAsFeeJuice' }),
        inputToken.toString(),
        0n,
      ],
      account: this.config.l1TxUtils.getSenderAddress().toString(),
    });
    return result;
  }

  private async getInputToken(): Promise<EthAddress> {
    if (!this.inputToken) {
      const raw = await this.config.l1TxUtils.client.readContract({
        address: this.config.fpcFunder.toString(),
        abi: IFPCFunderAbi,
        functionName: 'inputToken',
      });
      this.inputToken = EthAddress.fromString(raw);
    }
    return this.inputToken;
  }
}

/**
 * The funder's balance and its fundable minimum, when the revert is `FPCFunder__BalanceBelowMinimum`. Viem exposes
 * the decoded custom error in the cause chain, and `ErrorsAbi` is already part of the simulation.
 */
function balanceBelowMinimum(error: unknown): { balance: bigint; minimum: bigint } | undefined {
  for (let current: any = error; current && typeof current === 'object'; current = current.cause) {
    if (current.data?.errorName !== 'FPCFunder__BalanceBelowMinimum') {
      continue;
    }
    const [balance, minimum] = (current.data.args ?? []) as [bigint?, bigint?];
    if (typeof balance === 'bigint' && typeof minimum === 'bigint') {
      return { balance, minimum };
    }
  }
  return undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
