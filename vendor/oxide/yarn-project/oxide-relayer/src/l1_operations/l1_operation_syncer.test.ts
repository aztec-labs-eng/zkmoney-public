import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { BlockHash } from '@aztec-labs/stdlib/block';
import type { Tx } from '@aztec-labs/stdlib/tx';
import { TxHash } from '@aztec-labs/stdlib/tx';

import { SipaIntent, buildSipaDeployAndSweepOperation, buildSipaSweepOperation } from '@oxide/l1-contracts';
import {
  L1OperationCondition,
  L1OperationConditionKind,
  computeL1OperationId,
  encodeL1OperationCalldata,
  l1OperationEventSelector,
} from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Address, type Hex, type PublicClient, keccak256 } from 'viem';

import { openSqliteStateStore } from '../state/sqlite_store.js';
import { TEST_RELAYER_DEPLOYMENT } from '../state/test_fixtures.js';
import { LogCursorSources, type StateStore } from '../state/types.js';
import { BalanceWatcher, OutboxWatcher } from './l1_operation_condition.js';
import type { L1OperationOwnership } from './l1_operation_router.js';
import { L1OperationSyncer, type L1OperationSyncerDeps } from './l1_operation_syncer.js';
import type { PayoutTokenFilter } from './payout_token_registry.js';
import type { OutboxStatus, WithdrawalCompletion } from './withdrawal_completion.js';

/** A worker that is alone on its Broadcaster, so it handles every operation. */
const OWNS_ALL: L1OperationOwnership = { owns: () => true, givesWayTo: () => Promise.resolve(undefined) };
/** A payout-token filter that accepts exactly `tokens`. */
function acceptsOnly(...tokens: EthAddress[]): PayoutTokenFilter {
  return { accepts: token => tokens.some(accepted => accepted.equals(token)) };
}

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

/** An operation that `fakeNode` broadcasts. Its target defaults to `TARGET`. */
interface FakeOperation {
  target?: EthAddress;
  condition: L1OperationCondition;
  calldata: Buffer;
}

async function fakeTx(operations: FakeOperation[], payoutToken: EthAddress): Promise<Tx> {
  const selector = await l1OperationEventSelector();
  const requests = operations.map(({ target = TARGET, condition, calldata }) => {
    const { bytesLen, fields } = encodeL1OperationCalldata(calldata);
    const { kind, token, recipient } = condition;
    const values = [
      selector.toField(),
      target.toField(),
      payoutToken.toField(),
      new Fr(bytesLen),
      new Fr(kind),
      token.toField(),
      recipient.toField(),
      ...fields,
    ];
    return { request: { contractAddress: BROADCASTER }, calldata: values };
  });
  return { getPublicCallRequestsWithCalldata: () => requests } as unknown as Tx;
}

