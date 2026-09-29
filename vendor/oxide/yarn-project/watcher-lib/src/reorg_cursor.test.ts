import { describe, expect, it } from '@jest/globals';
import type { Hex, PublicClient } from 'viem';

import { type BlockRef, type CursorStore, ReorgSafeCursor } from './reorg_cursor.js';

/** Deterministic canonical hash of a height; tests override `hashAt` above a fork to simulate a reorg. */
const defaultHash = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;

function inMemoryStore(initial?: BlockRef): CursorStore {
  let ref = initial;
  return {
    get: () => Promise.resolve(ref),
    set: r => {
      ref = r;
      return Promise.resolve();
    },
  };
}

function fakeClient(hashAt: (n: bigint) => Hex = defaultHash): PublicClient {
  return {
    getBlock: ({ blockNumber }: { blockNumber: bigint }) =>
      Promise.resolve({ number: blockNumber, hash: hashAt(blockNumber) }),
  } as unknown as PublicClient;
}

describe('ReorgSafeCursor', () => {
  it('starts a fresh cursor near the tip instead of scanning from genesis', async () => {
    const cursor = new ReorgSafeCursor({ store: inMemoryStore(), publicClient: fakeClient() });

    const result = await cursor.getScanFrom(1000n);

    expect(result).toEqual({ from: 1000n - 64n, rewound: false });
  });

  it('starts from genesis when the tip is shallower than the reorg depth', async () => {
    const cursor = new ReorgSafeCursor({ store: inMemoryStore(), publicClient: fakeClient() });

    const result = await cursor.getScanFrom(10n);

    expect(result).toEqual({ from: 0n, rewound: false });
  });

  it('fails on a missing cursor when requireCursor is set', async () => {
    const cursor = new ReorgSafeCursor({ store: inMemoryStore(), publicClient: fakeClient(), requireCursor: true });

    await expect(cursor.getScanFrom(1000n)).rejects.toThrow(/scan cursor missing/);
  });

  it('continues from cursor + 1 when there is no reorg', async () => {
    const cursor = new ReorgSafeCursor({
      store: inMemoryStore({ block: 10n, hash: defaultHash(10n) }),
      publicClient: fakeClient(),
    });

    const result = await cursor.getScanFrom(42n);

    expect(result).toEqual({ from: 11n, rewound: false });
  });

  it('bridges downtime by scanning the whole gap without a spurious rewind', async () => {
    const cursor = new ReorgSafeCursor({
      store: inMemoryStore({ block: 10n, hash: defaultHash(10n) }),
      publicClient: fakeClient(),
    });

    const result = await cursor.getScanFrom(200n);

    expect(result).toEqual({ from: 11n, rewound: false });
  });

  it('rewinds by maxReorgDepth and flags the rewind when the stored block hash no longer matches the chain', async () => {
    // The cursor believes block 160 has `defaultHash(160)`, but the chain's actual hash at 160 differs — i.e. the
    // block the cursor last scanned was reorged out.
    const forkHeight = 155n;
    const hashAt = (n: bigint): Hex => (n >= forkHeight ? `0xff${n.toString(16).padStart(62, '0')}` : defaultHash(n));
    const cursor = new ReorgSafeCursor({
      store: inMemoryStore({ block: 160n, hash: defaultHash(160n) }),
      publicClient: fakeClient(hashAt),
    });

    const result = await cursor.getScanFrom(161n);

    expect(result).toEqual({ from: 160n - 64n + 1n, rewound: true });
  });

  it('rewinds to genesis when the cursor is shallower than the reorg depth', async () => {
    const cursor = new ReorgSafeCursor({
      store: inMemoryStore({ block: 10n, hash: '0xdeadbeef' as Hex }),
      publicClient: fakeClient(),
    });

    const result = await cursor.getScanFrom(20n);

    expect(result).toEqual({ from: 1n, rewound: true });
  });

  it('treats a cursor above the tip as a reorg and rewinds', async () => {
    const cursor = new ReorgSafeCursor({
      store: inMemoryStore({ block: 100n, hash: defaultHash(100n) }),
      publicClient: fakeClient(),
    });

    const result = await cursor.getScanFrom(90n);

    expect(result).toEqual({ from: 100n - 64n + 1n, rewound: true });
  });

  it('fails instead of rewinding when the tip is impossibly far behind the cursor', async () => {
    const cursor = new ReorgSafeCursor({
      store: inMemoryStore({ block: 1000n, hash: defaultHash(1000n) }),
      publicClient: fakeClient(),
    });

    await expect(cursor.getScanFrom(10n)).rejects.toThrow(/behind the scan cursor/);
  });

  it('respects a custom maxReorgDepth', async () => {
    const cursor = new ReorgSafeCursor({
      store: inMemoryStore(),
      publicClient: fakeClient(),
      maxReorgDepth: 5n,
    });

    const result = await cursor.getScanFrom(100n);

    expect(result).toEqual({ from: 95n, rewound: false });
  });

  it('advance persists the cursor for the next getScanFrom call', async () => {
    const store = inMemoryStore();
    const cursor = new ReorgSafeCursor({ store, publicClient: fakeClient() });

    await cursor.advance(42n, defaultHash(42n));

    await expect(store.get()).resolves.toEqual({ block: 42n, hash: defaultHash(42n) });
    await expect(cursor.getScanFrom(50n)).resolves.toEqual({ from: 43n, rewound: false });
  });
});
