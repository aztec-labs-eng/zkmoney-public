import { describe, expect, it } from '@jest/globals';
import { LimitExceededRpcError, RpcRequestError } from 'viem';

import { isProviderCapError, scanWindows } from './log_scan.js';

const INFURA_RESULT_CAP = 'query returned more than 10000 results. Try with this block range [0x1, 0x2].';
const INFURA_RANGE_CAP = 'range 25887126 - 25897126 exceeds limit of 10000';
const HEX_BLOCK_HOLDING_429 = '0x18b4293';

function wrapLikeL1Transport(rpcMessage: string, url = 'https://mainnet.infura.io/v3/PROJECT_ID'): Error {
  const request = new RpcRequestError({
    body: { method: 'eth_getLogs', params: [{ fromBlock: HEX_BLOCK_HOLDING_429, toBlock: '0x18b42d4' }] },
    error: { code: -32005, message: rpcMessage },
    url,
  });
  return new Error('L1 RPC request failed', { cause: new LimitExceededRpcError(request) });
}

function fetchWithCap(
  maxSpan: bigint,
  calls: Array<[bigint, bigint]> = [],
  makeError: (message: string) => Error = message => new Error(message),
) {
  return (fromBlock: bigint, toBlock: bigint): Promise<bigint[]> => {
    calls.push([fromBlock, toBlock]);
    if (toBlock - fromBlock + 1n > maxSpan) {
      return Promise.reject(makeError(INFURA_RESULT_CAP));
    }
    const logs: bigint[] = [];
    for (let b = fromBlock; b <= toBlock; b++) {
      logs.push(b);
    }
    return Promise.resolve(logs);
  };
}

async function collect<T>(gen: AsyncGenerator<{ fromBlock: bigint; toBlock: bigint; logs: T[] }>) {
  const windows: Array<[bigint, bigint]> = [];
  const logs: T[] = [];
  for await (const w of gen) {
    windows.push([w.fromBlock, w.toBlock]);
    logs.push(...w.logs);
  }
  return { windows, logs };
}

describe('isProviderCapError', () => {
  it('matches the result cap and the range cap, not a rate limit', () => {
    expect(isProviderCapError(new Error(INFURA_RESULT_CAP))).toBe(true);
    expect(isProviderCapError(new Error(INFURA_RANGE_CAP))).toBe(true);
    expect(isProviderCapError(new Error('Too Many Requests (429): rate limit exceeded'))).toBe(false);
    expect(isProviderCapError(new Error('ECONNRESET'))).toBe(false);
  });

  it('matches the cap through the error chain the L1 transport throws', () => {
    const wrapped = wrapLikeL1Transport(INFURA_RESULT_CAP);
    expect(wrapped.message).toBe('L1 RPC request failed');
    expect((wrapped.cause as Error).message).toContain(HEX_BLOCK_HOLDING_429);
    expect(isProviderCapError(wrapped)).toBe(true);
    expect(isProviderCapError(wrapLikeL1Transport(INFURA_RANGE_CAP))).toBe(true);
    expect(isProviderCapError(new Error('L1 RPC request failed', { cause: new Error(INFURA_RESULT_CAP) }))).toBe(true);
  });

  it('excludes a rate limit that sits anywhere in the chain', () => {
    expect(isProviderCapError(wrapLikeL1Transport('Too Many Requests'))).toBe(false);
    expect(isProviderCapError(wrapLikeL1Transport('daily request count exceeded, request rate limited'))).toBe(false);
  });

  it('reads only the text the provider wrote, not the request URL or body', () => {
    const wrapped = wrapLikeL1Transport(INFURA_RESULT_CAP, 'https://rpc.example.com/key-429-abc');
    expect((wrapped.cause as Error).message).toContain('key-429-abc');
    expect(isProviderCapError(wrapped)).toBe(true);
  });

  it('rethrows a throttle that carries no cap text', () => {
    expect(isProviderCapError(wrapLikeL1Transport('project ID request rate exceeded'))).toBe(false);
  });

  it('stops on a cycle, a non-Error cause, and a non-Error input', () => {
    const inner = new Error(INFURA_RESULT_CAP);
    const outer = new Error('L1 RPC request failed', { cause: inner });
    (inner as { cause?: unknown }).cause = outer;
    expect(isProviderCapError(outer)).toBe(true);
    expect(isProviderCapError(new Error('L1 RPC request failed', { cause: INFURA_RESULT_CAP }))).toBe(false);
    expect(isProviderCapError(INFURA_RESULT_CAP)).toBe(true);
  });
});

describe('scanWindows', () => {
  it('walks the range in windows of the given size', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const { windows, logs } = await collect(
      scanWindows({ fromBlock: 3n, toBlock: 13n, window: 5n }, fetchWithCap(100n, calls)),
    );
    expect(windows).toEqual([
      [3n, 7n],
      [8n, 12n],
      [13n, 13n],
    ]);
    expect(logs).toEqual([3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n, 13n]);
  });

  it('halves the window on a provider cap and delivers every log once, in order', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const { windows, logs } = await collect(
      scanWindows({ fromBlock: 0n, toBlock: 19n, window: 16n }, fetchWithCap(3n, calls)),
    );
    expect(logs).toEqual(Array.from({ length: 20 }, (_, i) => BigInt(i)));
    expect(windows.every(([lo, hi]) => hi - lo + 1n <= 3n)).toBe(true);
    expect(calls.filter(([lo, hi]) => hi - lo + 1n > 3n)).toEqual([
      [0n, 15n],
      [0n, 7n],
      [0n, 3n],
    ]);
  });

  it('halves the window on a cap the L1 transport wrapped', async () => {
    const { windows, logs } = await collect(
      scanWindows({ fromBlock: 0n, toBlock: 19n, window: 16n }, fetchWithCap(3n, [], wrapLikeL1Transport)),
    );
    expect(logs).toEqual(Array.from({ length: 20 }, (_, i) => BigInt(i)));
    expect(windows.every(([lo, hi]) => hi - lo + 1n <= 3n)).toBe(true);
  });

  it('propagates a cap error on a one-block window', async () => {
    await expect(collect(scanWindows({ fromBlock: 5n, toBlock: 5n, window: 4n }, fetchWithCap(0n)))).rejects.toThrow(
      /more than 10000 results/,
    );
  });

  it('propagates any other error', async () => {
    const fetch = (): Promise<never> => Promise.reject(new Error('ECONNRESET'));
    await expect(collect(scanWindows({ fromBlock: 0n, toBlock: 9n, window: 4n }, fetch))).rejects.toThrow(/ECONNRESET/);
  });

  it('rejects a non-positive window', async () => {
    await expect(collect(scanWindows({ fromBlock: 0n, toBlock: 9n, window: 0n }, fetchWithCap(9n)))).rejects.toThrow(
      /must be positive/,
    );
  });
});
