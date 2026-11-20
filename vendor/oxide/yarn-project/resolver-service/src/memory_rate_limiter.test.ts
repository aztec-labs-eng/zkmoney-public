import { describe, expect, it } from '@jest/globals';

import { MemoryRateLimiter, createRateLimiter } from './memory_rate_limiter.js';

describe('MemoryRateLimiter', () => {
  // 3/hour → starts with 3, accrues 1 more every 1200 s.
  const setup = () => {
    let now = 1_000_000;
    const rl = new MemoryRateLimiter(3, () => now);
    return { rl, advance: (ms: number) => (now += ms) };
  };

  it('allows up to the hourly allowance then rejects', () => {
    const { rl } = setup();
    expect(rl.allow('1.2.3.4', 'name')).toBe(true);
    expect(rl.allow('1.2.3.4', 'name')).toBe(true);
    expect(rl.allow('1.2.3.4', 'name')).toBe(true);
    expect(rl.allow('1.2.3.4', 'name')).toBe(false);
  });

  it('replenishes over time', () => {
    const { rl, advance } = setup();
    for (let i = 0; i < 3; i++) {
      rl.allow('ip', 'name');
    }
    expect(rl.allow('ip', 'name')).toBe(false);
    advance(2 * 1200 * 1000); // 2 requests accrued back
    expect(rl.allow('ip', 'name')).toBe(true);
    expect(rl.allow('ip', 'name')).toBe(true);
    expect(rl.allow('ip', 'name')).toBe(false);
  });

  it('never accrues past a full allowance', () => {
    const { rl, advance } = setup();
    rl.allow('ip', 'name');
    advance(10 * 3600 * 1000); // idle far longer than a full refill
    for (let i = 0; i < 3; i++) {
      expect(rl.allow('ip', 'name')).toBe(true);
    }
    expect(rl.allow('ip', 'name')).toBe(false);
  });

  it('forgets a bucket once it has refilled, and the allowance stays whole', () => {
    const { rl, advance } = setup();
    rl.allow('ip', 'a');
    rl.allow('ip', 'b');
    advance(3600 * 1000); // both refilled: as good as unseen
    expect(rl.allow('ip', 'c')).toBe(true);
    expect(rl['buckets'].size).toBe(1);
    for (let i = 0; i < 3; i++) {
      expect(rl.allow('ip', 'a')).toBe(true);
    }
    expect(rl.allow('ip', 'a')).toBe(false);
  });

  it('allowances are per (IP, name)', () => {
    const { rl } = setup();
    for (let i = 0; i < 3; i++) {
      rl.allow('ip', 'a');
    }
    expect(rl.allow('ip', 'a')).toBe(false);
    expect(rl.allow('ip', 'b')).toBe(true);
    expect(rl.allow('other-ip', 'a')).toBe(true);
  });
});

describe('createRateLimiter', () => {
  it('keeps the allowance in process for `memory:`', async () => {
    expect(await createRateLimiter(3, 'memory:')).toBeInstanceOf(MemoryRateLimiter);
  });
});
