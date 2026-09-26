import { Fr } from '@aztec/aztec.js/fields';
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import { DOM_SEP__FROZEN_NOTES_AUTH, MAX_FROZEN_NOTES_PER_REFUND } from './oxide_constants.gen.js';
import { computeFrozenNotesRefundAuthMessage } from './refund_auth_message.js';

describe('computeFrozenNotesRefundAuthMessage', () => {
  const executor = EthAddress.fromField(new Fr(0xabcd));
  const userPayloadHash = new Fr(7);
  const hashes = [new Fr(11), new Fr(22), new Fr(33)];

  it('hashes [executor, user_payload_hash, h_0..h_9] with zero padding, as the frozen_notes_refund circuit does', async () => {
    const expected = await poseidon2HashWithSeparator(
      [
        executor.toField(),
        userPayloadHash,
        ...hashes,
        ...Array(MAX_FROZEN_NOTES_PER_REFUND - hashes.length).fill(Fr.ZERO),
      ],
      DOM_SEP__FROZEN_NOTES_AUTH,
    );
    expect(await computeFrozenNotesRefundAuthMessage(hashes, executor, userPayloadHash)).toEqual(expected);
  });

  it('accepts a full set of notes without padding', async () => {
    const full = Array.from({ length: MAX_FROZEN_NOTES_PER_REFUND }, (_, i) => new Fr(i + 1));
    const expected = await poseidon2HashWithSeparator(
      [executor.toField(), userPayloadHash, ...full],
      DOM_SEP__FROZEN_NOTES_AUTH,
    );
    expect(await computeFrozenNotesRefundAuthMessage(full, executor, userPayloadHash)).toEqual(expected);
  });

  it('depends on the note order', async () => {
    const inOrder = await computeFrozenNotesRefundAuthMessage(hashes, executor, userPayloadHash);
    const swapped = await computeFrozenNotesRefundAuthMessage(
      [hashes[1]!, hashes[0]!, hashes[2]!],
      executor,
      userPayloadHash,
    );
    expect(swapped).not.toEqual(inOrder);
  });

  it('binds the executor and the payload', async () => {
    const base = await computeFrozenNotesRefundAuthMessage(hashes, executor, userPayloadHash);
    const otherExecutor = await computeFrozenNotesRefundAuthMessage(
      hashes,
      EthAddress.fromField(new Fr(0xdcba)),
      userPayloadHash,
    );
    const otherPayload = await computeFrozenNotesRefundAuthMessage(hashes, executor, new Fr(8));
    expect(otherExecutor).not.toEqual(base);
    expect(otherPayload).not.toEqual(base);
  });

  it('rejects more notes than the circuit accepts', async () => {
    const over = Array.from({ length: MAX_FROZEN_NOTES_PER_REFUND + 1 }, (_, i) => new Fr(i + 1));
    await expect(computeFrozenNotesRefundAuthMessage(over, executor, userPayloadHash)).rejects.toThrow(/max 10/);
  });
});
