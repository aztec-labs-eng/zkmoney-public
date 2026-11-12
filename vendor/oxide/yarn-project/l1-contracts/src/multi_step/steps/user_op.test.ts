import { describe, expect, test } from '@jest/globals';
import { decodeFunctionData, zeroAddress, zeroHash } from 'viem';

import { UserOpAdapterAbi } from '../../artifacts.js';
import type { PackedUserOperation } from '../../entrypoint.js';
import { userOpSteps } from './user_op.js';

describe('userOp', () => {
  const userOp = userOpSteps({ address: '0x9000000000000000000000000000000000000011' });
  const op: PackedUserOperation = {
    sender: '0x1111111111111111111111111111111111111111',
    nonce: 7n << 64n,
    initCode: '0x',
    callData: '0x1234',
    accountGasLimits: `0x${'01'.repeat(32)}`,
    preVerificationGas: 0n,
    gasFees: zeroHash,
    paymasterAndData: '0x',
    signature: '0xabcd',
  };

  test('handle submits the sender, nonce, callData, accountGasLimits and signature of the op', () => {
    const data = userOp.handle(op).encode({ amount: 0n, recipient: zeroAddress });
    expect(decodeFunctionData({ abi: UserOpAdapterAbi, data })).toEqual({
      functionName: 'handleUserOp',
      args: [
        {
          sender: op.sender,
          nonce: op.nonce,
          callData: op.callData,
          accountGasLimits: op.accountGasLimits,
          signature: op.signature,
        },
      ],
    });
  });
});
