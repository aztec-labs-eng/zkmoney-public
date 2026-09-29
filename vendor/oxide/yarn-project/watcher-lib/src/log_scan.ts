export interface BlockRange {
  fromBlock: bigint;
  toBlock: bigint;
}

export interface ScannedWindow<T> extends BlockRange {
  logs: T[];
}

const PROVIDER_CAP =
  /more than \d+ results|query returned|exceeds? (the )?(limit|max)|block range|response size|too large/i;
const RATE_LIMIT = /rate limit|too many requests|\b429\b/i;

/**
 * True when the provider refused the query as too large. The L1 transport replaces the thrown error, so this
 * predicate reads the whole `cause` chain. A rate limit anywhere in the chain excludes the match, because a smaller
 * window does not answer a rate limit.
 *
 * Each step gives the text that the provider wrote. A viem error puts that text in `details` and builds its own
 * `message` from the request URL and the request body, which hold digits that these patterns must not read.
 */
export function isProviderCapError(err: unknown): boolean {
  const texts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const details = (current as { details?: unknown }).details;
    texts.push(typeof details === 'string' && details !== '' ? details : current.message);
    current = current.cause;
  }
  if (texts.length === 0) {
    texts.push(String(err));
  }
  return texts.some(t => PROVIDER_CAP.test(t)) && !texts.some(t => RATE_LIMIT.test(t));
}

/**
 * Walk `[fromBlock, toBlock]` in windows of at most `window` blocks. A window the provider refuses as too large
 * (range or result cap) is retried at half its span; a one-block window that still fails, and any other error,
 * propagate.
 */
export async function* scanWindows<T>(
  range: BlockRange & { window: bigint },
  fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
): AsyncGenerator<ScannedWindow<T>> {
  if (range.window <= 0n) {
    throw new Error('log scan window must be positive');
  }
  let window = range.window;
  let lo = range.fromBlock;
  while (lo <= range.toBlock) {
    const hi = lo + window - 1n > range.toBlock ? range.toBlock : lo + window - 1n;
    let logs: T[];
    try {
      logs = await fetch(lo, hi);
    } catch (err: unknown) {
      const span = hi - lo + 1n;
      if (span > 1n && isProviderCapError(err)) {
        window = span / 2n;
        continue;
      }
      throw err;
    }
    yield { fromBlock: lo, toBlock: hi, logs };
    lo = hi + 1n;
  }
}
