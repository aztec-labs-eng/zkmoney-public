import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Redis } from 'ioredis';

import { RedisRateLimiter } from './redis_rate_limiter.js';

// Needs a live Redis/Valkey (docker run -p 6379:6379 valkey/valkey:7-alpine and
// OXIDE_TEST_REDIS_URL=redis://localhost:6379). Skipped when unset; ci-jest always provides one.
const REDIS_URL = process.env.OXIDE_TEST_REDIS_URL;

(REDIS_URL ? describe : describe.skip)('RedisRateLimiter', () => {
  let now: number;
  let open: RedisRateLimiter[];

  beforeEach(async () => {
    now = 1_000_000;
    open = [];
    // Bucket keys are TTL'd, not per-run, so flush between tests to keep allowances independent.
    const redis = new Redis(REDIS_URL!);
    await redis.flushdb();
    redis.disconnect();
  });
  afterEach(() => {
    open.forEach(l => l.close());
  });

  // 3/hour → starts with 3, accrues 1 more every 1200 s.
  const limiter = () => {
    const l = new RedisRateLimiter(3, REDIS_URL!, () => now);
    open.push(l);
    return l;
  };

  it('allows up to the hourly allowance then rejects', async () => {
    const rl = limiter();
    expect(await rl.allow('1.2.3.4', 'name')).toBe(true);
    expect(await rl.allow('1.2.3.4', 'name')).toBe(true);
    expect(await rl.allow('1.2.3.4', 'name')).toBe(true);
    expect(await rl.allow('1.2.3.4', 'name')).toBe(false);
  });

  it('replenishes over time', async () => {
    const rl = limiter();
    for (let i = 0; i < 3; i++) {
      await rl.allow('ip', 'name');
    }
    expect(await rl.allow('ip', 'name')).toBe(false);
    now += 2 * 1200 * 1000; // 2 requests accrued back
    expect(await rl.allow('ip', 'name')).toBe(true);
    expect(await rl.allow('ip', 'name')).toBe(true);
    expect(await rl.allow('ip', 'name')).toBe(false);
  });

  it('never accrues past a full allowance', async () => {
    const rl = limiter();
    await rl.allow('ip', 'name');
    now += 10 * 3600 * 1000; // idle far longer than a full refill
    for (let i = 0; i < 3; i++) {
      expect(await rl.allow('ip', 'name')).toBe(true);
    }
    expect(await rl.allow('ip', 'name')).toBe(false);
  });

  it('allowances are per (IP, name)', async () => {
    const rl = limiter();
    for (let i = 0; i < 3; i++) {
      await rl.allow('ip', 'a');
    }
    expect(await rl.allow('ip', 'a')).toBe(false);
    expect(await rl.allow('ip', 'b')).toBe(true);
    expect(await rl.allow('other-ip', 'a')).toBe(true);
  });

  it('shares one allowance across instances', async () => {
    // The point of the shared store: a second instance must see the first's spending, not a fresh bucket.
    const a = limiter();
    const b = limiter();
    expect(await a.allow('ip', 'name')).toBe(true);
    expect(await b.allow('ip', 'name')).toBe(true);
    expect(await a.allow('ip', 'name')).toBe(true);
    expect(await b.allow('ip', 'name')).toBe(false);
  });
});

describe('RedisRateLimiter failure semantics', () => {
  it('rejects (fails closed) when the store is unreachable', async () => {
    // Nothing listens on port 1; with the offline queue disabled the command fails instead of queueing.
    const rl = new RedisRateLimiter(3, 'redis://127.0.0.1:1');
    try {
      await expect(rl.allow('ip', 'name')).rejects.toThrow();
    } finally {
      rl.close();
    }
  });
});
