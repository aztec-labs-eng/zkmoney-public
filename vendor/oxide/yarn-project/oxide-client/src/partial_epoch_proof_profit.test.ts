import { describe, expect, it } from '@jest/globals';

import { weiToUSD } from './eth_usd_price_feed.js';
import {
  EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT,
  EARLY_SUBMIT_POLICY__MIN_EPOCH_PROFIT_MARGIN_BPS,
  EARLY_SUBMIT_POLICY__PROVING_COST_PER_CHECKPOINT,
  PAR_TOKEN_PRICE,
  PORTAL__FIRST_PROVER_CAPTURE_GAS,
  type PartialEpochProofTerms,
  type PortalTokenPrice,
  claimProverTipsGas,
  computePartialEpochProofProfit,
  quoteProverTip,
  submitEpochProofGas,
} from './partial_epoch_proof_profit.js';

// 10 gwei keeps every figure below on whole cents.
const GAS_PRICE_WEI = 10n * 10n ** 9n;
const USD_PER_ETH = 2_000n * 10n ** 8n;

/** 18-decimal USD from dollars and cents. */
const usd = (dollars: bigint, cents = 0n): bigint => dollars * 10n ** 18n + cents * 10n ** 16n;

// A proof of one checkpoint is 1_537_000 gas with its first-prover capture, and the claim transaction that collects
// one tip is 190_000 gas. Together they are 1_727_000 gas, at 10 gwei 0.01727 ETH, or 34.54 USD at 2_000 USD per ETH.
// Each further checkpoint adds 37_000 gas, or 0.74 USD.
const GAS_COST = usd(34n, 54n);
const GAS_COST_PER_CHECKPOINT = usd(0n, 74n);
// The claim transaction alone: 190_000 gas, or 3.80 USD.
const CLAIM_GAS_COST = usd(3n, 80n);

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

describe('claimProverTipsGas', () => {
  const model = { baseGas: 60_000n, gasPerClaim: 130_000n };

  it('charges one transaction and each claim in it', () => {
    expect(claimProverTipsGas(1n, model)).toBe(190_000n);
    expect(claimProverTipsGas(3n, model)).toBe(450_000n);
  });

  it('charges nothing when there is no claim to send', () => {
    expect(claimProverTipsGas(0n, model)).toBe(0n);
  });
});

describe('quoteProverTip', () => {
  const base = { gasPriceWei: GAS_PRICE_WEI, usdPerEth: USD_PER_ETH, subsidyForOneClaim: 0n, checkpointCount: 1n };
  /** A proof of one gas unit and a claim of none, so a case can price a single unit. */
  const ONE_GAS = { submitEpochProofGasModel: { baseGas: 1n, gasPerCheckpoint: 0n }, firstProverCaptureGas: 0n };
  const NO_CLAIM_GAS = { claimProverTipsGasModel: { baseGas: 0n, gasPerClaim: 0n } };

  /** Whether the relayer rule accepts a lone claim with `tip`. */
  const accepts = (tip: bigint, input: Parameters<typeof quoteProverTip>[0]): boolean => {
    const gas =
      submitEpochProofGas(input.checkpointCount, input.submitEpochProofGasModel) +
      (input.firstProverCaptureGas ?? PORTAL__FIRST_PROVER_CAPTURE_GAS) +
      claimProverTipsGas(1n, input.claimProverTipsGasModel);
    // The relayer values the tip and the subsidy together, rounding down.
    const { usdPerToken, decimals } = input.tokenPrice ?? PAR_TOKEN_PRICE;
    return computePartialEpochProofProfit({
      rewardValue: ((tip + input.subsidyForOneClaim) * usdPerToken) / 10n ** BigInt(decimals),
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

  it('charges the claim transaction that collects the tip', () => {
    expect(quoteProverTip({ ...base, ...NO_CLAIM_GAS })).toBe(GAS_COST - CLAIM_GAS_COST);
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
    expect(quoteProverTip({ ...base, subsidyForOneClaim: usd(1n) })).toBe(usd(33n, 54n));
  });

  it('rounds the gas cost up', () => {
    // 1 gas at 1 wei is 2_000.00000001 USD-18 units, which rounds up to 2_001.
    const input = { ...base, ...ONE_GAS, ...NO_CLAIM_GAS, gasPriceWei: 1n, usdPerEth: USD_PER_ETH + 1n };
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

  describe('with a token that is not worth one USD', () => {
    // A vault share worth 1.11 USD, as sUSDS is when the vault converts one share to 1.11 USDS.
    const SHARE: PortalTokenPrice = { usdPerToken: usd(1n, 11n), decimals: 18 };
    // A USD token of 6 decimals.
    const SIX_DECIMALS: PortalTokenPrice = { usdPerToken: usd(1n), decimals: 6 };

    it('quotes the same tip as before for a token at par', () => {
      expect(quoteProverTip({ ...base, tokenPrice: PAR_TOKEN_PRICE })).toBe(quoteProverTip(base));
    });

    it('asks for fewer tokens of a token worth more than one USD', () => {
      // 34.54 USD at 1.11 USD a share is 31.117117... shares, rounded up.
      expect(quoteProverTip({ ...base, tokenPrice: SHARE })).toBe(31_117_117_117_117_117_118n);
    });

    it('takes the subsidy off in tokens', () => {
      // The subsidy is in shares too: 1.00 share of subsidy leaves 30.117117... shares to tip.
      expect(quoteProverTip({ ...base, tokenPrice: SHARE, subsidyForOneClaim: usd(1n) })).toBe(
        31_117_117_117_117_117_118n - usd(1n),
      );
    });

    it('scales the tip to the decimals of the token', () => {
      // 34.54 USD in a 6-decimal USD token.
      expect(quoteProverTip({ ...base, tokenPrice: SIX_DECIMALS })).toBe(34_540_000n);
    });

    it('gives the smallest tip the relayer rule accepts', () => {
      const cases = [
        { ...base, tokenPrice: SHARE },
        { ...base, tokenPrice: SHARE, subsidyForOneClaim: usd(1n, 1n), minEpochProfitMarginBps: 1_234n },
        { ...base, tokenPrice: SIX_DECIMALS, minEpochProfit: usd(0n, 1n) },
        { ...base, tokenPrice: { usdPerToken: usd(0n, 99n) + 7n, decimals: 6 }, subsidyForOneClaim: 3n },
      ];
      for (const input of cases) {
        const tip = quoteProverTip(input);
        expect(tip).toBeGreaterThan(0n);
        expect(accepts(tip, input)).toBe(true);
        expect(accepts(tip - 1n, input)).toBe(false);
      }
    });
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
      { ...base, ...ONE_GAS, ...NO_CLAIM_GAS, gasPriceWei: 1n, usdPerEth: USD_PER_ETH + 1n },
    ];
    for (const input of cases) {
      const tip = quoteProverTip(input);
      expect(tip).toBeGreaterThan(0n);
      expect(accepts(tip, input)).toBe(true);
      expect(accepts(tip - 1n, input)).toBe(false);
    }
  });
});
