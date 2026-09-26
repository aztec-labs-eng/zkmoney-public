import { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';

import { getUserPayloadHash } from '@oxide/oxide-lib/content_hash.js';
import { encodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal.js';
import type { OutboxWithdrawal } from '@oxide/oxide-lib/types.js';

import { describe, expect, it } from '@jest/globals';

import { buildPlainExecutorUserPayloadCapsule, buildPlainExecutorUserPayloadCapsules } from './capsules.js';

function withdrawal(executor: EthAddress, userPayload: Buffer): OutboxWithdrawal {
  return {
    executor,
    userPayloadHash: getUserPayloadHash(userPayload),
    amount: 100n,
    proverTip: 1n,
    randomness: Fr.random(),
  };
}

describe('buildPlainExecutorUserPayloadCapsules', () => {
  it('gives each plain withdrawal the payload that its hash commits to, in any order', async () => {
    const token = await AztecAddress.random();
    const executor = EthAddress.random();
    const first = { recipient: EthAddress.random(), relayerTip: 3n };
    const second = { recipient: EthAddress.random(), relayerTip: 4n };
    const firstPayload = encodePlainWithdrawalPayload(first);
    const secondPayload = encodePlainWithdrawalPayload(second);
    const withdrawals = [withdrawal(executor, firstPayload), withdrawal(executor, secondPayload)];

    const capsules = await buildPlainExecutorUserPayloadCapsules(
      token,
      withdrawals,
      [secondPayload, firstPayload],
      executor,
    );

    expect(capsules).toEqual([
      await buildPlainExecutorUserPayloadCapsule(token, withdrawals[0], first.recipient.toField(), first.relayerTip),
      await buildPlainExecutorUserPayloadCapsule(token, withdrawals[1], second.recipient.toField(), second.relayerTip),
    ]);
  });

  it('gives no capsule to a withdrawal through a different executor', async () => {
    const token = await AztecAddress.random();
    const payload = encodePlainWithdrawalPayload({ recipient: EthAddress.random(), relayerTip: 0n });

    const capsules = await buildPlainExecutorUserPayloadCapsules(
      token,
      [withdrawal(EthAddress.random(), payload)],
      [payload],
      EthAddress.random(),
    );

    expect(capsules).toEqual([]);
  });

  it('gives no capsule when there is no plain withdrawal executor', async () => {
    const executor = EthAddress.random();
    const payload = encodePlainWithdrawalPayload({ recipient: EthAddress.random(), relayerTip: 0n });

    const capsules = await buildPlainExecutorUserPayloadCapsules(
      await AztecAddress.random(),
      [withdrawal(executor, payload)],
      [payload],
      undefined,
    );

    expect(capsules).toEqual([]);
  });

  it('rejects a plain withdrawal that has no matching payload', async () => {
    const executor = EthAddress.random();
    const committed = encodePlainWithdrawalPayload({ recipient: EthAddress.random(), relayerTip: 0n });
    const other = encodePlainWithdrawalPayload({ recipient: EthAddress.random(), relayerTip: 0n });

    await expect(
      buildPlainExecutorUserPayloadCapsules(
        await AztecAddress.random(),
        [withdrawal(executor, committed)],
        [other],
        executor,
      ),
    ).rejects.toThrow(/No user payload/);
  });
});
