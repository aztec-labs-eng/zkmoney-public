import { jest } from '@jest/globals';

import { waitForRpcHead } from './rpc_head.js';

describe('waitForRpcHead', () => {
  const noSleep = (): Promise<void> => Promise.resolve();

  function makeClient(heads: bigint[]): {
    getBlockNumber: jest.Mock<(args?: { cacheTime?: number }) => Promise<bigint>>;
  } {
    let i = 0;
    const getBlockNumber = jest.fn((_args?: { cacheTime?: number }): Promise<bigint> => {
      const value = heads[Math.min(i, heads.length - 1)];
      i += 1;
      return Promise.resolve(value);
    });
    return { getBlockNumber };
  }

  test('returns immediately when head ≥ target on the first poll', async () => {
    const client = makeClient([42n]);
    await waitForRpcHead(client, 42n, { sleep: noSleep });
    expect(client.getBlockNumber).toHaveBeenCalledTimes(1);
  });

  test('always bypasses viem getBlockNumber cache', async () => {
    const client = makeClient([7n]);
    await waitForRpcHead(client, 7n, { sleep: noSleep });
    expect(client.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
  });

  test('polls until a lagging replica catches up to the receipt block', async () => {
    // Replica is two blocks behind on the first two polls, then catches up.
    const client = makeClient([100n, 100n, 102n]);
    const sleep = jest.fn((_ms: number): Promise<void> => Promise.resolve());
    await waitForRpcHead(client, 102n, { sleep });
    expect(client.getBlockNumber).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test('uses exponential backoff capped at maxDelayMs', async () => {
    const client = makeClient([0n, 0n, 0n, 0n, 0n, 5n]);
    const sleep = jest.fn((_ms: number): Promise<void> => Promise.resolve());
    await waitForRpcHead(client, 5n, {
      initialDelayMs: 100,
      maxDelayMs: 400,
      sleep,
    });
    // Backoff: 100 → 200 → 400 → 400 → 400, then the head finally catches up.
    expect(sleep.mock.calls.map(c => c[0])).toEqual([100, 200, 400, 400, 400]);
  });

  test('throws a descriptive error when the deadline elapses before the head catches up', async () => {
    const client = makeClient([10n]); // permanently stuck at block 10
    let fakeNow = 1_000;
    const now = (): number => fakeNow;
    const sleep = jest.fn((ms: number): Promise<void> => {
      fakeNow += ms;
      return Promise.resolve();
    });
    await expect(
      waitForRpcHead(client, 15n, {
        timeoutMs: 1_000,
        initialDelayMs: 250,
        maxDelayMs: 250,
        now,
        sleep,
      }),
    ).rejects.toThrow(/RPC head 10 still behind receipt block 15 after 1000ms/);
  });

  test('still issues at least one poll when target is 0', async () => {
    // Edge case: a fresh chain or a tx mined at genesis-adjacent blocks. The poll should still
    // confirm via the RPC (it's the same load-balanced fan-out concern) rather than short-circuit.
    const client = makeClient([0n]);
    await waitForRpcHead(client, 0n, { sleep: noSleep });
    expect(client.getBlockNumber).toHaveBeenCalledTimes(1);
  });
});
