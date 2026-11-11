import { describe, expect, it } from '@jest/globals';
import { getAddress } from 'viem';

import { computeSIPAAddress } from './sipa_factory.js';

describe('computeSIPAAddress', () => {
  // The expected addresses are what SIPAFactory.predictSIPA returned on anvil, for a factory deployed at the address.
  const factory = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';

  it.each([
    {
      args: {
        implementation: '0x1111111111111111111111111111111111111111',
        intentHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
        recoveryCommitment: '0x0033333333333333333333333333333333333333333333333333333333333333',
        rollupVersion: 679261766n,
        resweepable: true,
        forwardingTable: '0x4444444444444444444444444444444444444444',
      },
      expected: '0xBA531Aade969cE7417b054Ef3ca3F4d2d6c06031',
    },
    {
      args: {
        implementation: '0x5555555555555555555555555555555555555555',
        intentHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
        recoveryCommitment: '0x0000000000000000000000000000000000000000000000000000000000000002',
        rollupVersion: 1n,
        resweepable: false,
        forwardingTable: '0x6666666666666666666666666666666666666666',
      },
      expected: '0xbE15065cBeF73907C9eb96a9bdE1641dC9A126DC',
    },
  ] as const)('returns the address that the factory predicts', ({ args, expected }) => {
    expect(computeSIPAAddress(factory, args)).toBe(getAddress(expected));
  });
});
