import { OperationExecutorAbi } from '@oxide/l1-contracts';
import { LegacyOperationExecutorAbi } from '@oxide/l1-contracts/legacy_operation_executor.js';
import { MAX_PRIORITY_FEE_WEI } from '@oxide/oxide-lib/oxide_constants.gen.js';

import { describe, expect, it, jest } from '@jest/globals';
import { type Address, type Hex, type PublicClient, getAbiItem, toFunctionSelector } from 'viem';

import { priceFeedForChainId } from './eth_usd_price_feed.js';
import {
  LEGACY_OPERATION_EXECUTOR_ABI,
  SIMULATED_SENDER_BALANCE,
  encodeOperationExecute,
  estimateL1OperationFeeValues,
  l1OperationGasLimit,
  minGasToCover,
  nextL1OperationGasLimit,
  quoteL1Operation,
  readOperationExecutorVersion,
  simulateL1Operation,
} from './l1_operation_quote.js';

const EXECUTOR = '0x00000000000000000000000000000000000000e1' as Address;
const SENDER = '0x00000000000000000000000000000000000000a1' as Address;
const ESCROW = '0x00000000000000000000000000000000000000c1' as Address;
const OPERATION = {
  target: '0x00000000000000000000000000000000000000b1',
  calldata: '0x1234',
  payoutToken: '0x00000000000000000000000000000000000000d1',
} as const;
const FEE_VALUES = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
const BASE_FEE = 1_500_000_000n;
const PRIORITY_FEE = 100_000_000n;
const USD_PER_ETH = 3_000n * 10n ** 8n;
const L1_TIMESTAMP = 1_700_000_000n;

function fakeClient(call: Record<string, unknown>, priorityFee = PRIORITY_FEE) {
  const simulateBlocks = jest.fn((_args: unknown) => Promise.resolve([{ calls: [call] }]));
  const getBlock = jest.fn((_args: unknown) =>
    Promise.resolve({ number: 100n, gasLimit: 30_000_000n, baseFeePerGas: BASE_FEE, timestamp: L1_TIMESTAMP }),
  );
  const estimateMaxPriorityFeePerGas = jest.fn(() => Promise.resolve(priorityFee));
  const readContract = jest.fn((_args: unknown) => Promise.resolve([1n, USD_PER_ETH, 0n, L1_TIMESTAMP, 1n] as const));
  const client = { simulateBlocks, getBlock, estimateMaxPriorityFeePerGas, readContract } as unknown as PublicClient;
  return { client, simulateBlocks, getBlock, readContract };
}

describe('estimateL1OperationFeeValues', () => {
  it('adds the headroom to the latest base fee, then the tip', async () => {
    const { client, getBlock } = fakeClient({});
    const feeValues = await estimateL1OperationFeeValues(client);
    expect(getBlock).toHaveBeenCalledWith({ blockTag: 'latest' });
    expect(feeValues).toEqual({ maxFeePerGas: 3_100_000_000n, maxPriorityFeePerGas: PRIORITY_FEE });
  });

  it('prices a given quote block without reading the latest block', async () => {
    const { client, getBlock } = fakeClient({});
    const feeValues = await estimateL1OperationFeeValues(client, { number: 99n, baseFeePerGas: 1_000_000_000n });
    expect(getBlock).not.toHaveBeenCalled();
    expect(feeValues.maxFeePerGas).toBe(2_100_000_000n);
  });

  it('throws on a block without a base fee', async () => {
    const { client } = fakeClient({});
    await expect(estimateL1OperationFeeValues(client, { number: 99n, baseFeePerGas: null })).rejects.toThrow(
      'L1 block 99 has no base fee',
    );
  });

  it('signs a tip below the cap as it is', async () => {
    const feeValues = await estimateL1OperationFeeValues(fakeClient({}, MAX_PRIORITY_FEE_WEI - 1n).client);
    expect(feeValues.maxPriorityFeePerGas).toBe(MAX_PRIORITY_FEE_WEI - 1n);
  });

  it('caps the tip at the max priority fee', async () => {
    const feeValues = await estimateL1OperationFeeValues(fakeClient({}, 5_000_000_000n).client);
    expect(feeValues.maxPriorityFeePerGas).toBe(MAX_PRIORITY_FEE_WEI);
    expect(feeValues.maxFeePerGas).toBe(2n * BASE_FEE + MAX_PRIORITY_FEE_WEI);
  });
});

