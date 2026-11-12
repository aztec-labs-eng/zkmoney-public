import { describe, expect, test } from '@jest/globals';
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, zeroAddress } from 'viem';

import { CheckAdapterAbi } from '../../artifacts.js';
import { checkSteps } from './check.js';

describe('check', () => {
  const adapter = '0x9000000000000000000000000000000000000001';
  const token = '0x1000000000000000000000000000000000000001';
  const holder = '0x1111111111111111111111111111111111111111';
  const check = checkSteps({ address: adapter });
  const read = { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] } as const;
  const args = [
    token,
    encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [holder] }),
    keccak256(encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: 7n })),
  ];

  test('holds encodes the read and the hash of its encoded result', () => {
    const step = check.holds(read, 7n);
    expect(
      decodeFunctionData({ abi: CheckAdapterAbi, data: step.encode({ amount: 0n, recipient: zeroAddress }) }),
    ).toEqual({
      functionName: 'check',
      args,
    });
  });
});
