import { describe, expect, test } from '@jest/globals';
import { decodeFunctionData } from 'viem';

import { WethAdapterAbi } from '../../artifacts.js';
import { ETH } from './step.js';
import { wethSteps } from './weth.js';

describe('weth', () => {
  const weth = '0x4000000000000000000000000000000000000004';
  const steps = wethSteps({ address: '0x9000000000000000000000000000000000000001', weth });
  const recipient = '0x1111111111111111111111111111111111111111';

  test('unwrap takes WETH, pays ETH, and encodes the amount and the recipient', () => {
    const step = steps.unwrap();
    expect([step.in, step.out]).toEqual([weth, ETH]);
    expect(decodeFunctionData({ abi: WethAdapterAbi, data: step.encode({ amount: 7n, recipient }) })).toEqual({
      functionName: 'unwrapWeth',
      args: [7n, recipient],
    });
  });

  test('wrap takes ETH, pays WETH, and encodes the amount and the recipient', () => {
    const step = steps.wrap();
    expect([step.in, step.out]).toEqual([ETH, weth]);
    expect(decodeFunctionData({ abi: WethAdapterAbi, data: step.encode({ amount: 7n, recipient }) })).toEqual({
      functionName: 'wrapEth',
      args: [7n, recipient],
    });
  });
});
