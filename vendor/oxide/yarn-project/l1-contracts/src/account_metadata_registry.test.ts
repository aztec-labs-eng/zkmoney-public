import { describe, expect, it } from '@jest/globals';
import { keccak256, toHex, zeroHash } from 'viem';

import { encodeUserRecordMetadata, userRecordStateHash } from './account_metadata_registry.js';

const RECORD = {
  l2Address: toHex(11n, { size: 32 }),
  rollupVersion: 7n,
  publicKey: {
    x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
    y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  },
  resolverOperator: '0x1111111111111111111111111111111111111111',
} as const;

// Keep the golden value in sync with l1-contracts/test/periphery/registration/MetadataStateHash.t.sol.
describe('user record state hash', () => {
  it('hashes the abi-encoded record, and zero for an absent record', () => {
    expect(userRecordStateHash(RECORD)).toBe('0xecc754413e4e971558638c11f2b4490e9c10d4d6488c247a98555a536fb0c95d');
    expect(userRecordStateHash(RECORD)).toBe(keccak256(encodeUserRecordMetadata(RECORD)));
    expect(userRecordStateHash()).toBe(zeroHash);
  });
});