function fakeNode(
  head: number,
  proven: number,
  opts: {
    txAvailable?: boolean;
    condition?: L1OperationCondition;
    payoutToken?: EthAddress;
    /** The operations in the broadcast tx. Defaults to one operation with `condition` and `CALLDATA`. */
    operations?: FakeOperation[];
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
        : fakeTx(
            opts.operations ?? [{ condition: opts.condition ?? L1OperationCondition.immediate(), calldata: CALLDATA }],
            opts.payoutToken ?? PAYOUT_TOKEN,
          ),
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
    watchedTokens?: EthAddress[];
    outboxStatus?: OutboxStatus;
    ownership?: L1OperationOwnership;
    telemetry?: L1OperationSyncerDeps['telemetry'];
    logger?: L1OperationSyncerDeps['logger'];
  } = {},
): L1OperationSyncer {
  return new L1OperationSyncer({
    node,
    store,
    broadcaster: BROADCASTER,
    ownership: opts.ownership ?? OWNS_ALL,
    payoutTokens: acceptsOnly(PAYOUT_TOKEN),
    watchedTokens: opts.watchedTokens ?? [WATCHED_TOKEN],
    telemetry: opts.telemetry,
    logger: opts.logger,
    balanceWatcher: new BalanceWatcher({
      publicClient: fakePublicClient(opts.balance ?? 0n),
      store,
      tokens: opts.watchedTokens ?? [WATCHED_TOKEN],
      logWindow: 1_000n,
      maxAgeMs: 48 * 60 * 60_000,
    }),
    outboxWatcher: new OutboxWatcher({ completion: fakeCompletion(opts.outboxStatus ?? { status: 'waiting' }), store }),
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

  it.each([
    ['Immediate', L1OperationCondition.immediate()],
    ['Balance', BALANCE_CONDITION],
    ['MessageInOutbox', L1OperationCondition.messageInOutbox()],
  ])(
    'never stores a %s operation that pays out in a token this relayer does not accept',
    async (_kind, condition: L1OperationCondition) => {
      // The lookup finds the same operation when it pays out in the accepted token, at whatever status it gets.
      await withStore(async store => {
        await buildSyncer(store, fakeNode(10, 4, { condition })).runOnce();
        await expect(storedOperation(store, condition, PAYOUT_TOKEN)).resolves.toBeDefined();
      });

      await withStore(async store => {
        const payoutToken = EthAddress.random();
        const node = fakeNode(10, 4, { condition, payoutToken });
        await expect(buildSyncer(store, node).runOnce()).resolves.toMatchObject({ discovered: 0 });

        await expect(storedOperation(store, condition, payoutToken)).resolves.toBeUndefined();
        // The broadcast is still consumed: the cursor moves past it.
        await expect(store.getL2Cursor(CURSOR_KEY)).resolves.toMatchObject({ blockNumber: 4n });
      });
    },
  );

  it('never stores an operation that another worker on the broadcaster handles, and counts no skip', async () => {
    await withStore(async store => {
      const skipped = jest.fn();
      const telemetry = { l1OperationSkippedFor: skipped } as unknown as L1OperationSyncerDeps['telemetry'];
      const ownership: L1OperationOwnership = { owns: () => false, givesWayTo: () => Promise.resolve(undefined) };
      await expect(buildSyncer(store, fakeNode(10, 4), { ownership, telemetry }).runOnce()).resolves.toMatchObject({
        discovered: 0,
      });

      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);
      expect(skipped).not.toHaveBeenCalled();
      // The broadcast is still consumed: the cursor moves past it.
      await expect(store.getL2Cursor(CURSOR_KEY)).resolves.toMatchObject({ blockNumber: 4n });
    });
  });

  it('stores an operation that pays out in any accepted token', async () => {
    await withStore(async store => {
      const syncer = new L1OperationSyncer({
        node: fakeNode(10, 4),
        store,
        broadcaster: BROADCASTER,
        ownership: OWNS_ALL,
        payoutTokens: acceptsOnly(EthAddress.random(), PAYOUT_TOKEN),
        watchedTokens: [WATCHED_TOKEN],
      });
      await expect(syncer.runOnce()).resolves.toMatchObject({ discovered: 1 });
    });
  });

  it('stores a Balance operation waiting when there is no balance watcher', async () => {
    await withStore(async store => {
      const node = fakeNode(10, 4, { condition: BALANCE_CONDITION });
      const syncer = new L1OperationSyncer({
        node,
        store,
        broadcaster: BROADCASTER,
        ownership: OWNS_ALL,
        payoutTokens: acceptsOnly(PAYOUT_TOKEN),
        watchedTokens: [WATCHED_TOKEN],
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
      await expect(buildSyncer(store, node, { outboxStatus: { status: 'waiting' } }).runOnce()).resolves.toMatchObject({
        discovered: 1,
        markedPending: 0,
      });
      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);
      await expect(store.listWaitingL1Operations(L1OperationConditionKind.MessageInOutbox)).resolves.toHaveLength(1);

      // The same broadcast, now with a witness on the Outbox.
      await expect(buildSyncer(store, node, { outboxStatus: { status: 'ready' } }).runOnce()).resolves.toMatchObject({
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
      await expect(buildSyncer(store, node, { outboxStatus: { status: 'ready' } }).runOnce()).resolves.toMatchObject({
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
      expect(outcome).toHaveBeenCalledWith('waiting', 'withdrawal_finalization');
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
        createdAt: new Date(),
      });
      const node = fakeNode(10, 4, { condition: L1OperationCondition.messageInOutbox() });
      await expect(buildSyncer(store, node, { outboxStatus: { status: 'ready' } }).runOnce()).resolves.toMatchObject({
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

  it.each([
    ['payout_token', { payoutToken: EthAddress.random() }],
    ['unwatched_balance_token', { condition: L1OperationCondition.balance(UNWATCHED_TOKEN, SIPA) }],
  ] as const)('counts a %s skip once across re-scans of the unproven window', async (reason, opts) => {
    await withStore(async store => {
      const skipped = jest.fn();
      const telemetry = { l1OperationSkippedFor: skipped } as unknown as L1OperationSyncerDeps['telemetry'];
      const syncer = buildSyncer(store, fakeNode(10, 4, opts), { telemetry });
      await syncer.runOnce();
      await syncer.runOnce();
      expect(skipped.mock.calls).toEqual([[reason, 'other']]);
    });
  });

  it('counts a skip again after the proven cursor passes its block', async () => {
    await withStore(async store => {
      const skipped = jest.fn();
      const telemetry = { l1OperationSkippedFor: skipped } as unknown as L1OperationSyncerDeps['telemetry'];
      const payoutToken = EthAddress.random();
      const node = fakeNode(10, 4, { payoutToken });
      const syncer = buildSyncer(store, node, { telemetry });
      await syncer.runOnce();
      Object.assign(node, fakeNode(10, 6, { payoutToken }));
      await syncer.runOnce();
      Object.assign(node, fakeNode(10, 6, { payoutToken, broadcastBlock: 8 }));
      await syncer.runOnce();
      expect(skipped.mock.calls).toEqual([
        ['payout_token', 'other'],
        ['payout_token', 'other'],
      ]);
    });
  });

  it('counts a skip once when its broadcast is re-included in a later block', async () => {
    await withStore(async store => {
      const skipped = jest.fn();
      const telemetry = { l1OperationSkippedFor: skipped } as unknown as L1OperationSyncerDeps['telemetry'];
      const payoutToken = EthAddress.random();
      const node = fakeNode(10, 4, { payoutToken });
      const syncer = buildSyncer(store, node, { telemetry });
      await syncer.runOnce();
      Object.assign(node, fakeNode(10, 4, { payoutToken, broadcastBlock: 8 }));
      await syncer.runOnce();
      Object.assign(node, fakeNode(10, 6, { payoutToken, broadcastBlock: 8 }));
      await syncer.runOnce();
      await syncer.runOnce();
      expect(skipped.mock.calls).toEqual([['payout_token', 'other']]);
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

  it.each([
    ['sweep', (token: EthAddress) => buildSipaSweepOperation(sipaSweep(token))],
    [
      'deployAndSweepForSubsidy',
      (token: EthAddress) =>
        buildSipaDeployAndSweepOperation({ ...sipaDeploy(token), depositSubsidy: TARGET.toString() as Address }),
    ],
  ])('stores a Balance %s once, for the token it sweeps, when the relayer watches more tokens', async (_, build) => {
    await withStore(async store => {
      const tokens = [EthAddress.random(), EthAddress.random(), EthAddress.random()];
      const operation = build(tokens[1]);
      const node = fakeNode(10, 4, { operations: [operation] });
      const syncer = buildSyncer(store, node, { watchedTokens: tokens });
      await expect(syncer.runOnce()).resolves.toMatchObject({ discovered: 1 });

      const [waiting] = await store.listWaitingL1Operations(L1OperationConditionKind.Balance);
      expect(waiting.operationId).toBe(computeL1OperationId(operation));
      expect(waiting.calldata.equals(operation.calldata)).toBe(true);
    });
  });
});

/** A SIPA sweep of `token` that waits for the SIPA to hold it. */
function sipaSweep(token: EthAddress) {
  return {
    sipa: SIPA.toString() as Address,
    sweepArgs: {
      token: token.toString() as Address,
      relayer: TARGET.toString() as Address,
      intentData: '0x1234' as Hex,
      proofs: '0x' as Hex,
    },
    payoutToken: PAYOUT_TOKEN.toString() as Address,
    condition: L1OperationCondition.balance(token, SIPA),
  };
}

function sipaDeploy(token: EthAddress) {
  return {
    ...sipaSweep(token),
    sipaFactory: EthAddress.random().toString() as Address,
    intent: SipaIntent.Deposit,
    deployArgs: {
      implementation: EthAddress.random().toString() as Address,
      intentHash: keccak256('0x1234'),
      recoveryCommitment: `0x${'77'.repeat(32)}` as Hex,
      rollupVersion: 1n,
      resweepable: true,
      forwardingTable: EthAddress.random().toString() as Address,
    },
  };
}

/** The stored row, at any status, for the operation that `fakeNode` broadcasts with `condition` and `payoutToken`. */
function storedOperation(store: StateStore, condition: L1OperationCondition, payoutToken: EthAddress) {
  const operationId = computeL1OperationId({ target: TARGET, payoutToken, calldata: CALLDATA, condition }, TX_HASH);
  return store.getPendingL1Operation(operationId);
}

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
