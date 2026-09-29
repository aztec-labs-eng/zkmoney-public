import { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import type { AztecNode } from '@aztec/aztec.js/node';
import { BlockHash } from '@aztec/stdlib/block';
import type { Tx } from '@aztec/stdlib/tx';
import { TxHash } from '@aztec/stdlib/tx';

import {
  L1OperationCondition,
  L1OperationConditionKind,
  encodeL1OperationCalldata,
  l1OperationEventSelector,
} from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PublicClient } from 'viem';

import { openSqliteStateStore } from '../state/sqlite_store.js';
import { TEST_RELAYER_DEPLOYMENT } from '../state/test_fixtures.js';
import { LogCursorSources, type StateStore } from '../state/types.js';
import { BalanceWatcher, OutboxWatcher } from './l1_operation_condition.js';
import { L1OperationSyncer, type L1OperationSyncerDeps } from './l1_operation_syncer.js';
import type { OutboxStatus, WithdrawalCompletion } from './withdrawal_completion.js';

const BROADCASTER = AztecAddress.fromBigIntUnsafe(7n);
const TARGET = EthAddress.random();
const PAYOUT_TOKEN = EthAddress.random();
const WATCHED_TOKEN = EthAddress.random();
const UNWATCHED_TOKEN = EthAddress.random();
const SIPA = EthAddress.random();
const CALLDATA = Buffer.from('deadbeef00c0ffee', 'hex');
const TX_HASH = TxHash.random();
const BROADCAST_BLOCK = 5;
const L1_TIP = 4_321n;

const BALANCE_CONDITION: L1OperationCondition = L1OperationCondition.balance(WATCHED_TOKEN, SIPA);

async function fakeTx(condition: L1OperationCondition, payoutToken: EthAddress): Promise<Tx> {
  const selector = await l1OperationEventSelector();
  const { bytesLen, fields } = encodeL1OperationCalldata(CALLDATA);
  const { kind, token, recipient } = condition;
  const values = [
    selector.toField(),
    TARGET.toField(),
    payoutToken.toField(),
    new Fr(bytesLen),
    new Fr(kind),
    token.toField(),
    recipient.toField(),
    ...fields,
  ];
  return { publicFunctionCalldata: [{ values }] } as unknown as Tx;
}

function fakeNode(
  head: number,
  proven: number,
  opts: {
    txAvailable?: boolean;
    condition?: L1OperationCondition;
    payoutToken?: EthAddress;
    broadcastBlock?: number;
    txHashes?: TxHash[];
  } = {},
) {
  const block = opts.broadcastBlock ?? BROADCAST_BLOCK;
  return {
    getBlockNumber: jest.fn((status?: string) => Promise.resolve(status === 'proven' ? proven : head)),
    getPublicLogsByTags: jest.fn((query: { fromBlock: number; toBlock: number }) => {
      const logs =
        query.fromBlock <= block && query.toBlock > block
          ? (opts.txHashes ?? [TX_HASH]).map(txHash => ({
              logData: [Fr.random()],
              txHash,
              blockNumber: block,
              blockHash: BlockHash.random(),
            }))
          : [];
      return Promise.resolve([logs]);
    }),
    getTxByHash: jest.fn(() =>
      opts.txAvailable === false
        ? Promise.resolve(undefined)
        : fakeTx(opts.condition ?? L1OperationCondition.immediate(), opts.payoutToken ?? PAYOUT_TOKEN),
    ),
    getTxReceipt: jest.fn(() => Promise.resolve({ blockNumber: block, blockHash: BlockHash.random() })),
  } as unknown as AztecNode;
}

/** A client whose `balanceOf` answers `balance` for every recipient, and whose transfer scan finds nothing. */
function fakePublicClient(balance = 0n) {
  return {
    readContract: jest.fn(() => Promise.resolve(balance)),
    getBlock: jest.fn(() => Promise.resolve({ number: L1_TIP, hash: `0x${'cd'.repeat(32)}` })),
    getLogs: jest.fn(() => Promise.resolve([])),
    getBlockNumber: jest.fn(() => Promise.resolve(L1_TIP)),
  } as unknown as PublicClient;
}

