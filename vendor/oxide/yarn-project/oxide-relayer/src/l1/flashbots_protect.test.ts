import { describe, expect, it } from '@jest/globals';

import { DEFAULT_FLASHBOTS_BLOCK_RANGE, assertNotFlashbots, protectEndpoints } from './flashbots_protect.js';

const MAINNET = 1;
const SEPOLIA = 11155111;
const ANVIL = 31337;

describe('protectEndpoints', () => {
  it('submits mainnet through Protect in fast mode with the block range in the URL', () => {
    expect(protectEndpoints(MAINNET, DEFAULT_FLASHBOTS_BLOCK_RANGE)).toEqual({
      rpcUrl: 'https://rpc.flashbots.net/fast?blockRange=5&originId=zk_money_relayer',
      txStatusUrl: 'https://protect.flashbots.net/tx/',
    });
    expect(protectEndpoints(MAINNET, 2)).toMatchObject({
      rpcUrl: 'https://rpc.flashbots.net/fast?blockRange=2&originId=zk_money_relayer',
    });
  });

  // Sepolia validators build blocks locally (150 consecutive blocks checked 2026-09), so Protect gets nothing
  // included there: it submits through its read RPC.
  it('submits Sepolia and a local anvil through their read RPC', () => {
    expect(protectEndpoints(SEPOLIA, DEFAULT_FLASHBOTS_BLOCK_RANGE)).toBeUndefined();
    expect(protectEndpoints(ANVIL, DEFAULT_FLASHBOTS_BLOCK_RANGE)).toBeUndefined();
  });

  it('rejects a non-positive or non-integer block range on every chain', () => {
    for (const chainId of [MAINNET, SEPOLIA, ANVIL]) {
      expect(() => protectEndpoints(chainId, 0)).toThrow(/block range/);
      expect(() => protectEndpoints(chainId, 2.5)).toThrow(/block range/);
    }
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
