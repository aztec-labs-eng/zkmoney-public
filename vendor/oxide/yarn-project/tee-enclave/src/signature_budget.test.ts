import { describe, expect, it, jest } from '@jest/globals';
import { Worker } from 'node:worker_threads';

import { MAX_SIGNATURES_PER_KEY, SignatureBudget } from './signature_budget.js';

const TEST_WORKER = new URL('./testing/budget_test_worker.ts', import.meta.url);

describe('SignatureBudget', () => {
  it('draws the effective limit within the jitter window and never above the limit', () => {
    for (let i = 0; i < 200; i++) {
      const { effectiveLimit } = SignatureBudget.create(1000);
      expect(effectiveLimit).toBeGreaterThanOrEqual(900);
      expect(effectiveLimit).toBeLessThanOrEqual(1000);
    }
    expect(SignatureBudget.create().effectiveLimit).toBeLessThanOrEqual(MAX_SIGNATURES_PER_KEY);
  });

  it('allows exactly the limit and then throws, clamping remaining at zero', () => {
    const budget = new SignatureBudget(3);
    expect(budget.remaining()).toBe(3);
    budget.consume();
    budget.consume();
    budget.consume();
    expect(budget.remaining()).toBe(0);
    expect(() => budget.consume()).toThrow('signature budget exhausted');
    expect(() => budget.consume()).toThrow('signature budget exhausted');
    expect(budget.remaining()).toBe(0);
  });

  it('fires onExhausted exactly once, on the first refusal', () => {
    const onExhausted = jest.fn();
    const budget = new SignatureBudget(2, undefined, onExhausted);
    budget.consume();
    budget.consume();
    expect(onExhausted).not.toHaveBeenCalled();
    expect(() => budget.consume()).toThrow();
    expect(() => budget.consume()).toThrow();
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('shares the counter through the workerData structured clone', () => {
    const budget = new SignatureBudget(5);
    const clone = SignatureBudget.fromWorkerData(structuredClone(budget.toWorkerData()));
    clone.consume();
    clone.consume();
    expect(budget.remaining()).toBe(3);
    budget.consume();
    expect(clone.remaining()).toBe(2);
  });

  it('never exceeds the limit under cross-thread contention', async () => {
    const effectiveLimit = 1000;
    const budget = new SignatureBudget(effectiveLimit);
    const workers = 4;
    const attempts = 400; // 4 × 400 = 1600 attempts against a budget of 1000
    const successes = await Promise.all(
      Array.from({ length: workers }, () => {
        const worker = new Worker(TEST_WORKER, { workerData: { budget: budget.toWorkerData(), attempts } });
        return new Promise<number>((resolve, reject) => {
          worker.once('message', resolve);
          worker.once('error', reject);
        });
      }),
    );
    expect(successes.reduce((a, b) => a + b, 0)).toBe(effectiveLimit);
    expect(budget.remaining()).toBe(0);
  });
});
