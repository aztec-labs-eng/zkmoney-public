import { EthAddress } from '@aztec/foundation/eth-address';
import type { Logger } from '@aztec/foundation/log';

import { IFPCFunderAbi, OperationExecutorAbi } from '@oxide/l1-contracts';

import { describe, expect, it, jest } from '@jest/globals';
import { type Hex, decodeFunctionData } from 'viem';

import { EXECUTOR_MIN_PAYOUT_CALLDATA_GAS } from '../l1_utils.js';
import { LogRecorder } from '../log_recorder.js';
import type { ChainlinkPriceOracle } from '../price_oracle/chainlink_price_oracle.js';
import type { RelayerL1TxUtils } from '../relayer_l1_tx_utils.js';
import { FpcFunderCaller } from './fpc_funder_caller.js';

const SENDER = EthAddress.random();
const FUNDER = EthAddress.random();
const EXECUTOR = EthAddress.random();
const TOKEN = EthAddress.random();

const BOUNTY = 10n ** 18n;

const identityOracle = {
  weiToUSD: (wei: bigint) => Promise.resolve(wei),
} as unknown as ChainlinkPriceOracle;

/** A revert shaped the way viem exposes a decoded custom error: the args sit on `cause.data`. */
function belowMinimumRevert(balance: bigint, minimum: bigint): Error {
  return Object.assign(new Error('The contract function "execute" reverted.'), {
    cause: { data: { errorName: 'FPCFunder__BalanceBelowMinimum', args: [balance, minimum] } },
  });
}

function buildCaller(
  overrides: {
    /** Simulated `execute` result. Reject to model a funder the call would revert on. */
    quote?: () => Promise<{ result: bigint }>;
    allowUnprofitable?: boolean;
    gasLimit?: bigint;
    logger?: Logger;
  } = {},
) {
  const quote = overrides.quote ?? (() => Promise.resolve({ result: BOUNTY }));
  const simulateContract = jest.fn((_args: unknown) => quote());

  const readContract = jest.fn((args: { functionName: string }) => {
    if (args.functionName === 'inputToken') {
      return Promise.resolve(TOKEN.toString());
    }
    return Promise.reject(new Error(`unexpected read ${args.functionName}`));
  });

  const sendTransactionWithGasPrice = jest.fn((_request: unknown, _gas: unknown, _fee: unknown) =>
    Promise.resolve({ txHash: `0x${'11'.repeat(32)}` as Hex, state: { id: 0, nonce: 0 }, settled: Promise.resolve() }),
  );

  const l1TxUtils = {
    sendTransactionWithGasPrice,
    estimateGas: jest.fn(() => Promise.resolve(overrides.gasLimit ?? 100_000n)),
    getGasPrice: jest.fn(() => Promise.resolve({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })),
    getSenderAddress: () => SENDER,
    client: { readContract, simulateContract },
  } as unknown as RelayerL1TxUtils;

  const caller = FpcFunderCaller.create({
    fpcFunder: FUNDER,
    executor: EXECUTOR,
    l1TxUtils,
    priceOracle: identityOracle,
    allowUnprofitable: overrides.allowUnprofitable ?? false,
    logger: overrides.logger,
  });

  return { caller, readContract, simulateContract, sendTransactionWithGasPrice, l1TxUtils };
}

