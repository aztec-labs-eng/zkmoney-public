import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { decodeExecutorRelayerPayload, encodeExecutorRelayerPayload, withdrawalExecutionAmount } from './executor.js';

describe('executor relayer payload', () => {
  const payload = { tipRecipient: EthAddress.fromString('0x1111111111111111111111111111111111111111') };
  const vector = Buffer.from('11'.repeat(20), 'hex');

  it('encodes the tip recipient as the 20 address bytes', () => {
    expect(encodeExecutorRelayerPayload(payload)).toEqual(vector);
    expect(decodeExecutorRelayerPayload(vector)).toEqual(payload);
  });

  it.each([0, 19, 21, 32])('rejects a payload of %i bytes', length => {
    expect(() => decodeExecutorRelayerPayload(Buffer.alloc(length))).toThrow(/exactly 20 bytes/);
  });
});

describe('withdrawal execution amount', () => {
  it('subtracts the prover tip from the amount', () => {
    expect(withdrawalExecutionAmount(100n, 10n)).toBe(90n);
    expect(withdrawalExecutionAmount(100n, 100n)).toBe(0n);
  });

  it('rejects a prover tip above the amount', () => {
    expect(() => withdrawalExecutionAmount(10n, 11n)).toThrow(/prover tip/);
  });
});
