import { ReadOnlyL1TxUtils } from '@aztec/ethereum/l1-tx-utils';
import type { ViemClient } from '@aztec/ethereum/types';
import { DateProvider } from '@aztec/foundation/timer';

import { describe, expect, it } from '@jest/globals';
import { parseGwei } from 'viem';

import { DEFAULT_L1_MIN_PRIORITY_FEE_GWEI, RELAYER_V1_L1_TX_UTILS_CONFIG } from './l1_tx_utils_config.js';

const BASE_FEE = parseGwei('1.11');
const FLOOR = parseGwei(String(DEFAULT_L1_MIN_PRIORITY_FEE_GWEI));

function clientWithNetworkTip(networkTip: bigint): ViemClient {
  const stub = {
    getBlock: ({ blockTag }: { blockTag?: string } = {}) =>
      Promise.resolve(blockTag === 'pending' ? { transactions: [] } : { baseFeePerGas: BASE_FEE }),
    estimateMaxPriorityFeePerGas: () => Promise.resolve(networkTip),
    getFeeHistory: () => Promise.resolve({ reward: [] }),
    getBlobBaseFee: () => Promise.resolve(0n),
  };
  return stub as unknown as ViemClient;
}

function relayerGasPrice(networkTip: bigint, floorGwei?: number) {
  const config =
    floorGwei === undefined
      ? RELAYER_V1_L1_TX_UTILS_CONFIG
      : { ...RELAYER_V1_L1_TX_UTILS_CONFIG, minimumPriorityFeePerGas: floorGwei };
  const utils = new ReadOnlyL1TxUtils(clientWithNetworkTip(networkTip), undefined, new DateProvider(), config);
  return utils.getGasPrice();
}

describe('RELAYER_V1_L1_TX_UTILS_CONFIG', () => {
  it('floors the tip when the chain reports no tip at all', async () => {
    const { maxPriorityFeePerGas } = await relayerGasPrice(0n);

    expect(maxPriorityFeePerGas).toBeGreaterThanOrEqual(FLOOR);
  });

  it('floors a tip that the chain prices below the minimum', async () => {
    const { maxPriorityFeePerGas } = await relayerGasPrice(parseGwei('0.01'));

    expect(maxPriorityFeePerGas).toBeGreaterThanOrEqual(FLOOR);
  });

  it('bumps the floored tip by the first-attempt percentage, so the sent tip is above the floor', async () => {
    const { maxPriorityFeePerGas } = await relayerGasPrice(0n);

    expect(maxPriorityFeePerGas).toBe(parseGwei('0.12'));
  });

  it('lifts the tip clear of the starved value when the operator raises the floor, as Sepolia needs', async () => {
    const { maxPriorityFeePerGas } = await relayerGasPrice(0n, 1);

    expect(maxPriorityFeePerGas).toBeGreaterThan(parseGwei('0.12'));
  });

  it('leaves a market tip above the floor alone', async () => {
    const { maxPriorityFeePerGas } = await relayerGasPrice(parseGwei('5'));

    expect(maxPriorityFeePerGas).toBeGreaterThanOrEqual(parseGwei('5'));
  });

  it('carries the floored tip in the fee ceiling the caller prices against', async () => {
    const { maxFeePerGas, maxPriorityFeePerGas } = await relayerGasPrice(0n);

    expect(maxFeePerGas).toBeGreaterThan(BASE_FEE + maxPriorityFeePerGas);
  });

  it('keeps the no-bump policy, so the priced ceiling is the ceiling the transaction carries', () => {
    expect(RELAYER_V1_L1_TX_UTILS_CONFIG).toMatchObject({
      maxSpeedUpAttempts: 0,
      priorityFeeRetryBumpPercentage: 0,
    });
  });
});
