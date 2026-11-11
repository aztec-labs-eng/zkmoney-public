import { describe, expect, test } from '@jest/globals';
import { decodeFunctionData } from 'viem';

import { MultiStepExecutorAbi } from '../artifacts.js';
import { type MultiStepRecovery, encodeMultiStepRecover, multiStepRecoveryDigest } from './recovery.js';

const DIGEST_INPUT = {
  executor: '0x1111111111111111111111111111111111111111',
  chainId: 1n,
  withdrawalId: `0x${'22'.repeat(32)}`,
  recipient: '0x3333333333333333333333333333333333333333',
  deadline: 1_800_000_000n,
} as const;

const RECOVERY: MultiStepRecovery = {
  portal: '0x4444444444444444444444444444444444444444',
  args: {
    content: {
      executor: DIGEST_INPUT.executor,
      userPayloadHash: `0x${'55'.repeat(32)}`,
      amount: 1_000n,
      proverTip: 5n,
      randomness: 7n,
    },
    userPayload: '0xabcdef',
    relayerPayload: '0x',
    epochNumber: 3n,
    numCheckpointsInEpoch: 2n,
    leafIndex: 1n,
    path: [`0x${'66'.repeat(32)}`],
    checkpointNumber: 9n,
    withdrawalId: DIGEST_INPUT.withdrawalId,
    teeSignature: '0x7777',
  },
  recoverySalt: `0x${'88'.repeat(32)}`,
  account: '0x9999999999999999999999999999999999999999',
  signature: '0xaaaa',
  recipient: DIGEST_INPUT.recipient,
  deadline: DIGEST_INPUT.deadline,
};

describe('multiStepRecoveryDigest', () => {
  test('is the keccak of the ABI encoded tuple, and binds every field', () => {
    const digest = multiStepRecoveryDigest(DIGEST_INPUT);
    const changed = [
      { executor: DIGEST_INPUT.recipient },
      { chainId: 2n },
      { withdrawalId: `0x${'23'.repeat(32)}` as const },
      { recipient: DIGEST_INPUT.executor },
      { deadline: DIGEST_INPUT.deadline + 1n },
    ];

    expect(digest).toBe('0x5cbe72586739d17e3499b9507fb035206401ba11edb9bda5463b0d078a373fa4');
    for (const change of changed) {
      expect(multiStepRecoveryDigest({ ...DIGEST_INPUT, ...change })).not.toBe(digest);
    }
  });
});

describe('encodeMultiStepRecover', () => {
  test('encodes recover with the arguments in the order of the ABI', () => {
    const { functionName, args } = decodeFunctionData({
      abi: MultiStepExecutorAbi,
      data: encodeMultiStepRecover(RECOVERY),
    });

    expect(functionName).toBe('recover');
    expect(args).toEqual([
      RECOVERY.portal,
      RECOVERY.args,
      RECOVERY.recoverySalt,
      RECOVERY.account,
      RECOVERY.signature,
      RECOVERY.recipient,
      RECOVERY.deadline,
    ]);
  });
});
