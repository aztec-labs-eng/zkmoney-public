import { AztecAddress } from '@aztec/aztec.js/addresses';
import { EthAddress } from '@aztec/foundation/eth-address';

import { L1OperationCondition, L1OperationConditionKind } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { open } from 'sqlite';
import sqlite3Driver from 'sqlite3';
import type { Hex } from 'viem';

import { SCHEMA_VERSION, openSqliteStateStore } from './sqlite_store.js';
import { TEST_RELAYER_DEPLOYMENT } from './test_fixtures.js';
import type { PendingL1Operation, RelayerDeployment, StateStore } from './types.js';
import { LogCursorSources } from './types.js';

const BROADCASTER = AztecAddress.fromStringUnsafe(`0x${'22'.repeat(32)}`);
const PORTAL_ADDRESS = '0x0000000000000000000000000000000000000001';
const TOKEN = EthAddress.fromString('0x000000000000000000000000000000000000000a');
const TOKEN_ALT = EthAddress.fromString('0x000000000000000000000000000000000000000b');
const SIPA = EthAddress.fromString('0x0000000000000000000000000000000000000009');

const CONDITION_BY_ID: Array<[Hex, L1OperationCondition]> = [
  [`0x${'01'.repeat(32)}`, L1OperationCondition.immediate()],
  [`0x${'02'.repeat(32)}`, L1OperationCondition.balance(TOKEN, SIPA)],
  [`0x${'03'.repeat(32)}`, L1OperationCondition.messageInOutbox()],
];

const PENDING_L1_OPERATION: PendingL1Operation = {
  operationId: `0x${'cd'.repeat(32)}`,
  broadcaster: BROADCASTER,
  l2TxHash: '0xl2tx',
  l2BlockNumber: 5n,
  target: EthAddress.fromString('0x0000000000000000000000000000000000000021'),
  payoutToken: TOKEN,
  calldata: Buffer.from('deadbeef', 'hex'),
  condition: L1OperationCondition.immediate(),
  status: 'pending',
  attempts: 0,
};

const WAITING_BALANCE_OPERATION: PendingL1Operation = {
  ...PENDING_L1_OPERATION,
  operationId: `0x${'ba'.repeat(32)}`,
  condition: L1OperationCondition.balance(TOKEN, SIPA),
  status: 'waiting',
};

