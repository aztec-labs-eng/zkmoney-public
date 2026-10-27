import { Fr } from '@aztec-labs/aztec.js/fields';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import { type OxideTokenImmutables, computeTokenImmutablesHash } from './token_immutables.js';

const IMMUTABLES: OxideTokenImmutables = {
  portal: EthAddress.fromField(new Fr(1)),
  teeRegistry: EthAddress.fromField(new Fr(2)),
  name: 'OxideToken',
  symbol: 'ATKN',
  decimals: 18,
  maxNoteAmount: 3n,
};

describe('token immutables', () => {
  it.each(['name', 'symbol'] as const)('rejects a %s longer than 31 bytes', async key => {
    await expect(computeTokenImmutablesHash({ ...IMMUTABLES, [key]: 'x'.repeat(32) })).rejects.toThrow('more than 31');
  });

  it('rejects decimals outside a u8', async () => {
    await expect(computeTokenImmutablesHash({ ...IMMUTABLES, decimals: 256 })).rejects.toThrow(
      'Token decimals 256 do not fit in a u8',
    );
  });

  it('rejects a max note amount outside a u128', async () => {
    await expect(computeTokenImmutablesHash({ ...IMMUTABLES, maxNoteAmount: 1n << 128n })).rejects.toThrow(
      'does not fit in a u128',
    );
  });

  it('accepts the largest value each field can hold', async () => {
    const largest = {
      ...IMMUTABLES,
      name: 'x'.repeat(31),
      symbol: 'x'.repeat(31),
      decimals: 255,
      maxNoteAmount: (1n << 128n) - 1n,
    };
    await expect(computeTokenImmutablesHash(largest)).resolves.toBeInstanceOf(Fr);
  });
});
