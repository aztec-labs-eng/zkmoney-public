import type { RateLimiter } from './rate_limiter.js';

const MS_PER_HOUR = 3_600_000;

/** The `OXIDE_RESOLVER_REDIS_URL` that selects {@link MemoryRateLimiter}; local mode only. */
export const MEMORY_RATE_LIMITER_URL = 'memory:';

/**
 * An in-process {@link RateLimiter} (the same continuously-refilling bucket per `(clientIp, nameHash)`) for a
 * resolver that runs alone, as one test world's does: `OXIDE_RESOLVER_REDIS_URL=memory:`. Never a fleet's limiter.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private swept: number;

  constructor(
    private readonly requestsPerHour: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.swept = now();
  }

  allow(clientIp: string, nameHash: string): boolean {
    const key = `${clientIp}:${nameHash}`;
    const now = this.now();
    this.sweep(now);
    const bucket = this.buckets.get(key) ?? { tokens: this.requestsPerHour, at: now };
    const tokens = Math.min(
      this.requestsPerHour,
      bucket.tokens + (Math.max(0, now - bucket.at) * this.requestsPerHour) / MS_PER_HOUR,
    );
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return false;
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    return true;
  }

  close(): void {}

  /** Drops the buckets idle for a full refill, at most once a refill: a full bucket allows what a missing one does. */
  private sweep(now: number): void {
    if (now - this.swept < MS_PER_HOUR) {
      return;
    }
    this.swept = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at >= MS_PER_HOUR) {
        this.buckets.delete(key);
      }
    }
  }
}

/** The limiter `redisUrl` names: in-process for `memory:`, else the fleet's Redis. */
export async function createRateLimiter(requestsPerHour: number, redisUrl: string, namespace?: string) {
  if (redisUrl === MEMORY_RATE_LIMITER_URL) {
    return new MemoryRateLimiter(requestsPerHour);
  }
  const { RedisRateLimiter } = await import('./redis_rate_limiter.js');
  return new RedisRateLimiter(requestsPerHour, redisUrl, undefined, namespace);
}
