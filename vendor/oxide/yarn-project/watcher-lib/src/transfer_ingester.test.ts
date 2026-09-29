import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';
import type { Address, Hex, PublicClient } from 'viem';

import type { BlockRef, CursorStore } from './reorg_cursor.js';
import { type TransferEvent, TransferIngester } from './transfer_ingester.js';

const TOKEN_A = EthAddress.fromString('0x000000000000000000000000000000000000aaaa');
const TOKEN_B = EthAddress.fromString('0x000000000000000000000000000000000000bbbb');
const RECIPIENT = EthAddress.fromString('0x0000000000000000000000000000000000000001');
const SENDER = EthAddress.fromString('0x0000000000000000000000000000000000000002');

const defaultHash = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;

function inMemoryCursorStore(initial?: BlockRef): CursorStore {
  let ref = initial;
  return {
    get: () => Promise.resolve(ref),
    set: r => {
      ref = r;
      return Promise.resolve();
    },
  };
}

/** Records every batch handed to `onEvents`, in call order. */
function recordingSink() {
  const batches: TransferEvent[][] = [];
  const reorgs: bigint[] = [];
  return {
    onEvents: (events: TransferEvent[]) => {
      batches.push(events);
      return Promise.resolve();
    },
    onReorg: (from: bigint) => {
      reorgs.push(from);
      return Promise.resolve();
    },
    batches,
    reorgs,
  };
}

/** A transfer log keyed by the block it lands in; `getLogs` returns those within the queried range. */
function transferLog(to: Address, block: bigint, logIndex = 0) {
  return {
    transactionHash: `0x${block.toString(16).padStart(64, '0')}` as Hex,
    blockNumber: block,
    logIndex,
    args: { from: SENDER.toString(), to, value: 1n },
  };
}

function fakeClient(opts: {
  hashAt?: (n: bigint) => Hex;
  logsByToken: Record<string, ReturnType<typeof transferLog>[]>;
  onScan?: (params: { address: Address[]; fromBlock: bigint; toBlock: bigint }) => void;
}): PublicClient {
  const hashAt = opts.hashAt ?? defaultHash;
  return {
    getBlock: ({ blockNumber }: { blockNumber: bigint }) =>
      Promise.resolve({ number: blockNumber, hash: hashAt(blockNumber) }),
    getLogs: ({ address, fromBlock, toBlock }: { address: Address[]; fromBlock: bigint; toBlock: bigint }) => {
      opts.onScan?.({ address, fromBlock, toBlock });
      const logs = address.flatMap(token => (opts.logsByToken[token] ?? []).map(log => ({ ...log, address: token })));
      return Promise.resolve(logs.filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock));
    },
  } as unknown as PublicClient;
}

