import { EthAddress } from '@aztec/foundation/eth-address';
import type { Logger } from '@aztec/foundation/log';

import { IFPCFunderAbi, OperationExecutorAbi } from '@oxide/l1-contracts';
import { EXECUTOR_MIN_PAYOUT_CALLDATA_GAS, SIMULATED_SENDER_BALANCE } from '@oxide/oxide-client/l1_operation_quote.js';

import { describe, expect, it, jest } from '@jest/globals';
import { type Hex, type PublicClient, decodeFunctionData } from 'viem';

import { LogRecorder } from '../log_recorder.js';
import type { ChainlinkPriceOracle } from '../price_oracle/chainlink_price_oracle.js';
import { FpcFunderCaller, type FpcFunderCallerConfig } from './fpc_funder_caller.js';

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
    maxFeePerGasCap?: bigint;
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

  const sendTransaction = jest.fn((_request: unknown) =>
    Promise.resolve({ txHash: `0x${'11'.repeat(32)}` as Hex, nonce: 0, settled: Promise.resolve() }),
  );

  const estimateGas = jest.fn((_args: unknown) => Promise.resolve(overrides.gasLimit ?? 100_000n));

  const client = {
    readContract,
    simulateContract,
    estimateGas,
    estimateFeesPerGas: jest.fn(() => Promise.resolve({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })),
  } as unknown as PublicClient;
  const l1TxQueue = {
    address: SENDER.toString(),
    enqueue: (submit: (send: unknown) => Promise<unknown>) => submit(sendTransaction),
    maxFeePerGasCap: overrides.maxFeePerGasCap,
  } as unknown as FpcFunderCallerConfig['l1TxQueue'];

  const caller = FpcFunderCaller.create({
    fpcFunder: FUNDER,
    executor: EXECUTOR,
    client,
    l1TxQueue,
    priceOracle: identityOracle,
    allowUnprofitable: overrides.allowUnprofitable ?? false,
    logger: overrides.logger,
  });

  return { caller, readContract, simulateContract, estimateGas, sendTransaction };
}

describe('FpcFunderCaller', () => {
  it('skips without estimating when the simulation reverts (below the fundable minimum)', async () => {
    const { caller, sendTransaction, estimateGas } = buildCaller({
      quote: () => Promise.reject(new Error('FPCFunder__BalanceBelowMinimum')),
    });

    await caller.runOnce();

    expect(estimateGas).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('submits through the executor with the break-even floor as minPayout', async () => {
    // Identity oracle: break-even = gasLimit (the 100k estimate plus the `minPayout` calldata gas) x
    // maxFeePerGas (1). The 1e18 bounty is far above it.
    const { caller, sendTransaction, simulateContract } = buildCaller();

    await caller.runOnce();

    expect(simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: EXECUTOR.toString(), functionName: 'execute' }),
    );
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    const [request] = sendTransaction.mock.calls[0] as unknown as [{ to: string; data: Hex; gas: bigint }];
    expect(request.to).toBe(EXECUTOR.toString());
    const decoded = decodeFunctionData({ abi: OperationExecutorAbi, data: request.data });
    expect(decoded.functionName).toBe('execute');
    const [target, innerData, payoutToken, minPayout] = decoded.args as [string, Hex, string, bigint];
    expect(EthAddress.fromString(target).equals(FUNDER)).toBe(true);
    expect(decodeFunctionData({ abi: IFPCFunderAbi, data: innerData }).functionName).toBe('swapAndDepositAsFeeJuice');
    expect(EthAddress.fromString(payoutToken).equals(TOKEN)).toBe(true);
    expect(minPayout).toBe(100_000n + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS);
    expect(request.gas).toBe(100_000n + EXECUTOR_MIN_PAYOUT_CALLDATA_GAS);
  });

  it('estimates gas against a zero floor', async () => {
    const { caller, estimateGas } = buildCaller();

    await caller.runOnce();

    const estimateCalls = estimateGas.mock.calls as unknown as [{ data: Hex }][];
    expect(estimateCalls).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: OperationExecutorAbi, data: estimateCalls[0][0].data });
    expect((decoded.args as [string, Hex, string, bigint])[3]).toBe(0n);
  });

  it('gives the sender a balance in the quote and the gas estimate, so an unfunded key can simulate', async () => {
    const { caller, simulateContract, estimateGas } = buildCaller();

    await caller.runOnce();

    const override = { stateOverride: [{ address: SENDER.toString(), balance: SIMULATED_SENDER_BALANCE }] };
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining(override));
    expect(estimateGas).toHaveBeenCalledWith(expect.objectContaining(override));
  });

  it('defers when the bounty is below the gas floor', async () => {
    // A 50k-unit bounty is below the ~100k break-even of the 100k-gas tx.
    const { caller, sendTransaction } = buildCaller({
      quote: () => Promise.resolve({ result: 50_000n }),
    });

    await caller.runOnce();

    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('defers when the max fee per gas is above the cap, even with allowUnprofitable', async () => {
    const { caller, sendTransaction } = buildCaller({ maxFeePerGasCap: 0n, allowUnprofitable: true });

    await caller.runOnce();

    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('submits when the max fee per gas equals the cap', async () => {
    const { caller, sendTransaction } = buildCaller({ maxFeePerGasCap: 1n });

    await caller.runOnce();

    expect(sendTransaction).toHaveBeenCalledTimes(1);
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
    const { caller, sendTransaction } = buildCaller({
      quote: () => Promise.resolve({ result: 50_000n }),
      allowUnprofitable: true,
    });

    await caller.runOnce();

    expect(sendTransaction).toHaveBeenCalledTimes(1);
    const [request] = sendTransaction.mock.calls[0] as unknown as [{ to: string; data: Hex }];
    const decoded = decodeFunctionData({ abi: OperationExecutorAbi, data: request.data });
    expect((decoded.args as [string, Hex, string, bigint])[3]).toBe(0n);
  });
});
