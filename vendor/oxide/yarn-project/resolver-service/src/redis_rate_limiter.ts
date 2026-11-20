import { Redis } from 'ioredis';

import type { RateLimiter } from './rate_limiter.js';

const MS_PER_HOUR = 3_600_000;

/** Idle ≥1h ≡ a full bucket, so expiring the key after that (plus slack) is lossless. */
const KEY_TTL_MS = 3_700_000;

/** Per-request budget for both the connection handshake and the command itself. */
const TIMEOUT_MS = 1000;

// Continuous-refill token bucket, atomically: refill from the elapsed time, spend one if a whole request has accrued,
// write back. KEYS[1] = bucket key, ARGV = [capacity, nowMs, ttlMs]. Returns 1 if allowed, 0 if not.
const TOKEN_BUCKET_LUA = `
local cap = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local state = redis.call('HMGET', KEYS[1], 'r', 't')
local remaining = cap
local last = now
if state[1] then
  remaining = tonumber(state[1])
  last = tonumber(state[2])
end
remaining = math.min(cap, remaining + math.max(0, now - last) * cap / ${MS_PER_HOUR})
local allowed = 0
if remaining >= 1 then
  remaining = remaining - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'r', remaining, 't', now)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return allowed
`;

type RateLimitClient = Redis & {
  oxideRateLimit(key: string, capacity: number, nowMs: number, ttlMs: number): Promise<number>;
};

/**
 * Redis-backed {@link RateLimiter}: one fleet-wide token bucket per `(clientIp, nameHash)`, spent in a single atomic
 * Lua call so all gateway instances share the allowance. Fail-closed and fail-fast: `allow()` rejects on any Redis
 * error or timeout — never a silent bypass — and the client fails immediately instead of queueing (the ioredis
 * offline-queue + retry defaults would stall requests into the upstream timeout while pinning concurrency slots).
 */
export class RedisRateLimiter implements RateLimiter {
  private readonly redis: RateLimitClient;

  constructor(
    private readonly requestsPerHour: number,
    redisUrl: string,
    private readonly now: () => number = () => Date.now(),
    namespace?: string,
  ) {
    this.redis = new Redis(redisUrl, {
      enableOfflineQueue: false,
      ...(namespace ? { keyPrefix: `${namespace}:` } : {}),
      commandTimeout: TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      retryStrategy: times => Math.min(times * 500, 5000),
    }) as RateLimitClient;
    // ioredis handles the EVALSHA-with-NOSCRIPT-fallback dance for defined commands.
    this.redis.defineCommand('oxideRateLimit', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
    // Surface connection errors via allow() rejections only; an unhandled 'error' event would crash the process.
    this.redis.on('error', () => {});
  }

  /**
   * Bounded wait for the handshake: with the offline queue disabled a command issued mid-connect fails outright, which
   * would refuse every cold start's first resolve; the bound keeps a cache outage from pinning a concurrency slot.
   */
  #ready(): Promise<void> {
    if (this.redis.status === 'ready') {
      return Promise.resolve();
    }
    if (this.redis.status === 'end') {
      return Promise.reject(new Error('rate limiter connection is closed'));
    }
    return new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        this.redis.off('ready', onReady);
        this.redis.off('error', onError);
        err ? reject(err) : resolve();
      };
      const onReady = () => done();
      const onError = (err: Error) => done(err);
      const timer = setTimeout(() => done(new Error('rate limiter connect timed out')), TIMEOUT_MS);
      this.redis.once('ready', onReady);
      this.redis.once('error', onError);
    });
  }

  async allow(clientIp: string, nameHash: string): Promise<boolean> {
    await this.#ready();
    const key = `rl:${clientIp}:${nameHash}`;
    return (await this.redis.oxideRateLimit(key, this.requestsPerHour, this.now(), KEY_TTL_MS)) === 1;
  }

  close(): void {
    this.redis.disconnect();
  }
}
