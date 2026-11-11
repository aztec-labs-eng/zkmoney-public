import { describe, expect, it } from '@jest/globals';
import { HttpRequestError, RpcRequestError } from 'viem';

import { scanWindows } from './log_scan.js';

const PROVIDER_URL = 'https://mainnet.infura.io/v3/PROJECT_ID';
const RANGE = { fromBlock: 0n, toBlock: 19n, window: 16n };
const ALL_LOGS = Array.from({ length: 20 }, (_, i) => BigInt(i));

function rpcError(message: string, code = -32005): Error {
  return new RpcRequestError({
    body: { method: 'eth_getLogs', params: [{ fromBlock: '0x18b4293', toBlock: '0x18b42d4' }] },
    error: { code, message },
    url: PROVIDER_URL,
  });
}

function httpError(status: number, details: string): Error {
  return new HttpRequestError({ url: PROVIDER_URL, status, details });
}

function viaL1Transport(cause: Error): Error {
  return new Error('L1 RPC request failed', { cause });
}

function causeCycle(message: string): Error {
  const inner = new Error(message);
  const outer = viaL1Transport(inner);
  (inner as { cause?: unknown }).cause = outer;
  return outer;
}

const WINDOW_ERRORS: Array<[string, number, string]> = [
  ['a Geth range cap', -32602, 'exceed maximum block range 10000'],
  ['a reth range cap', -32602, 'query exceeds max block range 100000'],
  ['a reth result cap', -32602, 'query exceeds max results 20000, retry with the range 23879634-23879696'],
  ['a Besu range cap', -32005, 'Requested range exceeds maximum RPC range limit'],
  ['a Besu timeout', -32603, 'Timeout expired'],
  ['an Erigon range cap', -32602, 'query block range exceeds server limit, narrow your filter: 1000'],
  ['an Erigon result cap', -32602, 'query returns too many logs, narrow your filter: 20000'],
  ['a Nethermind result cap', -32005, 'Too many logs requested. Max logs per response is 20000.'],
  ['an Infura range cap', -32005, 'range 25887126 - 25897126 exceeds limit of 10000'],
  [
    'an Infura result cap',
    -32005,
    'query returned more than 10000 results. Try with this block range [0x18b4293, 0x18b42d4].',
  ],
  ['a QuickNode range cap', -32602, 'eth_getLogs and eth_newFilter are limited to a 10,000 blocks range'],
  ['a BlockPI range cap', -32602, 'eth_getLogs is limited to 1024 block range.'],
  ['a free tier range cap', 35, 'ranges over 10000 blocks are not supported on freetier'],
  ['a size cap', -32603, 'eth_getLogs range is too large, max is 1k blocks'],
  ['a wording that no client uses', -32000, 'the provider said no'],
];

const RATE_LIMITS: Array<[string, unknown]> = [
  ['an HTTP 429 with a status text', viaL1Transport(httpError(429, 'Too Many Requests'))],
  ['an HTTP 429 with no rate limit text', viaL1Transport(httpError(429, '{"message":"capacity exceeded"}'))],
  ['a JSON-RPC code 429', viaL1Transport(rpcError('capacity exceeded', 429))],
  ['a throttle with code -32005', viaL1Transport(rpcError('Too Many Requests'))],
  ['a rate limit text', viaL1Transport(rpcError('rate limit exceeded'))],
  ['a request rate text', viaL1Transport(rpcError('project ID request rate exceeded'))],
  ['a rate limit in a cause cycle', causeCycle('Too Many Requests')],
  ['a rejection that is not an Error', 'Too Many Requests'],
];

/** Rejects each window wider than `maxSpan` with `error`, and returns one log per block for the others. */
function fetchWithCap(maxSpan: bigint, error: Error) {
  return (fromBlock: bigint, toBlock: bigint): Promise<bigint[]> => {
    if (toBlock - fromBlock + 1n > maxSpan) {
      return Promise.reject(error);
    }
    const logs: bigint[] = [];
    for (let b = fromBlock; b <= toBlock; b++) {
      logs.push(b);
    }
    return Promise.resolve(logs);
  };
}

/** Rejects every call with `error`, and records the window of each call. */
function failingFetch(error: unknown) {
  const calls: Array<[bigint, bigint]> = [];
  const fetch = (fromBlock: bigint, toBlock: bigint): Promise<never> => {
    calls.push([fromBlock, toBlock]);
    return Promise.reject(error);
  };
  return { calls, fetch };
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

describe('scanWindows', () => {
  it('walks the range in windows of the given size', async () => {
    const noCap = fetchWithCap(100n, new Error('unused'));
    const { windows, logs } = await collect(scanWindows({ fromBlock: 3n, toBlock: 13n, window: 5n }, noCap));
    expect(windows).toEqual([
      [3n, 7n],
      [8n, 12n],
      [13n, 13n],
    ]);
    expect(logs).toEqual([3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n, 13n]);
  });

  it.each(WINDOW_ERRORS)('delivers every log, once and in order, past %s', async (_, code, message) => {
    const { logs } = await collect(scanWindows(RANGE, fetchWithCap(3n, viaL1Transport(rpcError(message, code)))));
    expect(logs).toEqual(ALL_LOGS);
  });

  it('reaches a one-block window before it gives up on a persistent error', async () => {
    const { calls, fetch } = failingFetch(new Error('ECONNRESET'));
    const range = { fromBlock: 0n, toBlock: 1023n, window: 1024n };
    await expect(collect(scanWindows(range, fetch))).rejects.toThrow('ECONNRESET');
    expect(calls.at(-1)).toEqual([0n, 0n]);
    expect(calls.length).toBeLessThanOrEqual(11);
  });

  it.each(RATE_LIMITS)('stops on the first call on %s', async (_, error) => {
    const { calls, fetch } = failingFetch(error);
    await expect(collect(scanWindows(RANGE, fetch))).rejects.toBe(error);
    expect(calls).toHaveLength(1);
  });

  it('rejects a non-positive window', async () => {
    const { fetch } = failingFetch(new Error('unused'));
    await expect(collect(scanWindows({ fromBlock: 0n, toBlock: 9n, window: 0n }, fetch))).rejects.toThrow(
      /must be positive/,
    );
  });
});
