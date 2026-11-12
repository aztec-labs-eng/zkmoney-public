import { describe, expect, test } from '@jest/globals';
import { decodeFunctionData, pad, zeroAddress } from 'viem';

import { CctpAdapterAbi } from '../../artifacts.js';
import { type CctpDeposit, cctpSteps } from './cctp.js';

describe('cctp', () => {
  const cctp = cctpSteps({
    address: '0x9000000000000000000000000000000000000001',
    usdc: '0x2000000000000000000000000000000000000002',
  });
  const recipient = '0x1111111111111111111111111111111111111111';
  const deposit = {
    destinationDomain: 6,
    recipient,
    maxFee: 1_000000n,
    minFinalityThreshold: 1000,
  } satisfies CctpDeposit;

  test('deposit pads the recipient to 32 bytes', () => {
    const data = cctp.deposit(deposit).encode({ amount: 7n, recipient: zeroAddress });
    expect(decodeFunctionData({ abi: CctpAdapterAbi, data })).toEqual({
      functionName: 'cctpDeposit',
      args: [7n, 6, pad(recipient, { size: 32 }), 1_000000n, 1000],
    });
  });

  test('depositWithHook makes the target the recipient and the only caller, and passes its calldata', () => {
    const { recipient: _, ...withoutRecipient } = deposit;
    const target = '0x2222222222222222222222222222222222222222';
    const data = cctp
      .depositWithHook({ ...withoutRecipient, hook: { target, calldata: '0xbeef' } })
      .encode({ amount: 7n, recipient: zeroAddress });
    expect(decodeFunctionData({ abi: CctpAdapterAbi, data })).toEqual({
      functionName: 'cctpDepositWithHook',
      args: [7n, 6, pad(target, { size: 32 }), pad(target, { size: 32 }), 1_000000n, 1000, '0xbeef'],
    });
  });
});
