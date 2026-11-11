import { describe, expect, test } from '@jest/globals';
import { decodeFunctionData } from 'viem';

import { CurveAdapterAbi } from '../../artifacts.js';
import { curveSteps } from './curve.js';

describe('curve.exchange', () => {
  const curve = curveSteps({ address: '0x9000000000000000000000000000000000000001' });

  const dai = '0x1111111111111111111111111111111111111111' as const;
  const usdc = '0x2222222222222222222222222222222222222222' as const;
  const usdt = '0x3333333333333333333333333333333333333333' as const;
  const pool = { address: '0x9000000000000000000000000000000000000001', coins: [dai, usdc, usdt] } as const;

  test('encodes the coin indexes of the pool, the amount, the bound and the recipient', () => {
    const recipient = '0x1111111111111111111111111111111111111111';
    const data = curve.exchange({ pool, from: dai, to: usdt, minOut: 5n }).encode({ amount: 7n, recipient });
    expect(decodeFunctionData({ abi: CurveAdapterAbi, data })).toEqual({
      functionName: 'curveExchange',
      args: [pool.address, 0n, 2n, 7n, 5n, recipient],
    });
  });

  test('refuses a coin that is not in the pool', () => {
    const weth = '0x4444444444444444444444444444444444444444' as const;
    // @ts-expect-error the compiler refuses it too
    expect(() => curve.exchange({ pool, from: dai, to: weth, minOut: 1n })).toThrow(/not a coin/);
  });

  test('refuses the same coin twice', () => {
    expect(() => curve.exchange({ pool, from: dai, to: dai, minOut: 1n })).toThrow(/same coin/);
  });
});
