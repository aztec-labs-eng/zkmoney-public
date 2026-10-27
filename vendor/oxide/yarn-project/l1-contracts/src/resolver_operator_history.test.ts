import { describe, expect, it, jest } from '@jest/globals';
import type { PublicClient } from 'viem';

import { readResolverOperatorHistory } from './resolver_operator_history.js';

const registry = '0x1111111111111111111111111111111111111111';
const owner = '0x2222222222222222222222222222222222222222';
const entry = {
  publicKey: { x: 1n, y: 2n },
  l2Address: `0x${'11'.repeat(32)}`,
  url: 'https://resolver.example',
  oxidePortal: '0x3333333333333333333333333333333333333333',
};
const event = (blockNumber: bigint, logIndex: number, l2Address = entry.l2Address) => ({
  args: { resolverOperator: owner, entry: { ...entry, l2Address } },
  blockNumber,
  logIndex,
  removed: false,
});
type Request = { fromBlock: bigint; toBlock: bigint; strict: boolean };
type Event = ReturnType<typeof event>;

/** A client that refuses any query wider than `maxSpan` blocks and answers the others with `answer`. */
const cappedClient = (maxSpan: bigint, answer: (request: Request) => Promise<Event[]>) => {
  const getContractEvents = jest.fn((request: Request) =>
    request.toBlock - request.fromBlock + 1n > maxSpan
      ? Promise.reject(new Error('query exceeds max block range'))
      : answer(request),
  );
  return { getContractEvents, client: { getContractEvents } as unknown as PublicClient };
};
const ranges = (calls: [Request][]) =>
  calls.map(([{ fromBlock, toBlock }]) => [fromBlock, toBlock]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

describe('readResolverOperatorHistory', () => {
  it('retains overwritten entries and sender rotations in chain order without reading current storage', async () => {
    const old = event(1n, 0);
    const rotated = event(2n, 1, `0x${'22'.repeat(32)}`);
    const replacement = {
      ...event(2n, 2),
      args: { resolverOperator: owner, entry: { ...entry, oxidePortal: registry } },
    };
    const getContractEvents = jest.fn((_request: unknown) =>
      Promise.resolve([replacement, { ...old, removed: true }, old, rotated]),
    );
    const records = await readResolverOperatorHistory({ getContractEvents } as unknown as PublicClient, registry, {
      fromBlock: 1n,
      toBlock: 2n,
    });
    expect(records.map(record => record.entry)).toEqual([old.args.entry, rotated.args.entry, replacement.args.entry]);
    expect(records.map(record => record.owner)).toEqual([owner, owner, owner]);
    expect(getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        address: registry,
        eventName: 'ResolverOperatorUpdated',
        fromBlock: 1n,
        toBlock: 2n,
        strict: true,
      }),
    );
  });

  it('reads a wide range in one query when the RPC accepts it', async () => {
    const { getContractEvents, client } = cappedClient(1_000_000n, () => Promise.resolve([event(20_007n, 0)]));
    const records = await readResolverOperatorHistory(client, registry, { fromBlock: 7n, toBlock: 250_006n });
    expect(records.map(record => record.blockNumber)).toEqual([20_007n]);
    expect(ranges(getContractEvents.mock.calls)).toEqual([[7n, 250_006n]]);
  });

  it('reads a refused range in bounded chunks that cover both ends with no gap or overlap', async () => {
    const { getContractEvents, client } = cappedClient(10_000n, () => Promise.resolve([]));
    await readResolverOperatorHistory(client, registry, { fromBlock: 7n, toBlock: 20_007n });
    expect(getContractEvents.mock.calls[0][0]).toMatchObject({ fromBlock: 7n, toBlock: 20_007n });
    expect(ranges(getContractEvents.mock.calls.slice(1))).toEqual([
      [7n, 10_006n],
      [10_007n, 20_006n],
      [20_007n, 20_007n],
    ]);
    expect(getContractEvents.mock.calls.every(([request]) => request.strict)).toBe(true);
  });

  it('reads chunks concurrently up to a bound and sorts results that arrive out of order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { getContractEvents, client } = cappedClient(10_000n, async ({ fromBlock }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Earlier chunks answer later.
      await new Promise(resolve => setTimeout(resolve, Number(100_000n - fromBlock) / 10_000));
      inFlight--;
      return [event(fromBlock + 1n, 1), event(fromBlock + 1n, 0)];
    });
    const records = await readResolverOperatorHistory(client, registry, { fromBlock: 0n, toBlock: 99_999n });
    expect(ranges(getContractEvents.mock.calls.slice(1))).toEqual(
      Array.from({ length: 10 }, (_, i) => [BigInt(i) * 10_000n, BigInt(i) * 10_000n + 9_999n]),
    );
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(6);
    expect(records.map(record => [record.blockNumber, record.logIndex])).toEqual(
      Array.from({ length: 10 }, (_, i) => [
        [BigInt(i) * 10_000n + 1n, 0],
        [BigInt(i) * 10_000n + 1n, 1],
      ]).flat(),
    );
  });

  it('does not retry a refused range that fits in one chunk', async () => {
    const { getContractEvents, client } = cappedClient(0n, () => Promise.resolve([]));
    await expect(readResolverOperatorHistory(client, registry, { fromBlock: 1n, toBlock: 10_000n })).rejects.toThrow(
      'query exceeds max block range',
    );
    expect(getContractEvents).toHaveBeenCalledTimes(1);
  });

  it('rejects a failed later chunk instead of returning partial history', async () => {
    const { client } = cappedClient(10_000n, ({ fromBlock }) =>
      fromBlock === 1n ? Promise.resolve([event(1n, 0)]) : Promise.reject(new Error('RPC unavailable')),
    );
    await expect(readResolverOperatorHistory(client, registry, { fromBlock: 1n, toBlock: 10_001n })).rejects.toThrow(
      'RPC unavailable',
    );
  });

  it('reads nothing for an empty range', async () => {
    const getContractEvents = jest.fn();
    const records = await readResolverOperatorHistory({ getContractEvents } as unknown as PublicClient, registry, {
      fromBlock: 2n,
      toBlock: 1n,
    });
    expect(records).toEqual([]);
    expect(getContractEvents).not.toHaveBeenCalled();
  });
});