function fakeCompletion(status: OutboxStatus): WithdrawalCompletion {
  return { outboxStatus: jest.fn(() => Promise.resolve(status)) } as unknown as WithdrawalCompletion;
}

function buildSyncer(
  store: StateStore,
  node: AztecNode,
  opts: {
    balance?: bigint;
    outboxStatus?: OutboxStatus;
    telemetry?: L1OperationSyncerDeps['telemetry'];
    logger?: L1OperationSyncerDeps['logger'];
  } = {},
): L1OperationSyncer {
  return new L1OperationSyncer({
    node,
    store,
    broadcaster: BROADCASTER,
    payoutToken: PAYOUT_TOKEN,
    supportedTokens: [WATCHED_TOKEN],
    telemetry: opts.telemetry,
    logger: opts.logger,
    balanceWatcher: new BalanceWatcher({
      publicClient: fakePublicClient(opts.balance ?? 0n),
      store,
      tokens: [WATCHED_TOKEN],
      logWindow: 1_000n,
    }),
    outboxWatcher: new OutboxWatcher({ completion: fakeCompletion(opts.outboxStatus ?? 'waiting'), store }),
  });
}

const CURSOR_KEY = {
  source: LogCursorSources.l1OperationBroadcaster,
  address: BROADCASTER,
} as const;

