import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import { encodePlainWithdrawalPayload } from './plain_withdrawal_executor.js';
import type { WithdrawalFinalizationData } from './withdrawal_finalization_data.js';
import {
  RECOVERY_CHUNK_BYTES,
  RECOVERY_CHUNK_FIELDS,
  type WithdrawalRecoveryData,
  assembleRecoveryData,
  chunkRecoveryData,
} from './withdrawal_recovery_data.js';

const MAX_AMOUNT = (1n << 128n) - 1n;
const NO_MEMO = Buffer.alloc(0);

function finalizationData(overrides: Partial<WithdrawalFinalizationData> = {}): WithdrawalFinalizationData {
  return {
    executor: EthAddress.fromNumber(1),
    amount: MAX_AMOUNT,
    proverTip: 100n,
    randomness: Fr.random(),
    withdrawalSignature: { sLo: new Fr((1n << 128n) - 1n), sHi: Fr.ONE, rLo: Fr.ZERO, rHi: new Fr(7) },
    userPayload: encodePlainWithdrawalPayload({ recipient: EthAddress.fromNumber(2), relayerTip: 3n }),
    ...overrides,
  };
}

function recoveryData(overrides: Partial<WithdrawalFinalizationData> = {}, memo = NO_MEMO): WithdrawalRecoveryData {
  return { finalizationData: finalizationData(overrides), memo };
}

describe('withdrawal recovery data', () => {
  it('fits a plain withdrawal in one chunk and preserves every field', () => {
    const input = recoveryData();
    const inputChunks = chunkRecoveryData(input);
    expect(inputChunks).toHaveLength(1);
    expect(assembleRecoveryData(inputChunks)).toEqual([input]);
  });

  it('round-trips a memo', () => {
    const input = recoveryData({}, Buffer.from('memo'));
    expect(assembleRecoveryData(chunkRecoveryData(input))).toEqual([input]);
  });

  it('round-trips user payloads and memos of every length up to two chunks', () => {
    for (let length = 0; length <= 2 * RECOVERY_CHUNK_BYTES; length++) {
      const withPayload = recoveryData({ userPayload: Buffer.alloc(length, 0xa5) });
      expect(assembleRecoveryData(chunkRecoveryData(withPayload))).toEqual([withPayload]);
      const withMemo = recoveryData({}, Buffer.alloc(length, 0x5a));
      expect(assembleRecoveryData(chunkRecoveryData(withMemo))).toEqual([withMemo]);
    }
  });

  it('separates consecutive withdrawals, including identical ones', () => {
    const large = recoveryData({ userPayload: Buffer.alloc(700, 9) });
    const small = recoveryData({}, Buffer.from('small'));
    const withLargeMemo = recoveryData({}, Buffer.alloc(400, 3));
    const assembled = assembleRecoveryData([large, small, withLargeMemo, large].flatMap(chunkRecoveryData));
    expect(assembled).toEqual([large, small, withLargeMemo, large]);
  });

  it('rejects missing chunks', () => {
    const inputChunks = chunkRecoveryData(recoveryData({ userPayload: Buffer.alloc(700) }));
    expect(() => assembleRecoveryData(inputChunks.slice(0, -1))).toThrow(/beyond buffer length/);
    const memoChunks = chunkRecoveryData(recoveryData({}, Buffer.alloc(400)));
    expect(() => assembleRecoveryData(memoChunks.slice(0, -1))).toThrow(/beyond buffer length/);
  });

  it('rejects nonzero padding, noncanonical fields, and a chunk of zeros', () => {
    const [first] = chunkRecoveryData(recoveryData());
    const badPadding = [...first];
    badPadding[9] = Fr.ONE;
    expect(() => assembleRecoveryData([badPadding])).toThrow(/padding/);
    const badField = [...first];
    badField[9] = new Fr(1n << 248n);
    expect(() => assembleRecoveryData([badField])).toThrow(/high byte/);
    expect(() => assembleRecoveryData([first.slice(1)])).toThrow(/10 fields/);
    expect(() => assembleRecoveryData([first, Array(RECOVERY_CHUNK_FIELDS).fill(Fr.ZERO)])).toThrow(/executor/);
  });

  it('rejects invalid amounts, tips, signatures, and oversized data', () => {
    expect(() => chunkRecoveryData(recoveryData({ amount: MAX_AMOUNT + 1n }))).toThrow(/128 bits/);
    expect(() => chunkRecoveryData(recoveryData({ proverTip: MAX_AMOUNT + 1n }))).toThrow(/tip/);
    const withdrawalSignature = { ...finalizationData().withdrawalSignature, sLo: new Fr(1n << 128n) };
    expect(() => chunkRecoveryData(recoveryData({ withdrawalSignature }))).toThrow(/128 bits/);
    expect(() => chunkRecoveryData(recoveryData({ userPayload: Buffer.alloc(65536) }))).toThrow(
      /user payload must fit in 65535/,
    );
    expect(() => chunkRecoveryData(recoveryData({}, Buffer.alloc(65536)))).toThrow(/memo must fit in 65535/);
  });
});