describe('SqliteStateStore', () => {
  it('ties the database to one relayer deployment', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oxide-relayer-state-'));
    const dbPath = path.join(dir, 'state.sqlite3');
    const coreDeployment: RelayerDeployment = {
      chainId: TEST_RELAYER_DEPLOYMENT.chainId,
      portal: TEST_RELAYER_DEPLOYMENT.portal,
      l2Token: TEST_RELAYER_DEPLOYMENT.l2Token,
      rollupVersion: TEST_RELAYER_DEPLOYMENT.rollupVersion,
    };

    try {
      const coreStore = await openSqliteStateStore(dbPath, coreDeployment);
      await coreStore.close();

      const fullStore = await openSqliteStateStore(dbPath, TEST_RELAYER_DEPLOYMENT);
      await fullStore.close();

      await expect(openSqliteStateStore(dbPath, TEST_RELAYER_DEPLOYMENT)).resolves.toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a different relayer deployment', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oxide-relayer-state-'));
    const dbPath = path.join(dir, 'state.sqlite3');

    try {
      const store = await openSqliteStateStore(dbPath, TEST_RELAYER_DEPLOYMENT);
      await store.close();

      await expect(
        openSqliteStateStore(dbPath, {
          ...TEST_RELAYER_DEPLOYMENT,
          broadcaster: `0x${'23'.repeat(32)}`,
        }),
      ).rejects.toThrow(/state database deployment mismatch for broadcaster/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('advances an L2 cursor only forward', async () => {
    await withStore(async store => {
      const key = {
        source: LogCursorSources.l1OperationBroadcaster,
        address: BROADCASTER,
      };
      await store.upsertL2Cursor({ ...key, blockNumber: 10n });
      await store.upsertL2Cursor({ ...key, blockNumber: 9n });
      await expect(store.getL2Cursor(key)).resolves.toMatchObject({ blockNumber: 10n });

      await store.upsertL2Cursor({ ...key, blockNumber: 11n });
      await expect(store.getL2Cursor(key)).resolves.toMatchObject({ blockNumber: 11n });
    });
  });

  it('bumps lastPolledAt on every poll but advances updatedAt only when the block moves', async () => {
    await withStore(async store => {
      const key = {
        source: LogCursorSources.l1OperationBroadcaster,
        address: BROADCASTER,
      };
      const firstPoll = new Date('2026-06-16T00:00:00.000Z');
      const idlePoll = new Date('2026-06-16T00:05:00.000Z');
      const advancePoll = new Date('2026-06-16T00:10:00.000Z');

      await store.upsertL2Cursor({ ...key, blockNumber: 100n, lastPolledAt: firstPoll });
      await store.upsertL2Cursor({ ...key, blockNumber: 100n, lastPolledAt: idlePoll });

      const afterIdle = await store.getL2Cursor(key);
      expect(afterIdle?.updatedAt).toEqual(firstPoll);
      expect(afterIdle?.lastPolledAt).toEqual(idlePoll);

      await store.upsertL2Cursor({ ...key, blockNumber: 101n, lastPolledAt: advancePoll });

      const afterAdvance = await store.getL2Cursor(key);
      expect(afterAdvance?.blockNumber).toBe(101n);
      expect(afterAdvance?.updatedAt).toEqual(advancePoll);
      expect(afterAdvance?.lastPolledAt).toEqual(advancePoll);
    });
  });

  it('deletes an L1 cursor, and deleting an absent one is a no-op', async () => {
    await withStore(async store => {
      const key = { source: LogCursorSources.l1OperationTransferDiscovery, address: EthAddress.ZERO };
      await store.upsertL1Cursor({ ...key, blockNumber: 42n, blockHash: `0x${'ab'.repeat(32)}` });

      await store.deleteL1Cursor(key);
      await expect(store.getL1Cursor(key)).resolves.toBeUndefined();

      await expect(store.deleteL1Cursor(key)).resolves.toBeUndefined();
    });
  });

  it('round-trips an L1 cursor with a domain-typed address', async () => {
    await withStore(async store => {
      const address = EthAddress.fromString(PORTAL_ADDRESS);
      const l1Key = { source: LogCursorSources.l1OperationBroadcaster, address };
      await store.upsertL1Cursor({ ...l1Key, blockNumber: 42n });

      const cursor = await store.getL1Cursor(l1Key);
      expect(cursor?.blockNumber).toBe(42n);
      expect(cursor?.address).toBeInstanceOf(EthAddress);
      expect(cursor?.address.equals(address)).toBe(true);
    });
  });

  it('keeps a database at the current schema version and empties one at another', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oxide-relayer-state-'));
    const filename = path.join(dir, 'state.sqlite3');
    try {
      const first = await openSqliteStateStore(filename, TEST_RELAYER_DEPLOYMENT);
      await first.upsertPendingL1Operation(PENDING_L1_OPERATION);
      await first.close();

      const kept = await openSqliteStateStore(filename, TEST_RELAYER_DEPLOYMENT);
      await expect(kept.getPendingL1Operation(PENDING_L1_OPERATION.operationId)).resolves.toBeDefined();
      await kept.close();

      await setSchemaVersion(filename, SCHEMA_VERSION + 1);
      const rebuilt = await openSqliteStateStore(filename, TEST_RELAYER_DEPLOYMENT);
      try {
        await expect(rebuilt.getPendingL1Operation(PENDING_L1_OPERATION.operationId)).resolves.toBeUndefined();
        await expect(readSchemaVersion(filename)).resolves.toBe(SCHEMA_VERSION);
      } finally {
        await rebuilt.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a reorg-aware L1 cursor with a block hash and allows it to rewind', async () => {
    await withStore(async store => {
      const address = EthAddress.fromString(PORTAL_ADDRESS);
      const key = { source: LogCursorSources.l1OperationBroadcaster, address };
      await store.upsertL1Cursor({ ...key, blockNumber: 100n, blockHash: `0x${'aa'.repeat(32)}` });

      await expect(store.getL1Cursor(key)).resolves.toMatchObject({
        blockNumber: 100n,
        blockHash: `0x${'aa'.repeat(32)}`,
      });

      // A reorg-aware cursor can move backwards, unlike a monotonic-only cursor.
      await store.upsertL1Cursor({ ...key, blockNumber: 90n, blockHash: `0x${'bb'.repeat(32)}` });
      await expect(store.getL1Cursor(key)).resolves.toMatchObject({
        blockNumber: 90n,
        blockHash: `0x${'bb'.repeat(32)}`,
      });
    });
  });
});

/** Stamps a database with another schema version, as a database written by an older or newer relayer carries. */
async function setSchemaVersion(filename: string, version: number): Promise<void> {
  // eslint-disable-next-line import-x/no-named-as-default-member
  const db = await open({ filename, driver: sqlite3Driver.Database });
  await db.exec(`PRAGMA user_version = ${version}`);
  await db.close();
}

async function readSchemaVersion(filename: string): Promise<number> {
  // eslint-disable-next-line import-x/no-named-as-default-member
  const db = await open({ filename, driver: sqlite3Driver.Database });
  const row = await db.get<{ user_version: number }>('PRAGMA user_version');
  await db.close();
  return row?.user_version ?? 0;
}

describe('SqliteStateStore L1 operations', () => {
  it('keeps a blocked operation as a terminal row that is neither listed nor resurrected', async () => {
    await withStore(async store => {
      await store.upsertPendingL1Operation(PENDING_L1_OPERATION);
      await expect(store.listPendingL1Operations()).resolves.toHaveLength(1);

      await expect(store.setL1OperationStatus(PENDING_L1_OPERATION.operationId, 'blocked')).resolves.toBe(true);
      await expect(store.getPendingL1Operation(PENDING_L1_OPERATION.operationId)).resolves.toMatchObject({
        status: 'blocked',
      });
      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);

      // A re-scan of the broadcast log upserts the same row again; the block must survive.
      await store.upsertPendingL1Operation(PENDING_L1_OPERATION);
      await expect(store.getPendingL1Operation(PENDING_L1_OPERATION.operationId)).resolves.toMatchObject({
        status: 'blocked',
      });
      await expect(store.listPendingL1Operations()).resolves.toHaveLength(0);
    });
  });

  it('persists screening_error as the last reason of a deferred operation', async () => {
    await withStore(async store => {
      await store.upsertPendingL1Operation(PENDING_L1_OPERATION);
      await store.updatePendingL1OperationRetry(PENDING_L1_OPERATION.operationId, {
        nextCheckAt: new Date('2026-06-16T00:05:00.000Z'),
        lastReason: 'screening_error',
      });
      await expect(store.getPendingL1Operation(PENDING_L1_OPERATION.operationId)).resolves.toMatchObject({
        status: 'pending',
        attempts: 0,
        lastReason: 'screening_error',
        nextCheckAt: new Date('2026-06-16T00:05:00.000Z'),
      });
    });
  });

  it('round-trips every condition kind and keeps a waiting row out of the pending list', async () => {
    await withStore(async store => {
      for (const [id, condition] of CONDITION_BY_ID) {
        await store.upsertPendingL1Operation({
          ...PENDING_L1_OPERATION,
          operationId: id,
          condition,
          status: condition.kind === L1OperationConditionKind.Immediate ? 'pending' : 'waiting',
        });
      }

      await expect(store.listPendingL1Operations()).resolves.toHaveLength(1);
      for (const [id, condition] of CONDITION_BY_ID) {
        await expect(store.getPendingL1Operation(id)).resolves.toMatchObject({ condition });
      }
      await expect(store.listWaitingL1Operations(L1OperationConditionKind.Balance)).resolves.toHaveLength(1);
      await expect(store.listWaitingL1Operations(L1OperationConditionKind.MessageInOutbox)).resolves.toHaveLength(1);
    });
  });

  it('finds a waiting Balance operation by its (token, recipient) pair only', async () => {
    await withStore(async store => {
      await store.upsertPendingL1Operation(WAITING_BALANCE_OPERATION);

      await expect(store.findWaitingBalanceOperations(TOKEN, [SIPA])).resolves.toEqual([
        { operationId: WAITING_BALANCE_OPERATION.operationId, token: TOKEN, recipient: SIPA },
      ]);
      await expect(store.findWaitingBalanceOperations(TOKEN_ALT, [SIPA])).resolves.toHaveLength(0);
      await expect(store.findWaitingBalanceOperations(TOKEN, [EthAddress.random()])).resolves.toHaveLength(0);
      await expect(store.findWaitingBalanceOperations(TOKEN, [])).resolves.toHaveLength(0);

      // A pending operation is no longer a match: it is already queued.
      await store.markL1OperationPending(WAITING_BALANCE_OPERATION.operationId);
      await expect(store.findWaitingBalanceOperations(TOKEN, [SIPA])).resolves.toHaveLength(0);
    });
  });

  it('lists a waiting Balance operation as unchecked until its one read is recorded', async () => {
    await withStore(async store => {
      await store.upsertPendingL1Operation(WAITING_BALANCE_OPERATION);

      await expect(store.listUncheckedBalanceOperations(10)).resolves.toHaveLength(1);
      await expect(store.listUncheckedBalanceOperations(0)).resolves.toHaveLength(0);

      await store.markL1OperationBalanceChecked(WAITING_BALANCE_OPERATION.operationId);
      await expect(store.listUncheckedBalanceOperations(10)).resolves.toHaveLength(0);
    });
  });

  it('lists unchecked Balance operations oldest first under the per-poll limit', async () => {
    await withStore(async store => {
      const older = WAITING_BALANCE_OPERATION;
      const newer = {
        ...WAITING_BALANCE_OPERATION,
        operationId: `0x${'00'.repeat(32)}` as const,
        createdAt: new Date(Date.now() + 60_000),
      };
      await store.upsertPendingL1Operation(older);
      await store.upsertPendingL1Operation(newer);

      const [first] = await store.listUncheckedBalanceOperations(1);
      expect(first.operationId).toBe(older.operationId);
    });
  });

  it('marks a waiting operation pending only once', async () => {
    await withStore(async store => {
      const { operationId } = WAITING_BALANCE_OPERATION;
      await store.upsertPendingL1Operation(WAITING_BALANCE_OPERATION);

      await expect(store.markL1OperationPending(operationId)).resolves.toBe(true);
      await expect(store.markL1OperationPending(operationId)).resolves.toBe(false);
      await expect(store.getPendingL1Operation(operationId)).resolves.toMatchObject({ status: 'pending' });
    });
  });

  it('stores all operations from a transaction atomically and retries a rejected batch', async () => {
    await withStore(async store => {
      const second = { ...PENDING_L1_OPERATION, operationId: `0x${'ef'.repeat(32)}` as const };
      await expect(
        store.upsertPendingL1Operation(PENDING_L1_OPERATION, { ...second, status: 'invalid' as typeof second.status }),
      ).rejects.toThrow('CHECK constraint');
      expect(await store.listPendingL1Operations()).toHaveLength(0);
      expect(await store.l2BlockForL2Tx(BROADCASTER, PENDING_L1_OPERATION.l2TxHash)).toBeUndefined();
      await store.upsertPendingL1Operation(PENDING_L1_OPERATION, second);
      expect(await store.listPendingL1Operations()).toHaveLength(2);
      await store.upsertPendingL1Operation(PENDING_L1_OPERATION, second);
      expect(await store.listPendingL1Operations()).toHaveLength(2);
    });
  });

  it('re-anchors every operation of a broadcast tx that came back in another block', async () => {
    await withStore(async store => {
      await store.upsertPendingL1Operation(PENDING_L1_OPERATION);
      await store.upsertPendingL1Operation({ ...PENDING_L1_OPERATION, operationId: `0x${'ef'.repeat(32)}` });

      await expect(store.l2BlockForL2Tx(BROADCASTER, PENDING_L1_OPERATION.l2TxHash)).resolves.toBe(5n);
      await store.setL1OperationL2Block(BROADCASTER, PENDING_L1_OPERATION.l2TxHash, 9n, '0xblock');

      await expect(store.l2BlockForL2Tx(BROADCASTER, PENDING_L1_OPERATION.l2TxHash)).resolves.toBe(9n);
      for (const operation of await store.listPendingL1Operations()) {
        expect(operation).toMatchObject({ l2BlockNumber: 9n, l2BlockHash: '0xblock' });
      }
      await expect(store.l2BlockForL2Tx(BROADCASTER, '0xunknown')).resolves.toBeUndefined();
    });
  });
});

async function withStore(fn: (store: StateStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oxide-relayer-state-'));
  const store = await openSqliteStateStore(path.join(dir, 'state.sqlite3'), TEST_RELAYER_DEPLOYMENT);
  try {
    await fn(store);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
