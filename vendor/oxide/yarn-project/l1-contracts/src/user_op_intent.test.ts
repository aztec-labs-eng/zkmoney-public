import { describe, expect, test } from '@jest/globals';
import type { PublicClient } from 'viem';

import { readConditionHash } from './user_op_intent.js';

const TARGET = '0x2222222222222222222222222222222222222222';

describe('user op intent', () => {
  test('reading a condition on a target without code throws', async () => {
    const publicClient = {
      call: () => Promise.resolve({ data: undefined }),
      getCode: () => Promise.resolve(undefined),
    } as unknown as PublicClient;
    await expect(readConditionHash(publicClient, TARGET, '0x1234')).rejects.toThrow('has no code');
  });
});
