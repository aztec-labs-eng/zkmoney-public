import { Fr } from '@aztec-labs/aztec.js/fields';
import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon';
import { sha256ToField } from '@aztec-labs/foundation/crypto/sha256';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

import { encodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal_executor.js';
import type { WithdrawalFinalizationData } from '@oxide/oxide-lib/withdrawal_finalization_data.js';
import { chunkRecoveryData } from '@oxide/oxide-lib/withdrawal_recovery_data.js';

import { describe, expect, it } from '@jest/globals';

import { buildRecoveryChunkCapsules } from './capsules.js';

function finalizationData(userPayload: Buffer): WithdrawalFinalizationData {
  return {
    executor: EthAddress.fromNumber(1),
    amount: 1000n,
    proverTip: 10n,
    randomness: new Fr(7n),
    withdrawalSignature: { rHi: new Fr(1n), rLo: new Fr(2n), sHi: new Fr(3n), sLo: new Fr(4n) },
    userPayload,
  };
}

describe('buildRecoveryChunkCapsules', () => {
  it('puts the chunks of each withdrawal in its own capsule array', async () => {
    const token = await AztecAddress.random();
    const large = { finalizationData: finalizationData(Buffer.alloc(700, 1)), memo: Buffer.alloc(0) };
    const small = {
      finalizationData: finalizationData(
        encodePlainWithdrawalPayload({ recipient: EthAddress.fromNumber(5), relayerTip: 3n }),
      ),
      memo: Buffer.from('memo'),
    };
    expect(chunkRecoveryData(large).length).toBeGreaterThan(1);

    const capsules = await buildRecoveryChunkCapsules(token, [large, small]);

    const capsulesSlot = sha256ToField([Buffer.from('OXIDE_TOKEN::RECOVERY_CHUNKS')]);
    const expected: { slot: Fr; data: Fr[] }[] = [];
    for (const [k, data] of [large, small].entries()) {
      const baseSlot = await poseidon2Hash([capsulesSlot, new Fr(k)]);
      const chunks = chunkRecoveryData(data);
      expected.push({ slot: baseSlot, data: [new Fr(chunks.length)] });
      expected.push(...chunks.map((chunk, i) => ({ slot: baseSlot.add(new Fr(1 + i)), data: chunk })));
    }
    expect(capsules).toHaveLength(expected.length);
    for (const [i, capsule] of capsules.entries()) {
      expect(capsule.contractAddress.equals(token)).toBe(true);
      expect(capsule.storageSlot.equals(expected[i].slot)).toBe(true);
      expect(capsule.data).toEqual(expected[i].data);
    }
  });
});
