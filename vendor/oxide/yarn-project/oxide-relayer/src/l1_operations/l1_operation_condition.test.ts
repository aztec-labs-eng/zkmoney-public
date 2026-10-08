import { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import { TxHash } from '@aztec/stdlib/tx';

import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Hex, type PublicClient, pad, toEventSelector } from 'viem';

import { openSqliteStateStore } from '../state/sqlite_store.js';
import { TEST_RELAYER_DEPLOYMENT } from '../state/test_fixtures.js';
import { LogCursorSources, type PendingL1Operation, type StateStore } from '../state/types.js';
import { BalanceWatcher, OutboxWatcher } from './l1_operation_condition.js';
import type { OutboxStatus, WithdrawalCompletion } from './withdrawal_completion.js';

const BROADCASTER = AztecAddress.fromBigIntUnsafe(7n);
const TOKEN = EthAddress.random();
const SIPA = EthAddress.random();
const FUNDER = EthAddress.random();
const L2_TX = TxHash.random();

const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const CHAIN_TIP = 4_321n;
const CHAIN_TIP_HASH = `0x${'cd'.repeat(32)}` as Hex;

const BALANCE_CONDITION: L1OperationCondition = L1OperationCondition.balance(TOKEN, SIPA);
const MAX_AGE_MS = 48 * 60 * 60_000;

