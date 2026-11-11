import { describe, expect, test } from '@jest/globals';
import { decodeFunctionData } from 'viem';

import { SkyConverterAdapterAbi } from '../../artifacts.js';
import { skyConverterSteps } from './sky_converter.js';

describe('skyConverter', () => {
  const dai = '0x1000000000000000000000000000000000000001';
  const usds = '0x5000000000000000000000000000000000000005';
  const skyConverter = skyConverterSteps({ address: '0x9000000000000000000000000000000000000001', dai, usds });
  const recipient = '0x1111111111111111111111111111111111111111';

  test('daiToUsds takes DAI, pays USDS, and encodes the amount and the recipient', () => {
    const step = skyConverter.daiToUsds();
    expect([step.in, step.out]).toEqual([dai, usds]);
    expect(decodeFunctionData({ abi: SkyConverterAdapterAbi, data: step.encode({ amount: 7n, recipient }) })).toEqual({
      functionName: 'daiToUsds',
      args: [7n, recipient],
    });
  });

  test('usdsToDai takes USDS, pays DAI, and encodes the amount and the recipient', () => {
    const step = skyConverter.usdsToDai();
    expect([step.in, step.out]).toEqual([usds, dai]);
    expect(decodeFunctionData({ abi: SkyConverterAdapterAbi, data: step.encode({ amount: 7n, recipient }) })).toEqual({
      functionName: 'usdsToDai',
      args: [7n, recipient],
    });
  });
});
