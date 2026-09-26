import { Fr } from '@aztec/foundation/curves/bn254';
import { EthAddress } from '@aztec/foundation/eth-address';

import { expect, test } from '@jest/globals';

import { deriveRecoveryCommitment } from './sipa_recovery.js';

test('the recovery commitment matches the resolver circuit fixture', () => {
  const shared = new Fr(0x00bbabe215b1c7a1ccf8abc5196bd9bcd584403fcaad9322edda988f9899e7fbn);
  const account = EthAddress.fromString('0x1111111111111111111111111111111111111111');
  expect(deriveRecoveryCommitment(shared, account).toString()).toBe(
    '0x00c80adf676663c935a008fdc96572839c4816ea6564c2e7cb71f9bd87498cf3',
  );
  expect(deriveRecoveryCommitment(shared, EthAddress.ZERO)).not.toEqual(deriveRecoveryCommitment(shared, account));
});
