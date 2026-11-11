export interface BlockRange {
  fromBlock: bigint;
  toBlock: bigint;
}

export interface ScannedWindow<T> extends BlockRange {
  logs: T[];
}

const RATE_LIMIT = /rate limit|request rate|too many requests/i;
const RATE_LIMIT_CODE = 429;

/**
 * True when the provider refused the query for its rate. The L1 transport replaces the thrown error, so this predicate
 * reads the whole `cause` chain.
 */
function isRateLimitError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const { status, code } = current as { status?: unknown; code?: unknown };
    if (status === RATE_LIMIT_CODE || code === RATE_LIMIT_CODE || RATE_LIMIT.test(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return !(err instanceof Error) && RATE_LIMIT.test(String(err));
}

/**
 * Walk `[fromBlock, toBlock]` in windows of at most `window` blocks. A failed window is retried at half its span,
 * because providers word their range and result caps differently. A one-block window that still fails propagates, and
 * so does a rate limit, because a smaller window does not answer one.
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
      if (span > 1n && !isRateLimitError(err)) {
        window = span / 2n;
        continue;
      }
      throw err;
    }
    yield { fromBlock: lo, toBlock: hi, logs };
    lo = hi + 1n;
  }
}
