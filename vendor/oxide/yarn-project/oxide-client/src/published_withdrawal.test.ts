import { EthAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { TxHash } from '@aztec/stdlib/tx';

import { getUserPayloadHash } from '@oxide/oxide-lib/content_hash.js';
import { encodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal.js';

import { describe, expect, it } from '@jest/globals';

import { PermanentError } from './errors.js';
import { type PublishedWithdrawal, plainWithdrawalUserPayload } from './published_withdrawal.js';

function published(executor: EthAddress, overrides: Partial<PublishedWithdrawal> = {}): PublishedWithdrawal {
  const recipient = EthAddress.random();
  const relayerTip = 7n;
  return {
    executor,
    userPayloadHash: getUserPayloadHash(encodePlainWithdrawalPayload({ recipient, relayerTip })),
    amount: 100n,
    proverTip: 1n,
    randomness: Fr.random(),
    recipient,
    relayerTip,
    signature: { sLo: Fr.ZERO, sHi: Fr.ZERO, rLo: Fr.ZERO, rHi: Fr.ZERO },
    ...overrides,
  };
}

describe('plainWithdrawalUserPayload', () => {
  const txHash = TxHash.random();

  it('rebuilds the payload that the withdrawal commits to', () => {
    const executor = EthAddress.random();
    const withdrawal = published(executor);

    const payload = plainWithdrawalUserPayload(withdrawal, executor, txHash);

    expect(payload).toEqual(
      encodePlainWithdrawalPayload({ recipient: withdrawal.recipient, relayerTip: withdrawal.relayerTip }),
    );
  });

  it('rejects a withdrawal through a different executor', () => {
    expect(() => plainWithdrawalUserPayload(published(EthAddress.random()), EthAddress.random(), txHash)).toThrow(
      PermanentError,
    );
  });

  it('rejects a published recipient that does not match the payload hash', () => {
    const executor = EthAddress.random();
    const withdrawal = published(executor, { recipient: EthAddress.random() });

    expect(() => plainWithdrawalUserPayload(withdrawal, executor, txHash)).toThrow(/does not match/);
  });
});