describe('simulateL1Operation', () => {
  it('simulates the executor call with no gas cost at the latest base fee, with the sender funded and the extra state', async () => {
    const { client, simulateBlocks } = fakeClient({ status: 'success', result: 7n, gasUsed: 90_000n, logs: [] });
    const extra = [{ address: ESCROW, balance: 1n }];
    const result = await simulateL1Operation(client, {
      executor: EXECUTOR,
      sender: SENDER,
      operation: OPERATION,
      feeValues: FEE_VALUES,
      minPayout: 5n,
      stateOverrides: extra,
    });
    expect(result).toEqual({
      status: 'success',
      result: 7n,
      gasUsed: 90_000n,
      logs: [],
      blockNumber: 100n,
      baseFeePerGas: BASE_FEE,
      gasToCover: 90_768n,
    });

    const [request] = simulateBlocks.mock.calls[0] as [Record<string, any>];
    expect(request.blockNumber).toBe(100n);
    expect(request.traceTransfers).toBe(true);
    expect(request.validation).toBe(true);
    const [block] = request.blocks;
    expect(block.blockOverrides).toEqual({ baseFeePerGas: BASE_FEE });
    expect(block.stateOverrides).toEqual([{ address: SENDER, balance: SIMULATED_SENDER_BALANCE }, ...extra]);
    expect(block.calls[0]).toMatchObject({
      to: EXECUTOR,
      functionName: 'execute',
      args: [OPERATION.target, OPERATION.calldata, OPERATION.payoutToken, 5n, 0n, 0n],
      from: SENDER,
      gas: 15_000_000n,
      ...FEE_VALUES,
    });
  });

  it('uses the block gas limit when it is below the simulation cap', async () => {
    const { client, getBlock, simulateBlocks } = fakeClient({ status: 'success', gasUsed: 90_000n });
    getBlock.mockResolvedValue({
      number: 100n,
      gasLimit: 12_000_000n,
      baseFeePerGas: BASE_FEE,
      timestamp: L1_TIMESTAMP,
    });
    await simulateL1Operation(client, {
      executor: EXECUTOR,
      sender: SENDER,
      operation: OPERATION,
      feeValues: FEE_VALUES,
    });
    const [request] = simulateBlocks.mock.calls[0] as [Record<string, any>];
    expect(request.blocks[0].calls[0].gas).toBe(12_000_000n);
  });

  it('simulates the four-argument call of a legacy executor', async () => {
    const { client, simulateBlocks } = fakeClient({ status: 'success', result: 7n, gasUsed: 90_000n });
    await simulateL1Operation(client, {
      executor: EXECUTOR,
      legacyExecutor: true,
      sender: SENDER,
      operation: OPERATION,
      feeValues: FEE_VALUES,
      minPayout: 5n,
    });
    const [request] = simulateBlocks.mock.calls[0] as [Record<string, any>];
    expect(request.blocks[0].calls[0]).toMatchObject({
      abi: LegacyOperationExecutorAbi,
      functionName: 'execute',
      args: [OPERATION.target, OPERATION.calldata, OPERATION.payoutToken, 5n],
    });
  });

  it('simulates on a given quote block at its base fee', async () => {
    const { client, simulateBlocks, getBlock } = fakeClient({ status: 'success', result: 7n, gasUsed: 90_000n });
    const quoteBlock = { number: 99n, baseFeePerGas: 1_000_000_000n };
    await simulateL1Operation(client, {
      executor: EXECUTOR,
      sender: SENDER,
      operation: OPERATION,
      feeValues: FEE_VALUES,
      quoteBlock,
    });
    expect(getBlock).not.toHaveBeenCalled();
    const [request] = simulateBlocks.mock.calls[0] as [Record<string, any>];
    expect(request.blockNumber).toBe(99n);
    expect(request.blocks[0].blockOverrides).toEqual({ baseFeePerGas: 1_000_000_000n });
    expect(request.blocks[0].calls[0].gas).toBe(15_000_000n);
  });

  it('returns a failed call as a failure', async () => {
    const error = new Error('reverted');
    const { client } = fakeClient({ status: 'failure', error });
    const result = await simulateL1Operation(client, {
      executor: EXECUTOR,
      sender: SENDER,
      operation: OPERATION,
      feeValues: FEE_VALUES,
    });
    expect(result).toEqual({ status: 'failure', error });
  });
});