describe('L1OperationSyncer', () => {
  it('recovers the operation from the broadcast tx and commits only the proven cursor', async () => {
    await withStore(async store => {
      await expect(buildSyncer(store, fakeNode(10, 4)).runOnce()).resolves.toMatchObject({ discovered: 1 });

      const [operation] = await store.listPendingL1Operations();
      expect(operation).toMatchObject({
        broadcaster: BROADCASTER,
        l2TxHash: TX_HASH.toString(),
        l2BlockNumber: 5n,
        target: TARGET,
        payoutToken: PAYOUT_TOKEN,
        condition: L1OperationCondition.immediate(),
        status: 'pending',
        attempts: 0,
      });
      expect(operation.calldata.equals(CALLDATA)).toBe(true);

      await expect(store.getL2Cursor(CURSOR_KEY)).resolves.toMatchObject({ blockNumber: 4n });
    });
  });

  it('holds a Balance operation on an empty recipient, and the submitter never sees it', async () => {
    await withStore(async store => {
      const node = fakeNode(10, 4, { condition: BALANCE_CONDITION });
      await expect(buildSyncer(store, node).runOnce()).resolves.toMatchObject({ discovered: 1, markedPending: 0 });

      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);
      const [waiting] = await store.listWaitingL1Operations(L1OperationConditionKind.Balance);
      expect(waiting).toMatchObject({ status: 'waiting', condition: BALANCE_CONDITION });
      // The balance watcher ran on the same poll and recorded its first check.
      expect(waiting.lastBalanceCheckAt).toBeInstanceOf(Date);
    });
  });

  it('marks a Balance operation pending whose recipient is already funded on the poll that discovers it', async () => {
    await withStore(async store => {
      const node = fakeNode(10, 4, { condition: BALANCE_CONDITION });
      await expect(buildSyncer(store, node, { balance: 1_000n }).runOnce()).resolves.toMatchObject({
        discovered: 1,
        markedPending: 1,
      });

      const [operation] = await store.listPendingL1Operations();
      expect(operation).toMatchObject({ status: 'pending', condition: BALANCE_CONDITION });
    });
  });

  it('never stores a Balance operation naming a token this relayer does not watch', async () => {
    await withStore(async store => {
      const condition: L1OperationCondition = L1OperationCondition.balance(UNWATCHED_TOKEN, SIPA);
      await expect(buildSyncer(store, fakeNode(10, 4, { condition })).runOnce()).resolves.toMatchObject({
        discovered: 0,
      });

      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);
      await expect(store.listWaitingL1Operations(L1OperationConditionKind.Balance)).resolves.toHaveLength(0);
    });
  });

  it('never stores an operation that pays out in a token this relayer does not accept', async () => {
    await withStore(async store => {
      const node = fakeNode(10, 4, { payoutToken: EthAddress.random() });
      await expect(buildSyncer(store, node).runOnce()).resolves.toMatchObject({ discovered: 0 });

      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);
      // The broadcast is still consumed: the cursor moves past it.
      await expect(store.getL2Cursor(CURSOR_KEY)).resolves.toMatchObject({ blockNumber: 4n });
    });
  });

  it('stores a Balance operation waiting when there is no balance watcher', async () => {
    await withStore(async store => {
      const node = fakeNode(10, 4, { condition: BALANCE_CONDITION });
      const syncer = new L1OperationSyncer({
        node,
        store,
        broadcaster: BROADCASTER,
        payoutToken: PAYOUT_TOKEN,
        supportedTokens: [WATCHED_TOKEN],
      });
      await expect(syncer.runOnce()).resolves.toMatchObject({ discovered: 1, markedPending: 0 });

      const [waiting] = await store.listWaitingL1Operations(L1OperationConditionKind.Balance);
      expect(waiting).toMatchObject({ status: 'waiting', lastBalanceCheckAt: undefined });
    });
  });

  it('holds a MessageInOutbox operation until its message reaches the Outbox', async () => {
    await withStore(async store => {
      const condition: L1OperationCondition = L1OperationCondition.messageInOutbox();
      const node = fakeNode(10, 4, { condition });
      await expect(buildSyncer(store, node, { outboxStatus: 'waiting' }).runOnce()).resolves.toMatchObject({
        discovered: 1,
        markedPending: 0,
      });
      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);
      await expect(store.listWaitingL1Operations(L1OperationConditionKind.MessageInOutbox)).resolves.toHaveLength(1);

      // The same broadcast, now with a witness on the Outbox.
      await expect(buildSyncer(store, node, { outboxStatus: 'ready' }).runOnce()).resolves.toMatchObject({
        markedPending: 1,
      });
      await expect(store.listPendingL1Operations()).resolves.toHaveLength(1);
    });
  });

  it('retains two equal withdrawal payloads through discovery and restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'oxide-withdrawal-pair-'));
    const file = path.join(directory, 'state.sqlite3');
    let store = await openSqliteStateStore(file, TEST_RELAYER_DEPLOYMENT);
    try {
      const hashes = [TxHash.random(), TxHash.random()];
      const node = fakeNode(10, 4, { condition: L1OperationCondition.messageInOutbox(), txHashes: hashes });
      await expect(buildSyncer(store, node).runOnce()).resolves.toMatchObject({ discovered: 2 });
      const waiting = await store.listWaitingL1Operations(L1OperationConditionKind.MessageInOutbox);
      expect(waiting).toHaveLength(2);
      expect(new Set(waiting.map(operation => operation.operationId)).size).toBe(2);
      expect(new Set(waiting.map(operation => operation.l2TxHash))).toEqual(
        new Set(hashes.map(hash => hash.toString())),
      );
      await store.close();
      store = await openSqliteStateStore(file, TEST_RELAYER_DEPLOYMENT);
      await expect(buildSyncer(store, node, { outboxStatus: 'ready' }).runOnce()).resolves.toMatchObject({
        discovered: 0,
        markedPending: 2,
      });
      expect(await store.listPendingL1Operations()).toHaveLength(2);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not report discovery success before the entire batch is stored', async () => {
    await withStore(async store => {
      const outcome = jest.fn();
      const info = jest.fn();
      const telemetry = { l1OperationOutcome: outcome } as unknown as L1OperationSyncerDeps['telemetry'];
      const logger = { info, debug: jest.fn(), warn: jest.fn() } as unknown as L1OperationSyncerDeps['logger'];
      const node = fakeNode(10, 4, { condition: L1OperationCondition.messageInOutbox() });
      const syncer = buildSyncer(store, node, { telemetry, logger });
      jest.spyOn(store, 'upsertPendingL1Operation').mockRejectedValueOnce(new Error('batch rejected'));
      await expect(syncer.runOnce()).rejects.toThrow('batch rejected');
      expect(outcome).not.toHaveBeenCalled();
      expect(
        info.mock.calls.filter(call => (call[1] as { event?: string })?.event === 'l1_operation_discovered'),
      ).toHaveLength(0);
      await expect(syncer.runOnce()).resolves.toMatchObject({ discovered: 1 });
      expect(outcome).toHaveBeenCalledWith('waiting');
    });
  });

  it('retains the stored identity of a legacy withdrawal during rescan', async () => {
    await withStore(async store => {
      const operationId = `0x${'ab'.repeat(32)}` as const;
      await store.upsertPendingL1Operation({
        operationId,
        broadcaster: BROADCASTER,
        l2TxHash: TX_HASH.toString(),
        l2BlockNumber: BigInt(BROADCAST_BLOCK),
        target: TARGET,
        payoutToken: PAYOUT_TOKEN,
        calldata: CALLDATA,
        condition: L1OperationCondition.messageInOutbox(),
        status: 'waiting',
        attempts: 0,
      });
      const node = fakeNode(10, 4, { condition: L1OperationCondition.messageInOutbox() });
      await expect(buildSyncer(store, node, { outboxStatus: 'ready' }).runOnce()).resolves.toMatchObject({
        discovered: 0,
        markedPending: 1,
      });
      const pending = await store.listPendingL1Operations();
      expect(pending).toHaveLength(1);
      expect(pending[0].operationId).toBe(operationId);
      expect(node.getTxByHash).not.toHaveBeenCalled();
    });
  });

  it('re-scans the unproven window without re-fetching known broadcast txs', async () => {
    await withStore(async store => {
      const node = fakeNode(10, 4);
      const syncer = buildSyncer(store, node);
      await expect(syncer.runOnce()).resolves.toMatchObject({ discovered: 1 });
      await expect(syncer.runOnce()).resolves.toMatchObject({ discovered: 0 });
      expect((node.getTxByHash as jest.Mock).mock.calls).toHaveLength(1);
      await expect(store.listPendingL1Operations()).resolves.toHaveLength(1);
    });
  });

  it('re-anchors a known broadcast that came back in another block', async () => {
    await withStore(async store => {
      await buildSyncer(store, fakeNode(10, 4)).runOnce();
      await buildSyncer(store, fakeNode(10, 4, { broadcastBlock: 8 })).runOnce();

      const [operation] = await store.listPendingL1Operations();
      expect(operation.l2BlockNumber).toBe(8n);
    });
  });

  it('does not resurrect a terminal operation on re-scan', async () => {
    await withStore(async store => {
      const syncer = buildSyncer(store, fakeNode(10, 4));
      await syncer.runOnce();
      const [operation] = await store.listPendingL1Operations();
      await store.setL1OperationStatus(operation.operationId, 'executed');

      await expect(syncer.runOnce()).resolves.toMatchObject({ discovered: 0 });
      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);
      await expect(store.getPendingL1Operation(operation.operationId)).resolves.toMatchObject({ status: 'executed' });
    });
  });

  it('loses the payload gracefully when the node no longer holds the tx', async () => {
    await withStore(async store => {
      const syncer = buildSyncer(store, fakeNode(10, 4, { txAvailable: false }));
      await expect(syncer.runOnce()).resolves.toMatchObject({ discovered: 0 });
      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);
      await expect(store.getL2Cursor(CURSOR_KEY)).resolves.toMatchObject({ blockNumber: 4n });
    });
  });

  it('bootstraps a fresh cursor at the proven tip instead of scanning history', async () => {
    await withStore(async store => {
      // The broadcast (block 5) is below the proven tip (6): its payload is pruned, so a fresh store skips it.
      const node = fakeNode(10, 6);
      await expect(buildSyncer(store, node).runOnce()).resolves.toMatchObject({ discovered: 0 });
      expect((node.getTxByHash as jest.Mock).mock.calls).toHaveLength(0);
      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);
      await expect(store.getL2Cursor(CURSOR_KEY)).resolves.toMatchObject({ blockNumber: 6n });
    });
  });
});

async function withStore(fn: (store: StateStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oxide-relayer-l1-op-sync-'));
  const store = await openSqliteStateStore(path.join(dir, 'state.sqlite3'), TEST_RELAYER_DEPLOYMENT);
  try {
    await fn(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
