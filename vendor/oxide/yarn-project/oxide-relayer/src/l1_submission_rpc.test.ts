import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_FLASHBOTS_BLOCK_RANGE,
  PUBLIC_MEMPOOL_TIMEOUTS,
  assertNotFlashbots,
  resolveSubmission,
} from './l1_submission_rpc.js';

const MAINNET = 1;
const SEPOLIA = 11155111;
const ANVIL = 31337;

describe('resolveSubmission', () => {
  // The timeouts are the window plus the 4-slot missed-slot budget: (5 + 4) and (2 + 4) slots of 12s.
  it('submits mainnet through Protect in fast mode with the block range in the URL and the expiry', () => {
    expect(resolveSubmission(MAINNET, DEFAULT_FLASHBOTS_BLOCK_RANGE)).toEqual({
      protect: {
        submissionL1RpcUrl: 'https://rpc.flashbots.net/fast?blockRange=5&originId=zk_money_relayer',
        protectTxStatusUrl: 'https://protect.flashbots.net/tx/',
      },
      txTimeoutMs: 108_000,
      stallTimeMs: 108_000,
    });
    expect(resolveSubmission(MAINNET, 2)).toMatchObject({
      protect: { submissionL1RpcUrl: 'https://rpc.flashbots.net/fast?blockRange=2&originId=zk_money_relayer' },
      txTimeoutMs: 72_000,
      stallTimeMs: 72_000,
    });
  });

  // Sepolia validators build blocks locally (150 consecutive blocks checked 2026-09), so Protect gets nothing
  // included there: it submits through its read RPC on the same expiry as mainnet.
  it('submits Sepolia through its read RPC with the block window as its expiry', () => {
    expect(resolveSubmission(SEPOLIA, DEFAULT_FLASHBOTS_BLOCK_RANGE)).toEqual({
      txTimeoutMs: 108_000,
      stallTimeMs: 108_000,
    });
    expect(resolveSubmission(SEPOLIA, 2)).toEqual({ txTimeoutMs: 72_000, stallTimeMs: 72_000 });
  });

  it('rejects a non-positive or non-integer block range on a 12s-slot chain', () => {
    for (const chainId of [MAINNET, SEPOLIA]) {
      expect(() => resolveSubmission(chainId, 0)).toThrow(/block range/);
      expect(() => resolveSubmission(chainId, 2.5)).toThrow(/block range/);
    }
  });

  it('submits a chain with no 12s slots through its read RPC with the static dev/test timeouts', () => {
    expect(resolveSubmission(ANVIL, 5)).toBe(PUBLIC_MEMPOOL_TIMEOUTS);
  });
});

describe('assertNotFlashbots', () => {
  it('rejects a Flashbots read RPC on any chain and says submission needs no configuration', () => {
    expect(() => assertNotFlashbots('https://rpc.flashbots.net')).toThrow(/not an L1 read RPC/);
    expect(() => assertNotFlashbots('https://rpc.flashbots.net/fast')).toThrow(/goes to Protect on its own/);
    expect(() => assertNotFlashbots('https://rpc.flashbots.net/fast?blockRange=5')).toThrow(/not an L1 read RPC/);
  });

  it('rejects the per-chain Protect hosts, not just the mainnet one', () => {
    expect(() => assertNotFlashbots('https://rpc-sepolia.flashbots.net')).toThrow(/not an L1 read RPC/);
  });

  it('accepts a normal RPC and rejects an unparsable one', () => {
    expect(() => assertNotFlashbots('https://eth-mainnet.example.com/v2/key')).not.toThrow();
    expect(() => assertNotFlashbots('http://127.0.0.1:8545')).not.toThrow();
    expect(() => assertNotFlashbots('not a url')).toThrow(/valid URL/);
  });
});
