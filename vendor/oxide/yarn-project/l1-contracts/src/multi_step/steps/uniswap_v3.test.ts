import { describe, expect, test } from '@jest/globals';
import { concatHex, decodeFunctionData, zeroAddress } from 'viem';

import { UniswapV3AdapterAbi } from '../../artifacts.js';
import { uniswapV3Steps } from './uniswap_v3.js';

describe('uniswapV3', () => {
  const uniswapV3 = uniswapV3Steps({ address: '0x9000000000000000000000000000000000000001' });
  const a = '0x1111111111111111111111111111111111111111';
  const b = '0x2222222222222222222222222222222222222222';
  const recipient = '0x1111111111111111111111111111111111111111';
  const POOL_FEE_500 = '0x0001f4';

  test('exactIn packs the tokens and the 3-byte fees into the path', () => {
    const step = uniswapV3.exactIn({ path: { tokenIn: a, hops: [{ fee: 500, tokenOut: b }] }, minOut: 5n });
    expect([step.in, step.out]).toEqual([a, b]);
    expect(decodeFunctionData({ abi: UniswapV3AdapterAbi, data: step.encode({ amount: 7n, recipient }) })).toEqual({
      functionName: 'uniswapV3ExactIn',
      args: [concatHex([a, POOL_FEE_500, b]), 7n, 5n, recipient],
    });
  });

  test('exactOut reverses the path and spends at most the amount', () => {
    const step = uniswapV3.exactOut({
      path: { tokenIn: a, hops: [{ fee: 500, tokenOut: b }] },
      amountOut: 100n,
      leftoverRecipient: '0x2222222222222222222222222222222222222222',
    });
    expect([step.in, step.out]).toEqual([a, b]);
    expect(decodeFunctionData({ abi: UniswapV3AdapterAbi, data: step.encode({ amount: 7n, recipient }) })).toEqual({
      functionName: 'uniswapV3ExactOut',
      args: [concatHex([b, POOL_FEE_500, a]), 100n, 7n, recipient, '0x2222222222222222222222222222222222222222'],
    });
  });

  test('exactOut refuses a zero leftover recipient', () => {
    const path = { tokenIn: a, hops: [{ fee: 500, tokenOut: b }] } as const;
    expect(() => uniswapV3.exactOut({ path, amountOut: 1n, leftoverRecipient: zeroAddress })).toThrow(/must not be/);
  });
});
