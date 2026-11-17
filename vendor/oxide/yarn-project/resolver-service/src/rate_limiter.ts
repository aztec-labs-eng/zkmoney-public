/**
 * Caps requests per hour for a `(clientIp, nameHash)` pair: a continuously-refilling token bucket, so a pair can burst
 * a full hour's allowance and then waits for it to trickle back. The allowance is shared by every instance, capping
 * the fleet rather than any one process.
 */
export interface RateLimiter {
  /**
   * Spends one request for the pair; false once the allowance is used up. Rejects if the backing store is
   * unreachable — callers must treat that as "unavailable", never as "allowed".
   */
  allow(clientIp: string, nameHash: string): boolean | Promise<boolean>;
}