describe('quoteL1Operation', () => {
  const args = {
    executor: EXECUTOR,
    sender: SENDER,
    operation: OPERATION,
    payout: 9n,
    ethUsdFeed: priceFeedForChainId(1n).toString() as Address,
  };

  it('requires the payout in the simulation and prices its gas at the base fee plus the tip', async () => {
    const { client, simulateBlocks, readContract } = fakeClient({
      status: 'success',
      result: 9n,
      gasUsed: 120_000n,
      logs: [],
    });
    const quote = await quoteL1Operation(client, args);

    const [request] = simulateBlocks.mock.calls[0] as [Record<string, any>];
    expect(request.blocks[0].calls[0].args[3]).toBe(9n);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: args.ethUsdFeed }));
    // 120,768 gas to cover at 1.6 gwei and 3,000 USD/ETH; the 3.1 gwei fee ceiling does not price it.
    expect(quote).toEqual({
      maxFeePerGas: 3_100_000_000n,
      maxPriorityFeePerGas: PRIORITY_FEE,
      gasUsed: 120_000n,
      baseFeePerGas: BASE_FEE,
      usdPerEth: USD_PER_ETH,
      minPayout: 579_686_400_000_000_000n,
    });
  });

  it('prices the gas of a legacy executor at the fee ceiling, and calls its four-argument execute', async () => {
    const { client, simulateBlocks } = fakeClient({ status: 'success', result: 9n, gasUsed: 120_000n, logs: [] });
    const quote = await quoteL1Operation(client, { ...args, executorVersion: 'legacy' });

    const [request] = simulateBlocks.mock.calls[0] as [Record<string, any>];
    expect(request.blocks[0].calls[0].abi).toBe(LEGACY_OPERATION_EXECUTOR_ABI);
    expect(request.blocks[0].calls[0].args).toEqual([OPERATION.target, OPERATION.calldata, OPERATION.payoutToken, 9n]);
    // 120,768 gas to cover at the 3.1 gwei fee ceiling and 3,000 USD/ETH.
    expect(quote.minPayout).toBe(1_123_142_400_000_000_000n);
  });

  it('throws when the simulation fails', async () => {
    const { client } = fakeClient({ status: 'failure', error: new Error('payout too low') });
    await expect(quoteL1Operation(client, args)).rejects.toThrow('L1 operation simulation failed: payout too low');
  });
});

describe('readOperationExecutorVersion', () => {
  const selector = (abi: typeof OperationExecutorAbi | typeof LEGACY_OPERATION_EXECUTOR_ABI) =>
    toFunctionSelector(getAbiItem({ abi, name: 'execute' })).slice(2);
  const clientWithCode = (code: Hex | undefined) =>
    ({ getCode: () => Promise.resolve(code) }) as unknown as Pick<PublicClient, 'getCode'>;

  it('reads the version from the execute selector in the code', async () => {
    await expect(
      readOperationExecutorVersion(clientWithCode(`0x6080${selector(OperationExecutorAbi)}00`), EXECUTOR),
    ).resolves.toBe('gas-to-cover');
    await expect(
      readOperationExecutorVersion(clientWithCode(`0x6080${selector(LEGACY_OPERATION_EXECUTOR_ABI)}00`), EXECUTOR),
    ).resolves.toBe('legacy');
  });

  it('throws when the code has no execute', async () => {
    await expect(readOperationExecutorVersion(clientWithCode(undefined), EXECUTOR)).rejects.toThrow(
      /no OperationExecutor/,
    );
    await expect(readOperationExecutorVersion(clientWithCode('0x6080'), EXECUTOR)).rejects.toThrow(
      /no OperationExecutor/,
    );
  });
});

describe('encodeOperationExecute', () => {
  it('refuses a gas cost for a legacy executor', () => {
    expect(() => encodeOperationExecute('legacy', OPERATION, 1n, { gasToCover: 1n, tokenWeiPerEth: 1n })).toThrow(
      /legacy OperationExecutor takes no gas cost/,
    );
  });
});

describe('L1 operation gas limit', () => {
  const quoteBlock = { number: 1n, baseFeePerGas: 1n, gasLimit: 200_000_000n };

  it('starts at 3/2 of the gas used and doubles up to 15M gas', () => {
    expect(l1OperationGasLimit(400_000n, quoteBlock)).toBe(600_000n);
    expect(nextL1OperationGasLimit(600_000n, quoteBlock)).toBe(1_200_000n);
    expect(nextL1OperationGasLimit(9_600_000n, quoteBlock)).toBe(15_000_000n);
    expect(nextL1OperationGasLimit(15_000_000n, quoteBlock)).toBeUndefined();
  });

  it('stops at the gas limit of a block below 15M gas', () => {
    const smallBlock = { ...quoteBlock, gasLimit: 1_000_000n };
    expect(nextL1OperationGasLimit(600_000n, smallBlock)).toBe(1_000_000n);
    expect(nextL1OperationGasLimit(1_000_000n, smallBlock)).toBeUndefined();
  });

  it('requires a gas to cover of 2/3 of the gas limit, rounded up', () => {
    expect(minGasToCover(1_200_000n)).toBe(800_000n);
    expect(minGasToCover(1_000_000n)).toBe(666_667n);
  });

  it('does not raise the gas to cover at the first gas limit', () => {
    for (const gasUsed of [21_000n, 100_001n, 2_892_587n]) {
      expect(minGasToCover(l1OperationGasLimit(gasUsed, quoteBlock))).toBeLessThanOrEqual(gasUsed);
    }
  });
});