describe('FpcFunderCaller', () => {
  it('skips without estimating when the simulation reverts (below the fundable minimum)', async () => {
    const { caller, sendTransactionWithGasPrice, l1TxUtils } = buildCaller({
      quote: () => Promise.reject(new Error('FPCFunder__BalanceBelowMinimum')),
    });

    await caller.runOnce();

    expect((l1TxUtils.estimateGas as jest.Mock).mock.calls).toHaveLength(0);
    expect(sendTransactionWithGasPrice).not.toHaveBeenCalled();
  });

  it('submits through the executor with the break-even floor as minPayout', async () => {
    // Identity oracle: break-even = gasLimit (the 100k estimate plus the `minPayout` calldata gas) x
    // maxFeePerGas (1). The 1e18 bounty is far above it.
    const { caller, sendTransactionWithGasPrice, simulateContract } = buildCaller();

    await caller.runOnce();

    expect(simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: EXECUTOR.toString(), functionName: 'execute' }),
    );
    expect(sendTransactionWithGasPrice).toHaveBeenCalledTimes(1);
    const [request, gasConfig] = sendTransactionWithGasPrice.mock.calls[0] as unknown as [
      { to: string; data: Hex },
      { gasLimit: bigint },
    ];
    expect(request.to).toBe(EXECUTOR.toString());
    const decoded = decodeFunctionData({ abi: OperationExecutorAbi, data: request.data });
    expect(decoded.functionName).toBe('execute');
    const [target, innerData, payoutToken, minPayout] = decoded.args as [string, Hex, string, bigint];
    expect(EthAddress.fromString(target).equals(FUNDER)).toBe(true);
    expect(decodeFunctionData({ abi: IFPCFunderAbi, data: innerData }).functionName).toBe('swapAndDepositAsFeeJuice');
    expect(EthAddress.fromString(payoutToken).equals(TOKEN)).toBe(true);
    expect(minPayout).toBe(100_000n + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS);
    expect(gasConfig.gasLimit).toBe(100_000n + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS);
  });

  it('estimates gas against a zero floor', async () => {
    const { caller, l1TxUtils } = buildCaller();

    await caller.runOnce();

    const estimateCalls = (l1TxUtils.estimateGas as jest.Mock).mock.calls as unknown as [string, { data: Hex }][];
    expect(estimateCalls).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: OperationExecutorAbi, data: estimateCalls[0][1].data });
    expect((decoded.args as [string, Hex, string, bigint])[3]).toBe(0n);
  });

  it('defers when the bounty is below the gas floor', async () => {
    // A 50k-unit bounty is below the ~100k break-even of the 100k-gas tx.
    const { caller, sendTransactionWithGasPrice } = buildCaller({
      quote: () => Promise.resolve({ result: 50_000n }),
    });

    await caller.runOnce();

    expect(sendTransactionWithGasPrice).not.toHaveBeenCalled();
  });

  it('logs the balance and the minimum once, then at debug while both hold', async () => {
    const recorder = new LogRecorder();
    const { caller } = buildCaller({
      quote: () => Promise.reject(belowMinimumRevert(5n * 10n ** 17n, 5n * 10n ** 18n)),
      logger: recorder.logger('fpc-funder-caller'),
    });

    await caller.runOnce();
    await caller.runOnce();
    await caller.runOnce();

    const lines = recorder.lines.filter(line => line.event === 'fpc_funding_deferred');
    expect(lines.map(line => line.level)).toEqual(['info', 'debug', 'debug']);
    expect(lines[0].data).toMatchObject({
      cause: 'balance_below_minimum',
      balance: '500000000000000000',
      minimum: '5000000000000000000',
    });
    expect(lines[0].data?.error).toBeUndefined();
  });

  it('logs again when the balance moves below the same minimum', async () => {
    const recorder = new LogRecorder();
    let balance = 5n * 10n ** 17n;
    const { caller } = buildCaller({
      quote: () => Promise.reject(belowMinimumRevert(balance, 5n * 10n ** 18n)),
      logger: recorder.logger('fpc-funder-caller'),
    });

    await caller.runOnce();
    balance = 10n ** 18n;
    await caller.runOnce();
    await caller.runOnce();

    const lines = recorder.lines.filter(line => line.event === 'fpc_funding_deferred');
    expect(lines.map(line => line.level)).toEqual(['info', 'info', 'debug']);
  });

  it('logs the same balance again after an undecodable revert between two readings', async () => {
    const recorder = new LogRecorder();
    let quote: () => Promise<{ result: bigint }> = () =>
      Promise.reject(belowMinimumRevert(5n * 10n ** 17n, 5n * 10n ** 18n));
    const { caller } = buildCaller({ quote: () => quote(), logger: recorder.logger('fpc-funder-caller') });

    await caller.runOnce();
    quote = () => Promise.reject(new Error('connection refused'));
    await caller.runOnce();
    quote = () => Promise.reject(belowMinimumRevert(5n * 10n ** 17n, 5n * 10n ** 18n));
    await caller.runOnce();

    const lines = recorder.lines.filter(line => line.event === 'fpc_funding_deferred');
    expect(lines.map(line => line.level)).toEqual(['info', 'info', 'info']);
  });

  it('keeps an undecodable simulation revert at info on every cycle', async () => {
    const recorder = new LogRecorder();
    const { caller } = buildCaller({
      quote: () => Promise.reject(new Error('connection refused')),
      logger: recorder.logger('fpc-funder-caller'),
    });

    await caller.runOnce();
    await caller.runOnce();
    await caller.runOnce();

    const lines = recorder.lines.filter(line => line.event === 'fpc_funding_deferred');
    expect(lines.map(line => line.level)).toEqual(['info', 'info', 'info']);
    expect(lines[0].data).toMatchObject({ cause: 'simulation_reverted' });
  });

  it('logs the bounty floor once while the funder stays unprofitable', async () => {
    const recorder = new LogRecorder();
    let bounty = 50_000n;
    const { caller } = buildCaller({
      quote: () => Promise.resolve({ result: bounty }),
      logger: recorder.logger('fpc-funder-caller'),
    });

    await caller.runOnce();
    // The bounty ramps every block; the funder is still unprofitable, so the line stays at debug.
    bounty = 60_000n;
    await caller.runOnce();

    const lines = recorder.lines.filter(line => line.event === 'fpc_funding_deferred');
    expect(lines.map(line => line.level)).toEqual(['info', 'debug']);
    expect(lines[0].data).toMatchObject({ cause: 'unprofitable' });
  });

  it('submits a below-floor bounty with a zero minPayout when allowUnprofitable is set', async () => {
    const { caller, sendTransactionWithGasPrice } = buildCaller({
      quote: () => Promise.resolve({ result: 50_000n }),
      allowUnprofitable: true,
    });

    await caller.runOnce();

    expect(sendTransactionWithGasPrice).toHaveBeenCalledTimes(1);
    const [request] = sendTransactionWithGasPrice.mock.calls[0] as unknown as [{ to: string; data: Hex }];
    const decoded = decodeFunctionData({ abi: OperationExecutorAbi, data: request.data });
    expect((decoded.args as [string, Hex, string, bigint])[3]).toBe(0n);
  });
});
