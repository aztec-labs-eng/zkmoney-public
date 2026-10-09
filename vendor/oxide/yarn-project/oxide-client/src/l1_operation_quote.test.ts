import { MAX_PRIORITY_FEE_WEI } from '@oxide/oxide-lib/oxide_constants.gen.js';

import { describe, expect, it, jest } from '@jest/globals';
import type { Address, PublicClient } from 'viem';

import { priceFeedForChainId } from './eth_usd_price_feed.js';
import {
  SIMULATED_SENDER_BALANCE,
  estimateL1OperationFeeValues,
  quoteL1Operation,
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
    Promise.resolve({ number: 100n, baseFeePerGas: BASE_FEE, timestamp: L1_TIMESTAMP }),
  );
  const estimateMaxPriorityFeePerGas = jest.fn(() => Promise.resolve(priorityFee));
  const readContract = jest.fn((_args: unknown) => Promise.resolve([1n, USD_PER_ETH, 0n, L1_TIMESTAMP, 1n] as const));
  const client = { simulateBlocks, getBlock, estimateMaxPriorityFeePerGas, readContract } as unknown as PublicClient;
  return { client, simulateBlocks, getBlock, readContract };
}

describe('estimateL1OperationFeeValues', () => {
  it('adds the default headroom to the latest base fee, then the tip', async () => {
    const { client, getBlock } = fakeClient({});
    const feeValues = await estimateL1OperationFeeValues(client);
    expect(getBlock).toHaveBeenCalledWith({ blockTag: 'latest' });
    expect(feeValues).toEqual({ maxFeePerGas: 1_693_750_000n, maxPriorityFeePerGas: PRIORITY_FEE });
  });

  it('adds a configured headroom', async () => {
    const feeValues = await estimateL1OperationFeeValues(fakeClient({}).client, 50);
    expect(feeValues.maxFeePerGas).toBe(2_350_000_000n);
  });

  it('signs a tip below the cap as it is', async () => {
    const feeValues = await estimateL1OperationFeeValues(fakeClient({}, MAX_PRIORITY_FEE_WEI - 1n).client);
    expect(feeValues.maxPriorityFeePerGas).toBe(MAX_PRIORITY_FEE_WEI - 1n);
  });

  it('caps the tip at the max priority fee', async () => {
    const feeValues = await estimateL1OperationFeeValues(fakeClient({}, 5_000_000_000n).client);
    expect(feeValues.maxPriorityFeePerGas).toBe(MAX_PRIORITY_FEE_WEI);
    expect(feeValues.maxFeePerGas).toBe((BASE_FEE * 10_625n) / 10_000n + MAX_PRIORITY_FEE_WEI);
  });
});

describe('simulateL1Operation', () => {
  it('simulates the executor call at the latest base fee, with the sender funded and the extra state', async () => {
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
      costWei: 180_768_000_000_000n,
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
      args: [OPERATION.target, OPERATION.calldata, OPERATION.payoutToken, 5n],
      from: SENDER,
      ...FEE_VALUES,
    });
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

  it('requires the payout in the simulation and converts the gas cost to USD', async () => {
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
    expect(quote).toEqual({
      maxFeePerGas: 1_693_750_000n,
      maxPriorityFeePerGas: PRIORITY_FEE,
      gasUsed: 120_000n,
      baseFeePerGas: BASE_FEE,
      usdPerEth: USD_PER_ETH,
      minPayout: 611_701_200_000_000_000n,
    });
  });

  it('throws when the simulation fails', async () => {
    const { client } = fakeClient({ status: 'failure', error: new Error('payout too low') });
    await expect(quoteL1Operation(client, args)).rejects.toThrow('L1 operation simulation failed: payout too low');
  });
});
