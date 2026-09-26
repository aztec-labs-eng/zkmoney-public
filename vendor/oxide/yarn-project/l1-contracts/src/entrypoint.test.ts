import { describe, expect, test } from '@jest/globals';
import { getAddress } from 'viem';

import { type PackedUserOperation, packedUserOperationSchema, userOpToJson } from './entrypoint.js';

const op: PackedUserOperation = {
  sender: '0x1111111111111111111111111111111111111111',
  nonce: 7n,
  initCode: '0x',
  callData: '0xdead',
  accountGasLimits: `0x${'00'.repeat(32)}`,
  preVerificationGas: 200_000n,
  gasFees: `0x${'00'.repeat(32)}`,
  paymasterAndData: '0x',
  signature: '0x',
};

describe('packedUserOperationSchema', () => {
  test('round-trips through JSON, restoring bigints and checksumming the sender', () => {
    const parsed = packedUserOperationSchema.parse(userOpToJson(op));
    expect(parsed).toEqual({ ...op, sender: getAddress(op.sender) });
  });

  test('rejects a malformed op', () => {
    expect(() => packedUserOperationSchema.parse({ ...userOpToJson(op), nonce: 'not-a-number' })).toThrow();
    expect(() => packedUserOperationSchema.parse({ ...userOpToJson(op), accountGasLimits: '0x00' })).toThrow();
  });
});
