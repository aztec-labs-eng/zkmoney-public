/** Shared secrets, nonces (and as a result SIPAs) are scoped to a UTC day derived from the L1 block timestamp. */
export const SECONDS_PER_DAY = 86_400n;

export function dayFromTimestamp(timestamp: bigint): number {
  return Number(timestamp / SECONDS_PER_DAY);
}