describe('TransferIngester', () => {
  it('does not scan logs when no tokens are configured', async () => {
    const cursorStore = inMemoryCursorStore({ block: 0n, hash: defaultHash(0n) });
    const { onEvents, batches } = recordingSink();
    const client = fakeClient({
      logsByToken: {},
      onScan: () => {
        throw new Error('unexpected log scan');
      },
    });
    const ingester = new TransferIngester({ publicClient: client, cursorStore, tokens: [], window: 1000n, onEvents });

    await ingester.ingestUpTo(10n, defaultHash(10n));

    expect(batches).toEqual([]);
    await expect(cursorStore.get()).resolves.toEqual({ block: 10n, hash: defaultHash(10n) });
  });

  it('ingests transfers for every configured token and advances the cursor', async () => {
    const { onEvents, onReorg, batches } = recordingSink();
    const cursorStore = inMemoryCursorStore({ block: 10n, hash: defaultHash(10n) });
    const client = fakeClient({
      logsByToken: {
        [TOKEN_A.toString()]: [transferLog(RECIPIENT.toString(), 11n)],
        [TOKEN_B.toString()]: [transferLog(RECIPIENT.toString(), 12n)],
      },
    });
    const ingester = new TransferIngester({
      publicClient: client,
      cursorStore,
      tokens: [TOKEN_A, TOKEN_B],
      window: 1000n,
      onEvents,
      onReorg,
    });

    await ingester.ingestUpTo(12n, defaultHash(12n));

    expect(batches.flat()).toHaveLength(2);
    expect(batches.flat().map(e => e.token)).toEqual(expect.arrayContaining([TOKEN_A, TOKEN_B]));
    expect(batches.flat().map(e => e.sender)).toEqual([SENDER, SENDER]);
    await expect(cursorStore.get()).resolves.toEqual({ block: 12n, hash: defaultHash(12n) });
  });

  it('scans in window-sized chunks, one call for every token, covering the full range in order', async () => {
    const { onEvents, onReorg } = recordingSink();
    const cursorStore = inMemoryCursorStore({ block: 0n, hash: defaultHash(0n) });
    const scans: Array<{ address: Address[]; fromBlock: bigint; toBlock: bigint }> = [];
    const client = fakeClient({ logsByToken: {}, onScan: params => scans.push(params) });
    const ingester = new TransferIngester({
      publicClient: client,
      cursorStore,
      tokens: [TOKEN_A, TOKEN_B],
      window: 5n,
      onEvents,
      onReorg,
    });

    await ingester.ingestUpTo(12n, defaultHash(12n));

    const tokens = [TOKEN_A.toString(), TOKEN_B.toString()];
    expect(scans).toEqual([
      { address: tokens, fromBlock: 1n, toBlock: 5n },
      { address: tokens, fromBlock: 6n, toBlock: 10n },
      { address: tokens, fromBlock: 11n, toBlock: 12n },
    ]);
  });

  it('hands each non-empty window to onEvents as one batch merging all tokens, sorted by block then logIndex', async () => {
    const { onEvents, onReorg, batches } = recordingSink();
    const cursorStore = inMemoryCursorStore({ block: 0n, hash: defaultHash(0n) });
    const client = fakeClient({
      logsByToken: {
        [TOKEN_A.toString()]: [transferLog(RECIPIENT.toString(), 3n, 1), transferLog(RECIPIENT.toString(), 8n)],
        [TOKEN_B.toString()]: [transferLog(RECIPIENT.toString(), 2n), transferLog(RECIPIENT.toString(), 3n, 0)],
      },
    });
    const ingester = new TransferIngester({
      publicClient: client,
      cursorStore,
      tokens: [TOKEN_A, TOKEN_B],
      window: 5n,
      onEvents,
      onReorg,
    });

    await ingester.ingestUpTo(10n, defaultHash(10n));

    // Window [1,5] merges both tokens' events sorted by (block, logIndex); window [6,10] has only token A's.
    expect(batches).toEqual([
      [
        expect.objectContaining({ token: TOKEN_B, block: 2n }),
        expect.objectContaining({ token: TOKEN_B, block: 3n, logIndex: 0 }),
        expect.objectContaining({ token: TOKEN_A, block: 3n, logIndex: 1 }),
      ],
      [expect.objectContaining({ token: TOKEN_A, block: 8n })],
    ]);
  });

  it('starts a fresh cursor near the tip and advances without scanning nothing twice', async () => {
    const { onEvents, onReorg, batches } = recordingSink();
    const cursorStore = inMemoryCursorStore();
    const client = fakeClient({ logsByToken: { [TOKEN_A.toString()]: [transferLog(RECIPIENT.toString(), 990n)] } });
    const ingester = new TransferIngester({
      publicClient: client,
      cursorStore,
      tokens: [TOKEN_A],
      window: 1000n,
      onEvents,
      onReorg,
    });

    await ingester.ingestUpTo(1000n, defaultHash(1000n));

    expect(batches.flat()).toHaveLength(1);
    await expect(cursorStore.get()).resolves.toEqual({ block: 1000n, hash: defaultHash(1000n) });
  });

  it('does nothing but advance the cursor when the tip has not moved', async () => {
    const { onEvents, onReorg, batches } = recordingSink();
    const cursorStore = inMemoryCursorStore({ block: 10n, hash: defaultHash(10n) });
    let scanCalls = 0;
    const client = fakeClient({ logsByToken: {}, onScan: () => scanCalls++ });
    const ingester = new TransferIngester({
      publicClient: client,
      cursorStore,
      tokens: [TOKEN_A],
      window: 1000n,
      onEvents,
      onReorg,
    });

    await ingester.ingestUpTo(10n, defaultHash(10n));

    expect(scanCalls).toBe(0);
    expect(batches).toHaveLength(0);
  });

  it('calls onReorg with the rewound block before rescanning', async () => {
    const { onEvents, onReorg, reorgs } = recordingSink();
    // The cursor believes block 160 has `defaultHash(160)`, but the chain's actual hash at 160 differs — i.e. the
    // block the cursor last scanned was reorged out.
    const cursorStore = inMemoryCursorStore({ block: 160n, hash: defaultHash(160n) });
    const forkHeight = 155n;
    const hashAt = (n: bigint): Hex =>
      n >= forkHeight ? (`0xff${n.toString(16).padStart(62, '0')}` as Hex) : defaultHash(n);
    const client = fakeClient({ hashAt, logsByToken: {} });
    const ingester = new TransferIngester({
      publicClient: client,
      cursorStore,
      tokens: [TOKEN_A],
      window: 1000n,
      onEvents,
      onReorg,
    });

    await ingester.ingestUpTo(161n, hashAt(161n));

    expect(reorgs).toEqual([160n - 64n + 1n]);
  });

  it('leaves the cursor untouched on a mid-scan failure, so a retry rescans the whole range from the previous tip', async () => {
    const cursorStore = inMemoryCursorStore({ block: 0n, hash: defaultHash(0n) });
    const scans: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    let failNextScan = true;
    const client = {
      getBlock: ({ blockNumber }: { blockNumber: bigint }) =>
        Promise.resolve({ number: blockNumber, hash: defaultHash(blockNumber) }),
      getLogs: ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        scans.push({ fromBlock, toBlock });
        if (fromBlock === 6n && failNextScan) {
          failNextScan = false;
          return Promise.reject(new Error('provider error'));
        }
        return Promise.resolve([]);
      },
    } as unknown as PublicClient;
    const { onEvents, onReorg } = recordingSink();
    const ingester = new TransferIngester({
      publicClient: client,
      cursorStore,
      tokens: [TOKEN_A],
      window: 5n,
      onEvents,
      onReorg,
    });

    await expect(ingester.ingestUpTo(10n, defaultHash(10n))).rejects.toThrow('provider error');
    await expect(cursorStore.get()).resolves.toEqual({ block: 0n, hash: defaultHash(0n) });

    scans.length = 0;
    await ingester.ingestUpTo(10n, defaultHash(10n));

    // The retry rescans from the previous tip (block 1), not from where the failed attempt stopped.
    expect(scans).toEqual([
      { fromBlock: 1n, toBlock: 5n },
      { fromBlock: 6n, toBlock: 10n },
    ]);
    await expect(cursorStore.get()).resolves.toEqual({ block: 10n, hash: defaultHash(10n) });
  });
});
