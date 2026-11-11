import { describe, expect, test } from '@jest/globals';
import { zeroHash } from 'viem';

import { type MultiStepPayload, decodeMultiStepPayload, encodeMultiStepPayload } from './payload.js';

const PAYLOAD: MultiStepPayload = {
  relayerTip: 3n,
  recoveryCommitment: `0x${'22'.repeat(32)}`,
  remainderRecipient: '0x3333333333333333333333333333333333333333',
  transfers: [{ amount: 7n, recipient: '0x1111111111111111111111111111111111111111' }],
  steps: [{ target: '0x4444444444444444444444444444444444444444', data: '0xabcdef' }],
};

describe('multi-step payload', () => {
  test('round-trips the user payload', () => {
    expect(decodeMultiStepPayload(encodeMultiStepPayload(PAYLOAD))).toEqual(PAYLOAD);
  });

  test('rejects a payload with trailing bytes', () => {
    const trailing = Buffer.concat([encodeMultiStepPayload(PAYLOAD), Buffer.from([0])]);
    expect(() => decodeMultiStepPayload(trailing)).toThrow(/canonical/);
  });

  test('rejects a zero recovery commitment', () => {
    expect(() => encodeMultiStepPayload({ ...PAYLOAD, recoveryCommitment: zeroHash })).toThrow(
      /recoveryCommitment must be nonzero/,
    );
  });
});
