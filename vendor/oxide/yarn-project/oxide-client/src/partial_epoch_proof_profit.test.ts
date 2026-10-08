import { describe, expect, it } from '@jest/globals';

import { weiToUSD } from './eth_usd_price_feed.js';
import {
  EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT,
  EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT_MARGIN_BPS,
  EARLY_SUBMIT_POLICY__PROVING_COST_PER_CHECKPOINT,
  type PartialEpochProofTerms,
  computePartialEpochProofProfit,
  quoteProverTip,
  submitEpochProofGas,
} from './partial_epoch_proof_profit.js';

// 10 gwei keeps every figure below on whole cents.
const GAS_PRICE_WEI = 10n * 10n ** 9n;
const USD_PER_ETH = 2_000n * 10n ** 8n;

/** 18-decimal USD from dollars and cents. */
const usd = (dollars: bigint, cents = 0n): bigint => dollars * 10n ** 18n + cents * 10n ** 16n;

// A proof of one checkpoint is 1_537_000 gas, at 10 gwei 0.01537 ETH, or 30.74 USD at 2_000 USD per ETH. Each further
// checkpoint adds 37_000 gas, or 0.74 USD.
const GAS_COST = usd(30n, 74n);
const GAS_COST_PER_CHECKPOINT = usd(0n, 74n);

const NO_TERMS: PartialEpochProofTerms = {
  minEpochProfit: 0n,
  minEpochProfitMarginBps: 0n,
  provingCostPerCheckpoint: 0n,
};

describe('computePartialEpochProofProfit', () => {
  it('is profitable exactly at the profit floor', () => {
    const input = { ...NO_TERMS, rewardValue: usd(10n), gasCostValue: usd(4n), checkpointCount: 2n };
    expect(computePartialEpochProofProfit({ ...input, minEpochProfit: usd(6n) })).toEqual({
      profit: usd(6n),
      provingCostValue: 0n,
      profitable: true,
    });
    expect(computePartialEpochProofProfit({ ...input, minEpochProfit: usd(6n) + 1n }).profitable).toBe(false);
  });

  it('charges the proving cost per checkpoint', () => {
    const result = computePartialEpochProofProfit({
      ...NO_TERMS,
      rewardValue: usd(10n),
      gasCostValue: usd(1n),
      provingCostPerCheckpoint: usd(2n),
      checkpointCount: 3n,
    });
    expect(result).toEqual({ profit: usd(3n), provingCostValue: usd(6n), profitable: true });
  });

  it('applies the margin against the reward', () => {
    // 4 of profit on 10 of reward is a 40% margin.
    const input = { ...NO_TERMS, rewardValue: usd(10n), gasCostValue: usd(6n), checkpointCount: 1n };
    expect(computePartialEpochProofProfit({ ...input, minEpochProfitMarginBps: 4_000n }).profitable).toBe(true);
    expect(computePartialEpochProofProfit({ ...input, minEpochProfitMarginBps: 4_001n }).profitable).toBe(false);
  });
});

