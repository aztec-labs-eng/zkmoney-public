import { describe, expect, test } from '@jest/globals';
import { decodeFunctionData, zeroAddress } from 'viem';

import { AcrossAdapterAbi } from '../../artifacts.js';
import { acrossSteps } from './across.js';

describe('across', () => {
  const across = acrossSteps({ address: '0x9000000000000000000000000000000000000001' });
  const deposit = {
    inputToken: '0x3000000000000000000000000000000000000003',
    destinationChainId: 56n,
    outputToken: '0x3000000000000000000000000000000000000056',
    outputDecimals: 18,
    recipient: '0x1111111111111111111111111111111111111111',
    fee: 1_000000n,
    fillDeadlineOffset: 6 * 3600,
  } as const;
  const refundTo = '0x2222222222222222222222222222222222222222';

  test('deposit encodes the amount and maps refundTo to the depositor', () => {
    const data = across.deposit({ ...deposit, refundTo }).encode({ amount: 7n, recipient: zeroAddress });
    expect(decodeFunctionData({ abi: AcrossAdapterAbi, data })).toEqual({
      functionName: 'acrossDeposit',
      args: [{ ...deposit, depositor: refundTo, amount: 7n }],
    });
  });

  test('depositWithMessage encodes the message too', () => {
    const data = across
      .depositWithMessage({ ...deposit, refundTo, message: '0xbeef' })
      .encode({ amount: 7n, recipient: zeroAddress });
    expect(decodeFunctionData({ abi: AcrossAdapterAbi, data })).toEqual({
      functionName: 'acrossDepositWithMessage',
      args: [{ ...deposit, depositor: refundTo, amount: 7n, message: '0xbeef' }],
    });
  });
});
