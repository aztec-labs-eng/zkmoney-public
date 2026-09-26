import { EthAddress } from '@aztec/foundation/eth-address';

import { getUserPayloadHash } from './content_hash.js';
import {
  assertPlainWithdrawalTip,
  decodePlainWithdrawalPayload,
  encodePlainWithdrawalPayload,
} from './plain_withdrawal.js';

describe('plain withdrawal codec', () => {
  const recipient = EthAddress.fromString('0x0000000000000000000000000000000000000001');

  it('uses exactly 64 bytes', () => {
    expect(encodePlainWithdrawalPayload({ recipient, relayerTip: 5n })).toHaveLength(64);
  });

  it('encodes the canonical payload vector', () => {
    const vectorRecipient = EthAddress.fromString('0x11223344556677889900aabbccddeeff00112233');
    const payload = encodePlainWithdrawalPayload({ recipient: vectorRecipient, relayerTip: 75317531n });

    expect(payload.toString('hex')).toBe(
      '00000000000000000000000011223344556677889900aabbccddeeff0011223300000000000000000000000000000000000000000000000000000000047d411b',
    );
    expect(getUserPayloadHash(payload).toString()).toBe(
      '0x00ce6a41ff263e87fd9e2bb589e3708df5b40098af39741e2a6f92cedc4610b6',
    );
  });

  it('rejects a zero recipient', () => {
    expect(() => encodePlainWithdrawalPayload({ recipient: EthAddress.ZERO, relayerTip: 5n })).toThrow(
      /must not be zero/,
    );
  });

  it('rejects malformed payload lengths', () => {
    expect(() => decodePlainWithdrawalPayload(Buffer.alloc(63))).toThrow(/64/);
    expect(() => decodePlainWithdrawalPayload(Buffer.alloc(65))).toThrow(/64/);
  });

  it('rejects dirty address words', () => {
    const payload = encodePlainWithdrawalPayload({ recipient, relayerTip: 5n });
    payload[0] = 1;
    expect(() => decodePlainWithdrawalPayload(payload)).toThrow(/padding/);
  });

  it('rejects a zero recipient in decoded data', () => {
    const payload = Buffer.alloc(64);
    expect(() => decodePlainWithdrawalPayload(payload)).toThrow(/must not be zero/);
  });

  it('accepts a tip equal to the executor amount', () => {
    expect(() => assertPlainWithdrawalTip(100n, 10n, 65n, 25n, false)).not.toThrow();
  });

  it('rejects a tip above the executor amount', () => {
    expect(() => assertPlainWithdrawalTip(100n, 10n, 66n, 25n, false)).toThrow(/exceeds/);
  });

  it('uses a zero cut while frozen', () => {
    expect(() => assertPlainWithdrawalTip(100n, 10n, 90n, 25n, true)).not.toThrow();
  });

  it('rejects a prover tip above the amount', () => {
    expect(() => assertPlainWithdrawalTip(10n, 11n, 0n, 1n, false)).toThrow(/prover tip/);
  });
});