describe('quoteProverTip', () => {
  const base = { gasPriceWei: GAS_PRICE_WEI, usdPerEth: USD_PER_ETH, subsidyForOneClaim: 0n, checkpointCount: 1n };
  /** A proof of one gas unit, so a case can price a single unit. */
  const ONE_GAS = { baseGas: 1n, gasPerCheckpoint: 0n };

  /** Whether the relayer rule accepts a lone claim with `tip`. */
  const accepts = (tip: bigint, input: Parameters<typeof quoteProverTip>[0]): boolean => {
    const gas = submitEpochProofGas(input.checkpointCount, input.submitEpochProofGasModel);
    return computePartialEpochProofProfit({
      rewardValue: tip + input.subsidyForOneClaim,
      gasCostValue: weiToUSD(gas * input.gasPriceWei, input.usdPerEth),
      checkpointCount: input.checkpointCount,
      minEpochProfit: input.minEpochProfit ?? EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT,
      minEpochProfitMarginBps: input.minEpochProfitMarginBps ?? EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT_MARGIN_BPS,
      provingCostPerCheckpoint: input.provingCostPerCheckpoint ?? EARLY_SUBMIT_POLICY__PROVING_COST_PER_CHECKPOINT,
    }).profitable;
  };

  it('asks for the gas cost when there is no subsidy and the relayer defaults apply', () => {
    expect(quoteProverTip(base)).toBe(GAS_COST);
  });

  it('charges the submission gas of every checkpoint the proof covers', () => {
    expect(quoteProverTip({ ...base, checkpointCount: 2n })).toBe(GAS_COST + GAS_COST_PER_CHECKPOINT);
    expect(quoteProverTip({ ...base, checkpointCount: 32n })).toBe(GAS_COST + 31n * GAS_COST_PER_CHECKPOINT);
  });

  it('asks for nothing when the subsidy covers the gas', () => {
    expect(quoteProverTip({ ...base, subsidyForOneClaim: GAS_COST })).toBe(0n);
    expect(quoteProverTip({ ...base, subsidyForOneClaim: usd(50n) })).toBe(0n);
  });

  it('asks for the part of the gas the subsidy does not cover', () => {
    expect(quoteProverTip({ ...base, subsidyForOneClaim: usd(1n) })).toBe(usd(29n, 74n));
  });

  it('rounds the gas cost up', () => {
    // 1 gas at 1 wei is 2_000.00000001 USD-18 units, which rounds up to 2_001.
    const input = { ...base, gasPriceWei: 1n, usdPerEth: USD_PER_ETH + 1n, submitEpochProofGasModel: ONE_GAS };
    expect(quoteProverTip(input)).toBe(2_001n);
  });

  it('adds the proving cost and the profit floor', () => {
    const input = { ...base, provingCostPerCheckpoint: usd(1n), checkpointCount: 3n, minEpochProfit: usd(0n, 50n) };
    expect(quoteProverTip(input)).toBe(GAS_COST + 2n * GAS_COST_PER_CHECKPOINT + usd(3n) + usd(0n, 50n));
  });

  it('meets the margin', () => {
    // A 50% margin needs a reward of twice the cost.
    expect(quoteProverTip({ ...base, minEpochProfitMarginBps: 5_000n })).toBe(2n * GAS_COST);
    expect(quoteProverTip({ ...base, minEpochProfitMarginBps: 5_000n, subsidyForOneClaim: GAS_COST })).toBe(GAS_COST);
  });

  it('throws when the margin is 100% or more', () => {
    expect(() => quoteProverTip({ ...base, minEpochProfitMarginBps: 10_000n })).toThrow(/no prover tip/);
  });

  it('gives the smallest tip the relayer rule accepts', () => {
    const cases = [
      base,
      { ...base, subsidyForOneClaim: usd(0n, 3n) },
      { ...base, minEpochProfitMarginBps: 3_000n },
      { ...base, minEpochProfitMarginBps: 9_999n, subsidyForOneClaim: 7n },
      { ...base, minEpochProfit: usd(2n), minEpochProfitMarginBps: 1_234n },
      { ...base, minEpochProfit: usd(0n, 1n), minEpochProfitMarginBps: 8_000n },
      { ...base, provingCostPerCheckpoint: 333n, checkpointCount: 7n, minEpochProfitMarginBps: 7n },
      { ...base, checkpointCount: 32n, minEpochProfitMarginBps: 2_500n, subsidyForOneClaim: usd(1n) },
      { ...base, gasPriceWei: 1n, usdPerEth: USD_PER_ETH + 1n, submitEpochProofGasModel: ONE_GAS },
    ];
    for (const input of cases) {
      const tip = quoteProverTip(input);
      expect(tip).toBeGreaterThan(0n);
      expect(accepts(tip, input)).toBe(true);
      expect(accepts(tip - 1n, input)).toBe(false);
    }
  });
});
