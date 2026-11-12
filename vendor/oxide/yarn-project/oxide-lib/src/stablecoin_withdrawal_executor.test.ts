import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { getUserPayloadHash } from './content_hash.js';
import {
  StablecoinWithdrawalRoute,
  assertStablecoinWithdrawalTip,
  buildStablecoinExecutorCall,
  decodeStablecoinWithdrawalPayload,
  encodeStablecoinWithdrawalPayload,
  stablecoinWithdrawalNetAmount,
} from './stablecoin_withdrawal_executor.js';

describe('stablecoin withdrawal codec', () => {
  const recipient = EthAddress.fromString('0x11223344556677889900aabbccddeeff00112233');
  const recoveryCommitment = `0x00${'ab'.repeat(31)}` as const;
  const payload = {
    route: StablecoinWithdrawalRoute.USDT,
    recipient,
    daiForGas: 15n * 10n ** 18n,
    minOut: 2_497_000_000n,
    recoveryCommitment,
    relayerTip: 5n,
  };
  const uint = (bytes: Buffer) => BigInt(`0x${bytes.toString('hex')}`);

  it('puts each field where the executor reads it', () => {
    const encoded = encodeStablecoinWithdrawalPayload(payload);

    expect(encoded).toHaveLength(101);
    expect(encoded[0]).toBe(1);
    expect(encoded.subarray(1, 21)).toEqual(recipient.toBuffer());
    expect(uint(encoded.subarray(21, 37))).toBe(15n * 10n ** 18n);
    expect(uint(encoded.subarray(37, 53))).toBe(2_497_000_000n);
    expect(`0x${encoded.subarray(53, 85).toString('hex')}`).toBe(recoveryCommitment);
    expect(uint(encoded.subarray(85, 101))).toBe(5n);
  });

  it('encodes the canonical payload vector', () => {
    const encoded = encodeStablecoinWithdrawalPayload({
      ...payload,
      route: StablecoinWithdrawalRoute.DAI,
      daiForGas: 0n,
      minOut: 0n,
      relayerTip: 75317531n,
    });

    expect(encoded.toString('hex')).toBe(
      '0211223344556677889900aabbccddeeff00112233' +
        '00'.repeat(32) +
        `00${'ab'.repeat(31)}` +
        '000000000000000000000000047d411b',
    );
    expect(getUserPayloadHash(encoded).toString()).toBe(
      '0x00a0d457a9e6bccf6b9e7c51b3421c1cc44edd70393c9d06359254e42911488c',
    );
  });

  it("uses the executor's route numbers", () => {
    expect([StablecoinWithdrawalRoute.USDC, StablecoinWithdrawalRoute.USDT, StablecoinWithdrawalRoute.DAI]).toEqual([
      0, 1, 2,
    ]);
  });

  it('reads back every field', () => {
    expect(decodeStablecoinWithdrawalPayload(encodeStablecoinWithdrawalPayload(payload))).toEqual(payload);
  });

  it('rejects an amount that does not fit 128 bits, which the executor would read as another amount', () => {
    const tooWide = 1n << 128n;
    for (const field of ['relayerTip', 'minOut', 'daiForGas'] as const) {
      expect(() => encodeStablecoinWithdrawalPayload({ ...payload, [field]: tooWide })).toThrow(/range/);
      expect(() => encodeStablecoinWithdrawalPayload({ ...payload, [field]: tooWide - 1n })).not.toThrow();
    }
  });

  it('rejects a zero recovery commitment', () => {
    const zero = `0x${'00'.repeat(32)}` as const;
    expect(() => encodeStablecoinWithdrawalPayload({ ...payload, recoveryCommitment: zero })).toThrow(/nonzero/);
  });

  it('rejects a recovery commitment of more than 248 bits', () => {
    const wide = `0x01${'00'.repeat(31)}` as const;
    expect(() => encodeStablecoinWithdrawalPayload({ ...payload, recoveryCommitment: wide })).toThrow(/248 bits/);
  });

  it('rejects a zero recipient', () => {
    expect(() => encodeStablecoinWithdrawalPayload({ ...payload, recipient: EthAddress.ZERO })).toThrow(
      /must not be zero/,
    );
  });

  it('rejects malformed payload lengths', () => {
    expect(() => decodeStablecoinWithdrawalPayload(Buffer.alloc(64))).toThrow(/101/);
    expect(() => decodeStablecoinWithdrawalPayload(Buffer.alloc(100))).toThrow(/101/);
    expect(() => decodeStablecoinWithdrawalPayload(Buffer.alloc(102))).toThrow(/101/);
  });

  it('rejects a zero recipient in decoded data', () => {
    expect(() => decodeStablecoinWithdrawalPayload(Buffer.alloc(101))).toThrow(/must not be zero/);
  });
});

describe('plain refund executor call', () => {
  it('pays the asset as is and commits to no recovery account, because recover cannot reach a refund', () => {
    const recipient = EthAddress.random();
    const call = buildStablecoinExecutorCall({ executor: EthAddress.random(), recipient, relayerTip: 3n });

    expect(decodeStablecoinWithdrawalPayload(call.userPayload)).toEqual({
      route: StablecoinWithdrawalRoute.DAI,
      recipient,
      daiForGas: 0n,
      minOut: 0n,
      recoveryCommitment: `0x${'00'.repeat(32)}`,
      relayerTip: 3n,
    });
  });
});

describe('stablecoin withdrawal amounts', () => {
  it('accepts a tip equal to the executor amount', () => {
    expect(() => assertStablecoinWithdrawalTip(100n, 10n, 90n, 0n)).not.toThrow();
  });

  it('rejects a tip above the executor amount', () => {
    expect(() => assertStablecoinWithdrawalTip(100n, 10n, 91n, 0n)).toThrow(/exceeds/);
  });

  it('accepts a tip equal to the amount after the fee', () => {
    expect(() => assertStablecoinWithdrawalTip(100n, 10n, 85n, 5n)).not.toThrow();
  });

  it('rejects a tip above the amount after the fee', () => {
    expect(() => assertStablecoinWithdrawalTip(100n, 10n, 86n, 5n)).toThrow(/exceeds/);
  });

  it('rejects a prover tip above the amount', () => {
    expect(() => assertStablecoinWithdrawalTip(10n, 11n, 0n, 0n)).toThrow(/prover tip/);
  });

  it('subtracts the fee from the executor amount', () => {
    expect(stablecoinWithdrawalNetAmount(100n, 10n, 5n)).toBe(85n);
  });

  it('rejects an executor amount that the fee takes whole', () => {
    expect(() => stablecoinWithdrawalNetAmount(100n, 10n, 90n)).toThrow(/not above the fee/);
    expect(() => stablecoinWithdrawalNetAmount(100n, 100n, 0n)).toThrow(/not above the fee/);
  });
});
