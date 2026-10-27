import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import { encodePlainWithdrawalPayload } from './plain_withdrawal_executor.js';
import {
  type WithdrawalFinalizationData,
  decodeFinalizationData,
  encodeFinalizationData,
} from './withdrawal_finalization_data.js';

function finalizationData(): WithdrawalFinalizationData {
  return {
    executor: EthAddress.fromNumber(1),
    amount: 1000n,
    proverTip: 100n,
    randomness: Fr.random(),
    withdrawalSignature: { sLo: new Fr((1n << 128n) - 1n), sHi: Fr.ONE, rLo: Fr.ZERO, rHi: new Fr(7) },
    userPayload: encodePlainWithdrawalPayload({ recipient: EthAddress.fromNumber(2), relayerTip: 3n }),
  };
}

describe('withdrawal finalization data', () => {
  it('decodes the encoded data', () => {
    const input = finalizationData();
    expect(decodeFinalizationData(encodeFinalizationData(input))).toEqual(input);
  });

  it('rejects truncated encodings and trailing bytes', () => {
    const encoded = encodeFinalizationData(finalizationData());
    expect(() => decodeFinalizationData(encoded.subarray(0, -1))).toThrow(/beyond buffer length/);
    expect(() => decodeFinalizationData(Buffer.concat([encoded, Buffer.of(0)]))).toThrow(/Trailing bytes/);
  });
});