function operation(condition: L1OperationCondition, overrides: Partial<PendingL1Operation> = {}): PendingL1Operation {
  return {
    operationId: `0x${condition.kind.toString(16).padStart(2, '0')}${'ab'.repeat(31)}`,
    broadcaster: BROADCASTER,
    l2TxHash: L2_TX.toString(),
    l2BlockNumber: 5n,
    target: EthAddress.random(),
    payoutToken: TOKEN,
    calldata: Buffer.from('deadbeef', 'hex'),
    condition,
    status: 'waiting',
    attempts: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

/** One ERC-20 `Transfer` log as `getLogs` returns it. */
function transferLog(token: EthAddress, to: EthAddress, value: bigint, block: bigint, logIndex = 0) {
  return {
    address: token.toString(),
    topics: [TRANSFER, pad(FUNDER.toString() as Hex, { size: 32 }), pad(to.toString() as Hex, { size: 32 })],
    data: pad(`0x${value.toString(16)}` as Hex, { size: 32 }),
    blockNumber: block,
    transactionHash: `0x${block.toString(16).padStart(64, '0')}` as Hex,
    logIndex,
    args: { from: FUNDER.toString(), to: to.toString(), value },
  };
}

interface ClientOpts {
  balance?: bigint;
  transfers?: ReturnType<typeof transferLog>[];
  tip?: bigint;
  /** Hash the chain reports for an already-scanned block; differing from the stored one is what a reorg looks like. */
  historicalHash?: Hex;
}

function fakePublicClient(opts: ClientOpts = {}) {
  return {
    readContract: jest.fn(() => Promise.resolve(opts.balance ?? 0n)),
    getBlock: jest.fn((args?: { blockNumber?: bigint }) =>
      Promise.resolve(
        args?.blockNumber === undefined
          ? { number: opts.tip ?? CHAIN_TIP, hash: CHAIN_TIP_HASH }
          : { number: args.blockNumber, hash: opts.historicalHash ?? CHAIN_TIP_HASH },
      ),
    ),
    getBlockNumber: jest.fn(() => Promise.resolve(opts.tip ?? CHAIN_TIP)),
    getLogs: jest.fn((args: { address: string[]; fromBlock: bigint; toBlock: bigint }) => {
      const watched = new Set(args.address.map(a => a.toLowerCase()));
      return Promise.resolve(
        (opts.transfers ?? []).filter(
          log =>
            watched.has(log.address.toLowerCase()) &&
            log.blockNumber >= args.fromBlock &&
            log.blockNumber <= args.toBlock,
        ),
      );
    }),
  } as unknown as PublicClient;
}

function balanceWatcher(store: StateStore, client: PublicClient = fakePublicClient()) {
  return new BalanceWatcher({ publicClient: client, store, tokens: [TOKEN], logWindow: 1_000n, maxAgeMs: MAX_AGE_MS });
}

const CURSOR_KEY = { source: LogCursorSources.l1OperationTransferDiscovery, address: EthAddress.ZERO };
const calls = (client: PublicClient, method: 'readContract' | 'getBlock' | 'getLogs') =>
  (client[method] as unknown as jest.Mock).mock.calls;

async function pollAcrossNextBlock(store: StateStore, transfers: ReturnType<typeof transferLog>[]): Promise<number> {
  await balanceWatcher(store).runOnce();
  return balanceWatcher(store, fakePublicClient({ tip: CHAIN_TIP + 1n, transfers })).runOnce();
}

describe('BalanceWatcher', () => {
  it('reads nothing from L1 and drops its cursor while no operation waits on a balance', async () => {
    await withStore(async store => {
      await store.upsertL1Cursor({ ...CURSOR_KEY, blockNumber: 7n, blockHash: CHAIN_TIP_HASH });
      const client = fakePublicClient();

      await expect(balanceWatcher(store, client).runOnce()).resolves.toBe(0);

      expect(calls(client, 'readContract')).toHaveLength(0);
      expect(calls(client, 'getBlock')).toHaveLength(0);
      expect(calls(client, 'getLogs')).toHaveLength(0);
      await expect(store.getL1Cursor(CURSOR_KEY)).resolves.toBeUndefined();
    });
  });

  describe('max age', () => {
    it('drops a waiting Balance operation older than the max age and then reads nothing from L1', async () => {
      await withStore(async store => {
        const expired = operation(BALANCE_CONDITION, { createdAt: new Date(Date.now() - MAX_AGE_MS - 1_000) });
        await store.upsertPendingL1Operation(expired);
        const client = fakePublicClient({ balance: 7n });

        await expect(balanceWatcher(store, client).runOnce()).resolves.toBe(0);

        await expect(store.getPendingL1Operation(expired.operationId)).resolves.toMatchObject({ status: 'dropped' });
        expect(calls(client, 'readContract')).toHaveLength(0);
        expect(calls(client, 'getLogs')).toHaveLength(0);
      });
    });

    it('keeps a waiting Balance operation below the max age', async () => {
      await withStore(async store => {
        const recent = operation(BALANCE_CONDITION, { createdAt: new Date(Date.now() - MAX_AGE_MS + 60_000) });
        await store.upsertPendingL1Operation(recent);

        await balanceWatcher(store, fakePublicClient()).runOnce();

        await expect(store.getPendingL1Operation(recent.operationId)).resolves.toMatchObject({ status: 'waiting' });
      });
    });

    it('drops a waiting Balance operation that an older relayer already read and left', async () => {
      await withStore(async store => {
        const left = operation(BALANCE_CONDITION, {
          createdAt: new Date(Date.now() - MAX_AGE_MS - 1_000),
          lastBalanceCheckAt: new Date(Date.now() - MAX_AGE_MS),
        });
        await store.upsertPendingL1Operation(left);
        await store.upsertL1Cursor({ ...CURSOR_KEY, blockNumber: CHAIN_TIP, blockHash: CHAIN_TIP_HASH });
        const client = fakePublicClient();

        await balanceWatcher(store, client).runOnce();

        await expect(store.getPendingL1Operation(left.operationId)).resolves.toMatchObject({ status: 'dropped' });
        expect(calls(client, 'getLogs')).toHaveLength(0);
        await expect(store.getL1Cursor(CURSOR_KEY)).resolves.toBeUndefined();
      });
    });

    it('does not drop a waiting operation of another condition kind', async () => {
      await withStore(async store => {
        const withdrawal = operation(L1OperationCondition.messageInOutbox(), {
          createdAt: new Date(Date.now() - MAX_AGE_MS - 1_000),
        });
        await store.upsertPendingL1Operation(withdrawal);

        await balanceWatcher(store, fakePublicClient()).runOnce();

        await expect(store.getPendingL1Operation(withdrawal.operationId)).resolves.toMatchObject({ status: 'waiting' });
      });
    });
  });

  it('marks a never-checked operation pending when its recipient was funded before its broadcast was seen', async () => {
    await withStore(async store => {
      const waiting = operation(BALANCE_CONDITION);
      await store.upsertPendingL1Operation(waiting);
      const client = fakePublicClient({ balance: 7n });

      await expect(balanceWatcher(store, client).runOnce()).resolves.toBe(1);

      await expect(store.getPendingL1Operation(waiting.operationId)).resolves.toMatchObject({ status: 'pending' });
      expect(calls(client, 'readContract')[0][0]).toMatchObject({ functionName: 'balanceOf', blockNumber: CHAIN_TIP });
    });
  });

  it('seeds its cursor at the block it read the balance at, so a transfer in the next block is caught', async () => {
    await withStore(async store => {
      const waiting = operation(BALANCE_CONDITION);
      await store.upsertPendingL1Operation(waiting);

      await expect(balanceWatcher(store).runOnce()).resolves.toBe(0);
      await expect(store.getL1Cursor(CURSOR_KEY)).resolves.toMatchObject({
        blockNumber: CHAIN_TIP,
        blockHash: CHAIN_TIP_HASH,
      });

      const client = fakePublicClient({
        tip: CHAIN_TIP + 1n,
        transfers: [transferLog(TOKEN, SIPA, 1_000n, CHAIN_TIP + 1n)],
      });
      await expect(balanceWatcher(store, client).runOnce()).resolves.toBe(1);
      expect(calls(client, 'getLogs')[0][0]).toMatchObject({ fromBlock: CHAIN_TIP + 1n, toBlock: CHAIN_TIP + 1n });
      await expect(store.getPendingL1Operation(waiting.operationId)).resolves.toMatchObject({ status: 'pending' });
    });
  });

  it('reads every waiting balance again when its cursor is absent, checked rows included', async () => {
    await withStore(async store => {
      const waiting = operation(BALANCE_CONDITION);
      await store.upsertPendingL1Operation(waiting);
      await balanceWatcher(store).runOnce();
      await store.deleteL1Cursor(CURSOR_KEY);
      const client = fakePublicClient({ balance: 3n });

      await expect(balanceWatcher(store, client).runOnce()).resolves.toBe(1);

      expect(calls(client, 'readContract')).toHaveLength(1);
      await expect(store.getPendingL1Operation(waiting.operationId)).resolves.toMatchObject({ status: 'pending' });
    });
  });

  it('retries checked balances when activation fails before the cursor is saved', async () => {
    await withStore(async store => {
      const waiting = operation(BALANCE_CONDITION);
      await store.upsertPendingL1Operation(waiting);
      await balanceWatcher(store).runOnce();
      await store.deleteL1Cursor(CURSOR_KEY);
      const client = fakePublicClient({ balance: 3n });
      jest.mocked(client.readContract).mockRejectedValueOnce(new Error('RPC unavailable'));
      const watcher = balanceWatcher(store, client);

      await expect(watcher.runOnce()).rejects.toThrow('RPC unavailable');
      await expect(store.getL1Cursor(CURSOR_KEY)).resolves.toBeUndefined();
      await expect(watcher.runOnce()).resolves.toBe(1);
      await expect(store.getPendingL1Operation(waiting.operationId)).resolves.toMatchObject({ status: 'pending' });
    });
  });

  it('marks every operation that waits on one recipient pending on a single transfer', async () => {
    await withStore(async store => {
      const first = operation(BALANCE_CONDITION, { operationId: `0x${'11'.repeat(32)}` });
      const second = operation(BALANCE_CONDITION, { operationId: `0x${'22'.repeat(32)}` });
      await store.upsertPendingL1Operation(first);
      await store.upsertPendingL1Operation(second);

      await expect(pollAcrossNextBlock(store, [transferLog(TOKEN, SIPA, 1_000n, CHAIN_TIP + 1n)])).resolves.toBe(2);

      await expect(store.getPendingL1Operation(first.operationId)).resolves.toMatchObject({ status: 'pending' });
      await expect(store.getPendingL1Operation(second.operationId)).resolves.toMatchObject({ status: 'pending' });
    });
  });

  it('ignores a zero-value transfer, which funds nothing and anyone can forge', async () => {
    await withStore(async store => {
      const waiting = operation(BALANCE_CONDITION);
      await store.upsertPendingL1Operation(waiting);

      await expect(pollAcrossNextBlock(store, [transferLog(TOKEN, SIPA, 0n, CHAIN_TIP + 1n)])).resolves.toBe(0);
      await expect(store.getPendingL1Operation(waiting.operationId)).resolves.toMatchObject({ status: 'waiting' });
    });
  });

  it('ignores a transfer into a recipient no waiting operation names', async () => {
    await withStore(async store => {
      const waiting = operation(BALANCE_CONDITION);
      await store.upsertPendingL1Operation(waiting);

      const transfers = [transferLog(TOKEN, EthAddress.random(), 5n, CHAIN_TIP + 1n)];
      await expect(pollAcrossNextBlock(store, transfers)).resolves.toBe(0);
      await expect(store.getPendingL1Operation(waiting.operationId)).resolves.toMatchObject({ status: 'waiting' });
    });
  });

  it('marks a still-empty recipient checked so no later poll re-reads it', async () => {
    await withStore(async store => {
      const waiting = operation(BALANCE_CONDITION);
      await store.upsertPendingL1Operation(waiting);

      const client = fakePublicClient();
      const watcher = balanceWatcher(store, client);
      await expect(watcher.runOnce()).resolves.toBe(0);
      await expect(watcher.runOnce()).resolves.toBe(0);

      expect(calls(client, 'readContract')).toHaveLength(1);
      await expect(store.getPendingL1Operation(waiting.operationId)).resolves.toMatchObject({ status: 'waiting' });
    });
  });

  it('leaves a pending operation alone when a reorg takes away the transfer that marked it pending', async () => {
    await withStore(async store => {
      const waiting = operation(BALANCE_CONDITION);
      await store.upsertPendingL1Operation(waiting);
      await expect(pollAcrossNextBlock(store, [transferLog(TOKEN, SIPA, 1_000n, CHAIN_TIP + 1n)])).resolves.toBe(1);
      await expect(store.getPendingL1Operation(waiting.operationId)).resolves.toMatchObject({ status: 'pending' });

      // The chain now reports a different hash for the scanned block: a reorg, and the transfer is not in the
      // rescanned range any more. The submitter, not the watcher, finds out through the reverting quote.
      const reorged = fakePublicClient({ tip: CHAIN_TIP + 2n, historicalHash: `0x${'ef'.repeat(32)}` });
      await expect(balanceWatcher(store, reorged).runOnce()).resolves.toBe(0);
      await expect(store.getPendingL1Operation(waiting.operationId)).resolves.toMatchObject({ status: 'pending' });
    });
  });
});

function fakeCompletion(statuses: OutboxStatus[]): WithdrawalCompletion {
  const outboxStatus = jest.fn(() => Promise.resolve(statuses.shift() ?? statuses[0]!));
  return { outboxStatus } as unknown as WithdrawalCompletion;
}

describe('OutboxWatcher', () => {
  const IN_OUTBOX: L1OperationCondition = L1OperationCondition.messageInOutbox();

  it('leaves an operation waiting while its message has no Outbox witness', async () => {
    await withStore(async store => {
      const waiting = operation(IN_OUTBOX);
      await store.upsertPendingL1Operation(waiting);

      const completion = fakeCompletion(['waiting']);
      await expect(new OutboxWatcher({ completion, store }).runOnce()).resolves.toBe(0);
      await expect(store.getPendingL1Operation(waiting.operationId)).resolves.toMatchObject({ status: 'waiting' });
    });
  });

  it('marks an operation pending once its message is in the Outbox', async () => {
    await withStore(async store => {
      const waiting = operation(IN_OUTBOX);
      await store.upsertPendingL1Operation(waiting);

      const completion = fakeCompletion(['ready']);
      await expect(new OutboxWatcher({ completion, store }).runOnce()).resolves.toBe(1);
      await expect(store.getPendingL1Operation(waiting.operationId)).resolves.toMatchObject({ status: 'pending' });
    });
  });

  it('drops an operation whose tx carries no completable withdrawal', async () => {
    await withStore(async store => {
      const waiting = operation(IN_OUTBOX);
      await store.upsertPendingL1Operation(waiting);

      const completion = fakeCompletion(['unrecoverable']);
      await expect(new OutboxWatcher({ completion, store }).runOnce()).resolves.toBe(0);
      await expect(store.getPendingL1Operation(waiting.operationId)).resolves.toMatchObject({ status: 'dropped' });
    });
  });
});

async function withStore(fn: (store: StateStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oxide-relayer-l1-op-condition-'));
  const store = await openSqliteStateStore(path.join(dir, 'state.sqlite3'), TEST_RELAYER_DEPLOYMENT);
  try {
    await fn(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
