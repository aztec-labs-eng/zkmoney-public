import { describe, expect, it } from '@jest/globals';

import { MAX_ITEMS_PER_BATCH, selectProfitableBatch } from './batch_selection.js';
import { L1_TRANSACTION_GAS_CAP } from './types.js';

// Minimal stand-in for a batch candidate — selection only reads the tip (via tipOf) and otherwise treats
// candidates opaquely. `id` captures submission order so tests can assert it is preserved.
interface Job {
  tip: bigint;
  id: number;
}

const tipOf = (job: Job) => job.tip;

// `n` jobs whose tips are assigned by `tip(i)` (default 0); `id` is the creation (submission) index.
const jobs = (n: number, tip: (i: number) => bigint = () => 0n): Job[] =>
  Array.from({ length: n }, (_, i) => ({ tip: tip(i), id: i }));

describe('selectProfitableBatch', () => {
  // Synthetic gas model: base overhead + a flat per-item cost, matching the real quote's shape.
  const BASE_GAS = 200_000n;
  const PER_ITEM_GAS = 150_000n;
  const gasQuote = (batch: readonly Job[]) =>
    Promise.resolve({ totalGas: BASE_GAS + PER_ITEM_GAS * BigInt(batch.length), subsidy: 0n });

  // Price gas at 1 per unit, so profit is just tips minus gas.
  const profitOf = (gas: bigint, reward: bigint) => Promise.resolve(reward - gas);
  // Profit is not modelled: nothing is ever trimmed for profitability, only for gas.
  const unpriced = () => Promise.resolve(0n);

  it('never selects a batch whose total gas exceeds the tx gas cap', async () => {
    // Items dear enough that the gas cap bites well before the item cap does.
    const EXPENSIVE_ITEM_GAS = 1_000_000n;
    const expensive = (batch: readonly Job[]) =>
      Promise.resolve({ totalGas: BASE_GAS + EXPENSIVE_ITEM_GAS * BigInt(batch.length), subsidy: 0n });

    const { batch, quote } = await selectProfitableBatch(jobs(500), expensive, {
      tipOf,
      profitOf: unpriced,
      minProfit: 0n,
    });

    expect(batch.length).toBeLessThan(MAX_ITEMS_PER_BATCH);
    expect(quote.totalGas).toBeLessThanOrEqual(L1_TRANSACTION_GAS_CAP);
    // Maximal: one more item would cross the cap.
    expect(BASE_GAS + EXPENSIVE_ITEM_GAS * BigInt(batch.length + 1)).toBeGreaterThan(L1_TRANSACTION_GAS_CAP);
  });

  it('caps the batch at the item limit when gas is not the binding constraint', async () => {
    const cheap = (batch: readonly Job[]) =>
      Promise.resolve({ totalGas: BASE_GAS + 1_000n * BigInt(batch.length), subsidy: 0n });

    const { batch, quote } = await selectProfitableBatch(jobs(500), cheap, {
      tipOf,
      profitOf: unpriced,
      minProfit: 0n,
    });

    expect(batch.length).toBe(MAX_ITEMS_PER_BATCH);
    expect(quote.totalGas).toBeLessThanOrEqual(L1_TRANSACTION_GAS_CAP);
  });

  it('takes every candidate when there are fewer than the item limit', async () => {
    const cheap = (batch: readonly Job[]) =>
      Promise.resolve({ totalGas: BASE_GAS + 1_000n * BigInt(batch.length), subsidy: 0n });

    const { batch } = await selectProfitableBatch(jobs(MAX_ITEMS_PER_BATCH - 1), cheap, {
      tipOf,
      profitOf: unpriced,
      minProfit: 0n,
    });

    expect(batch.length).toBe(MAX_ITEMS_PER_BATCH - 1);
  });

  it('drops a candidate whose own tip does not cover its own marginal gas', async () => {
    // One fat tip beside three below the 150k marginal cost. All four clear a zero floor together (profit 1.5M),
    // but the fat one alone is worth more (1.65M), so the dust must not ride along.
    const fatPlusDust = [{ tip: 2_000_000n, id: 0 }, ...jobs(3, () => 100_000n).map(j => ({ ...j, id: j.id + 1 }))];

    const { batch } = await selectProfitableBatch(fatPlusDust, gasQuote, {
      tipOf,
      profitOf,
      minProfit: 0n,
    });

    expect(batch.map(job => job.id)).toEqual([0]);
  });

  it('keeps every candidate that pays for its own marginal gas', async () => {
    const { batch } = await selectProfitableBatch(
      jobs(4, () => 200_000n),
      gasQuote,
      { tipOf, profitOf, minProfit: 0n },
    );

    expect(batch).toHaveLength(4);
  });

  it('returns an empty batch when no sub-batch clears the profit floor', async () => {
    const { batch, quote } = await selectProfitableBatch(
      jobs(4, () => 1n),
      gasQuote,
      { tipOf, profitOf, minProfit: 0n },
    );

    expect(batch).toEqual([]);
    expect(quote).toEqual({ totalGas: 0n, subsidy: 0n });
  });

  it('returns an empty batch when the best batch clears the floor but misses the margin floor', async () => {
    // Four equal tips: the full batch profits 3.2M on a 4M reward, an 8000bps margin. Nothing reaches 9000bps,
    // since dropping items only amortizes the base gas over fewer of them.
    const equalTips = jobs(4, () => 1_000_000n);
    const opts = { tipOf, profitOf, minProfit: 0n };

    const withoutMargin = await selectProfitableBatch(equalTips, gasQuote, opts);
    expect(withoutMargin.batch).toHaveLength(4);

    const withMargin = await selectProfitableBatch(equalTips, gasQuote, { ...opts, minProfitMarginBps: 9_000n });
    expect(withMargin.batch).toEqual([]);
  });

  it('keeps equal-tip jobs in submission order (stable sort), so an earlier submission processes first', async () => {
    // Two tip levels interleaved; `id` is the submission order. Equal-tip jobs must not be reordered.
    const candidates: Job[] = [
      { tip: 5n, id: 0 },
      { tip: 3n, id: 1 },
      { tip: 5n, id: 2 },
      { tip: 3n, id: 3 },
      { tip: 5n, id: 4 },
    ];

    const { batch } = await selectProfitableBatch(candidates, gasQuote, {
      tipOf,
      profitOf: unpriced,
      minProfit: 0n,
    });

    // Sorted by tip descending, but within each tip the original submission order is preserved: the tip-5
    // group (0, 2, 4) ahead of the tip-3 group (1, 3), each still in submission order.
    expect(batch.map(job => job.id)).toEqual([0, 2, 4, 1, 3]);
  });

  it('returns the selected batch alongside its final quote, so callers need not re-quote', async () => {
    const { batch, quote } = await selectProfitableBatch(jobs(3), gasQuote, {
      tipOf,
      profitOf: unpriced,
      minProfit: 0n,
    });

    expect(quote).toEqual(await gasQuote(batch));
  });
});
