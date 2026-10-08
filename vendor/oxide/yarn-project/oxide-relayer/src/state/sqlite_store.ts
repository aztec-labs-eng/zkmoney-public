import { AztecAddress } from '@aztec/aztec.js/addresses';
import { EthAddress } from '@aztec/foundation/eth-address';

import { L1OperationCondition, L1OperationConditionKind } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type Database, open } from 'sqlite';
import sqlite3Driver, { type Database as Sqlite3Database, type Statement as Sqlite3Statement } from 'sqlite3';
import type { Hex } from 'viem';

import { type Row, dateField, numberField, stringField } from './row_fields.js';
import { L1_OPERATION_STATUSES, PENDING_L1_OPERATION_REASONS } from './types.js';
import type {
  L1LogCursor,
  L1OperationStatus,
  L2LogCursor,
  LogCursorSource,
  PendingL1Operation,
  PendingL1OperationFilter,
  PendingL1OperationRetry,
  RelayerDeployment,
  StateStore,
  WaitingBalanceOperation,
} from './types.js';

type SqliteDatabase = Database<Sqlite3Database, Sqlite3Statement>;

const MAX_SIPA_CANDIDATES_PER_QUERY = 500;

export const SCHEMA_VERSION = 4;

/** SQLite implementation of the relayer operational state store. */
export class SqliteStateStore implements StateStore {
  private constructor(private readonly db: SqliteDatabase) {}

  static async open(filename: string, deployment: RelayerDeployment): Promise<SqliteStateStore> {
    await mkdir(path.dirname(path.resolve(filename)), { recursive: true });
    // sqlite3 is a CJS native addon: its exports resolve as ESM named imports only as types, so the
    // runtime driver class comes off the default import.
    // eslint-disable-next-line import-x/no-named-as-default-member
    const db = await open({ filename, driver: sqlite3Driver.Database });
    await db.exec('PRAGMA busy_timeout = 5000');
    const store = new SqliteStateStore(db);
    try {
      await store.migrate();
      await store.ensureDeployment(deployment);
      return store;
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  private async ensureDeployment(deployment: RelayerDeployment): Promise<void> {
    const entries = relayerDeploymentEntries(deployment);
    let committed = false;
    await this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = await this.db.all<Row[]>('SELECT name, value FROM relayer_deployment');
      const existing = new Map(rows.map(row => [stringField(row, 'name'), stringField(row, 'value')]));
      assertDeploymentMatches(entries, existing);
      await populateMissingDeploymentKeys(this.db, entries, existing);
      await this.db.exec('COMMIT');
      committed = true;
    } finally {
      if (!committed) {
        await this.db.exec('ROLLBACK').catch(() => undefined);
      }
    }
  }

  async upsertL1Cursor(cursor: L1LogCursor): Promise<void> {
    await this.upsertCursorRow(
      cursor.source,
      cursor.address.toString(),
      cursor.blockNumber,
      cursor.blockHash,
      cursor.lastPolledAt ?? cursor.updatedAt,
    );
  }

  async getL1Cursor(key: Pick<L1LogCursor, 'source' | 'address'>): Promise<L1LogCursor | undefined> {
    const row = await this.getCursorRow(key.source, key.address.toString());
    return row ? l1CursorFromRow(row) : undefined;
  }

  async deleteL1Cursor(key: Pick<L1LogCursor, 'source' | 'address'>): Promise<void> {
    await this.db.run('DELETE FROM log_cursors WHERE source = ? AND address = ?', key.source, key.address.toString());
  }

  async upsertL2Cursor(cursor: L2LogCursor): Promise<void> {
    await this.upsertCursorRow(
      cursor.source,
      cursor.address.toString(),
      cursor.blockNumber,
      undefined, // L2 cursors don't use block hash. Only L1 cursors do, for reorg detection
      cursor.lastPolledAt ?? cursor.updatedAt,
    );
  }

  async getL2Cursor(key: Pick<L2LogCursor, 'source' | 'address'>): Promise<L2LogCursor | undefined> {
    const row = await this.getCursorRow(key.source, key.address.toString());
    return row ? l2CursorFromRow(row) : undefined;
  }

  private async upsertCursorRow(
    source: string,
    address: string,
    blockNumber: bigint,
    blockHash: Hex | undefined,
    polledAt: Date | undefined,
  ): Promise<void> {
    const ts = iso(polledAt ?? new Date());
    if (blockHash !== undefined) {
      await this.db.run(
        `
          INSERT INTO log_cursors
            (source, address, block_number, block_hash, updated_at, last_polled_at)
          VALUES
            (?, ?, ?, ?, ?, ?)
          ON CONFLICT(source, address) DO UPDATE SET
            block_number = excluded.block_number,
            block_hash = excluded.block_hash,
            updated_at = excluded.updated_at,
            last_polled_at = excluded.last_polled_at
        `,
        source,
        address,
        blockNumber.toString(),
        blockHash,
        ts,
        ts,
      );
      return;
    }
    await this.db.run(
      `
        INSERT INTO log_cursors
          (source, address, block_number, updated_at, last_polled_at)
        VALUES
          (?, ?, ?, ?, ?)
        ON CONFLICT(source, address) DO UPDATE SET
          block_number = CASE
            WHEN CAST(excluded.block_number AS INTEGER) > CAST(log_cursors.block_number AS INTEGER)
            THEN excluded.block_number
            ELSE log_cursors.block_number
          END,
          updated_at = CASE
            WHEN CAST(excluded.block_number AS INTEGER) > CAST(log_cursors.block_number AS INTEGER)
            THEN excluded.updated_at
            ELSE log_cursors.updated_at
          END,
          last_polled_at = excluded.last_polled_at
      `,
      source,
      address,
      blockNumber.toString(),
      ts,
      ts,
    );
  }

  private async getCursorRow(source: string, address: string): Promise<Row | undefined> {
    return await this.db.get<Row>(
      `
        SELECT source, address, block_number, block_hash, updated_at, last_polled_at
        FROM log_cursors
        WHERE source = ? AND address = ?
      `,
      source,
      address,
    );
  }

  /**
   * A rebroadcast from a later L2 block reopens a settled row (`executed` or `dropped`) with zero `attempts` for the
   * submitter's revert backoff, a fresh `created_at` for its max age, and the rebroadcast condition; the same or an
   * older broadcast changes nothing, and `pending`, `waiting` and `blocked` rows are left alone.
   */
  async upsertPendingL1Operation(...operations: PendingL1Operation[]): Promise<void> {
    if (!operations.length) {
      return;
    }

    await this.db.run(
      `
        INSERT INTO pending_l1_operations
          (
            operation_id, broadcaster, l2_tx_hash, l2_block_number, l2_block_hash, target, payout_token,
            calldata, condition_kind, condition_token, condition_recipient, status, attempts, last_checked_at,
            next_check_at, last_balance_check_at, last_reason, created_at, updated_at
          )
        VALUES ${operations.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
        ON CONFLICT(operation_id) DO UPDATE SET
          l2_tx_hash = excluded.l2_tx_hash,
          l2_block_number = excluded.l2_block_number,
          l2_block_hash = excluded.l2_block_hash,
          condition_kind = excluded.condition_kind,
          condition_token = excluded.condition_token,
          condition_recipient = excluded.condition_recipient,
          status = excluded.status,
          attempts = 0,
          last_checked_at = NULL,
          next_check_at = NULL,
          last_balance_check_at = NULL,
          last_reason = NULL,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
        WHERE pending_l1_operations.status IN ('executed', 'dropped')
          AND CAST(excluded.l2_block_number AS INTEGER) > CAST(pending_l1_operations.l2_block_number AS INTEGER)
      `,
      ...operations.flatMap(operation => [
        operation.operationId.toLowerCase(),
        normalizeL2Address(operation.broadcaster),
        operation.l2TxHash,
        operation.l2BlockNumber.toString(),
        operation.l2BlockHash ?? null,
        normalizeAddress(operation.target),
        normalizeAddress(operation.payoutToken),
        operation.calldata,
        operation.condition.kind,
        normalizeAddress(operation.condition.token),
        normalizeAddress(operation.condition.recipient),
        operation.status,
        operation.attempts,
        iso(operation.lastCheckedAt),
        iso(operation.nextCheckAt),
        iso(operation.lastBalanceCheckAt),
        operation.lastReason ?? null,
        iso(operation.createdAt),
        iso(operation.updatedAt ?? new Date()),
      ]),
    );
  }

  async getPendingL1Operation(operationId: Hex): Promise<PendingL1Operation | undefined> {
    const row = await this.db.get<Row>(
      'SELECT * FROM pending_l1_operations WHERE operation_id = ?',
      operationId.toLowerCase(),
    );
    return row ? pendingL1OperationFromRow(row) : undefined;
  }

  async l2BlockForL2Tx(broadcaster: AztecAddress, l2TxHash: string): Promise<bigint | undefined> {
    const row = await this.db.get<Row>(
      'SELECT l2_block_number FROM pending_l1_operations WHERE broadcaster = ? AND l2_tx_hash = ? LIMIT 1',
      normalizeL2Address(broadcaster),
      l2TxHash,
    );
    return row === undefined ? undefined : BigInt(stringField(row, 'l2_block_number'));
  }

  async setL1OperationL2Block(
    broadcaster: AztecAddress,
    l2TxHash: string,
    block: bigint,
    hash?: string,
  ): Promise<void> {
    await this.db.run(
      `
        UPDATE pending_l1_operations
        SET l2_block_number = ?, l2_block_hash = ?, updated_at = ?
        WHERE broadcaster = ? AND l2_tx_hash = ?
      `,
      block.toString(),
      hash ?? null,
      iso(new Date()),
      normalizeL2Address(broadcaster),
      l2TxHash,
    );
  }

  async listWaitingL1Operations(kind: L1OperationConditionKind, limit?: number): Promise<PendingL1Operation[]> {
    if (limit !== undefined && limit <= 0) {
      return [];
    }
    const rows = await this.db.all<Row[]>(
      `
        SELECT *
        FROM pending_l1_operations
        WHERE status = 'waiting' AND condition_kind = ?
        ORDER BY created_at ASC, operation_id ASC
        ${limit === undefined ? '' : 'LIMIT ?'}
      `,
      ...[kind, ...(limit === undefined ? [] : [limit])],
    );
    return rows.map(pendingL1OperationFromRow);
  }

  async findWaitingBalanceOperations(token: EthAddress, recipients: EthAddress[]): Promise<WaitingBalanceOperation[]> {
    if (recipients.length === 0) {
      return [];
    }
    const matched: WaitingBalanceOperation[] = [];
    for (let i = 0; i < recipients.length; i += MAX_SIPA_CANDIDATES_PER_QUERY) {
      const chunk = recipients.slice(i, i + MAX_SIPA_CANDIDATES_PER_QUERY);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = await this.db.all<Row[]>(
        `
          SELECT operation_id, condition_token, condition_recipient
          FROM pending_l1_operations
          WHERE status = 'waiting'
            AND condition_kind = ?
            AND condition_token = ?
            AND condition_recipient IN (${placeholders})
        `,
        L1OperationConditionKind.Balance,
        normalizeAddress(token),
        ...chunk.map(a => normalizeAddress(a)!),
      );
      matched.push(...rows.map(waitingBalanceOperationFromRow));
    }
    return matched;
  }

  async listUncheckedBalanceOperations(limit: number): Promise<WaitingBalanceOperation[]> {
    if (limit <= 0) {
      return [];
    }
    const rows = await this.db.all<Row[]>(
      `
        SELECT operation_id, condition_token, condition_recipient
        FROM pending_l1_operations
        WHERE status = 'waiting'
          AND condition_kind = ?
          AND last_balance_check_at IS NULL
        ORDER BY created_at ASC, operation_id ASC
        LIMIT ?
      `,
      L1OperationConditionKind.Balance,
      limit,
    );
    return rows.map(waitingBalanceOperationFromRow);
  }

  async markL1OperationBalanceChecked(operationId: Hex): Promise<void> {
    await this.db.run(
      'UPDATE pending_l1_operations SET last_balance_check_at = ?, updated_at = ? WHERE operation_id = ?',
      iso(new Date()),
      iso(new Date()),
      operationId.toLowerCase(),
    );
  }

  async dropWaitingL1Operations(kind: L1OperationConditionKind, createdBefore: Date): Promise<number> {
    const result = await this.db.run(
      `
        UPDATE pending_l1_operations
        SET status = 'dropped', updated_at = ?
        WHERE status = 'waiting' AND condition_kind = ? AND created_at < ?
      `,
      iso(new Date()),
      kind,
      iso(createdBefore),
    );
    return result.changes ?? 0;
  }

  async markL1OperationPending(operationId: Hex): Promise<boolean> {
    const result = await this.db.run(
      `
        UPDATE pending_l1_operations
        SET status = 'pending', next_check_at = NULL, updated_at = ?
        WHERE operation_id = ? AND status = 'waiting'
      `,
      iso(new Date()),
      operationId.toLowerCase(),
    );
    return (result.changes ?? 0) > 0;
  }

  async listPendingL1Operations(filter: PendingL1OperationFilter = {}): Promise<PendingL1Operation[]> {
    if (filter.limit !== undefined && filter.limit <= 0) {
      return [];
    }

    const where: string[] = ["status = 'pending'"];
    const params: Array<string | number> = [];
    if (filter.dueAt) {
      where.push('(next_check_at IS NULL OR next_check_at <= ?)');
      params.push(filter.dueAt.toISOString());
    }

    const limit = filter.limit === undefined ? '' : ' LIMIT ?';
    if (filter.limit !== undefined) {
      params.push(filter.limit);
    }

    const rows = await this.db.all<Row[]>(
      `
        SELECT *
        FROM pending_l1_operations
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(next_check_at, created_at) ASC, operation_id ASC
        ${limit}
      `,
      ...params,
    );
    return rows.map(pendingL1OperationFromRow);
  }

  async updatePendingL1OperationRetry(operationId: Hex, retry: PendingL1OperationRetry): Promise<boolean> {
    const result = await this.db.run(
      `
        UPDATE pending_l1_operations
        SET last_checked_at = ?, next_check_at = ?, last_reason = ?, updated_at = ?,
            attempts = attempts + ?
        WHERE operation_id = ?
      `,
      iso(retry.lastCheckedAt ?? new Date()),
      iso(retry.nextCheckAt),
      retry.lastReason ?? null,
      iso(new Date()),
      retry.incrementAttempts ? 1 : 0,
      operationId.toLowerCase(),
    );
    return (result.changes ?? 0) > 0;
  }

  async setL1OperationStatus(operationId: Hex, status: L1OperationStatus): Promise<boolean> {
    const result = await this.db.run(
      'UPDATE pending_l1_operations SET status = ?, updated_at = ? WHERE operation_id = ?',
      status,
      iso(new Date()),
      operationId.toLowerCase(),
    );
    return (result.changes ?? 0) > 0;
  }

  private async migrate(): Promise<void> {
    await this.db.exec('PRAGMA journal_mode = WAL');
    await this.dropTablesOfAnotherVersion();
    await this.db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS relayer_deployment (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS log_cursors (
        source TEXT NOT NULL,
        address TEXT NOT NULL,
        block_number TEXT NOT NULL,
        block_hash TEXT,
        updated_at TEXT NOT NULL,
        last_polled_at TEXT NOT NULL,
        PRIMARY KEY (source, address)
      );

      CREATE TABLE IF NOT EXISTS pending_l1_operations (
        operation_id TEXT PRIMARY KEY,
        broadcaster TEXT NOT NULL,
        l2_tx_hash TEXT NOT NULL,
        l2_block_number TEXT NOT NULL,
        l2_block_hash TEXT,
        target TEXT NOT NULL,
        payout_token TEXT NOT NULL,
        calldata BLOB NOT NULL,
        condition_kind INTEGER NOT NULL DEFAULT ${L1OperationConditionKind.Immediate},
        condition_token TEXT,
        condition_recipient TEXT,
        status TEXT NOT NULL CHECK (status IN (${l1OperationStatusSql()})),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT,
        next_check_at TEXT,
        last_balance_check_at TEXT,
        last_reason TEXT CHECK (last_reason IS NULL OR last_reason IN (${pendingL1OperationReasonSql()})),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS pending_l1_operations_l2_tx_idx
        ON pending_l1_operations(broadcaster, l2_tx_hash);

      CREATE INDEX IF NOT EXISTS pending_l1_operations_condition_idx
        ON pending_l1_operations(status, condition_kind, condition_token, condition_recipient);

      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  /** Between versions relayer db is purged. */
  private async dropTablesOfAnotherVersion(): Promise<void> {
    const version = await this.db.get<Row>('PRAGMA user_version');
    if (version !== undefined && numberField(version, 'user_version') === SCHEMA_VERSION) {
      return;
    }
    const tables = await this.db.all<Row[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    for (const table of tables) {
      await this.db.exec(`DROP TABLE "${stringField(table, 'name')}"`);
    }
  }
}

/** Convenience factory used by the runner and tests. */
export function openSqliteStateStore(filename: string, deployment: RelayerDeployment): Promise<SqliteStateStore> {
  return SqliteStateStore.open(filename, deployment);
}

function l1CursorFromRow(row: Row): L1LogCursor {
  return {
    source: stringField(row, 'source') as LogCursorSource,
    address: EthAddress.fromString(stringField(row, 'address')),
    blockNumber: BigInt(stringField(row, 'block_number')),
    blockHash: stringField(row, 'block_hash', { optional: true }) as Hex | undefined,
    updatedAt: dateField(row, 'updated_at'),
    lastPolledAt: dateField(row, 'last_polled_at'),
  };
}

function l2CursorFromRow(row: Row): L2LogCursor {
  return {
    source: stringField(row, 'source') as LogCursorSource,
    address: AztecAddress.fromStringUnsafe(stringField(row, 'address')),
    blockNumber: BigInt(stringField(row, 'block_number')),
    updatedAt: dateField(row, 'updated_at'),
    lastPolledAt: dateField(row, 'last_polled_at'),
  };
}

function pendingL1OperationFromRow(row: Row): PendingL1Operation {
  const calldata = row.calldata;
  if (!Buffer.isBuffer(calldata)) {
    throw new Error(`pending_l1_operations.calldata is not a BLOB for ${stringField(row, 'operation_id')}`);
  }
  return {
    operationId: stringField(row, 'operation_id') as Hex,
    broadcaster: AztecAddress.fromStringUnsafe(stringField(row, 'broadcaster')),
    l2TxHash: stringField(row, 'l2_tx_hash'),
    l2BlockNumber: BigInt(stringField(row, 'l2_block_number')),
    l2BlockHash: stringField(row, 'l2_block_hash', { optional: true }),
    target: EthAddress.fromString(stringField(row, 'target')),
    payoutToken: EthAddress.fromString(stringField(row, 'payout_token')),
    calldata,
    condition: conditionFromRow(row),
    status: stringField(row, 'status') as PendingL1Operation['status'],
    attempts: numberField(row, 'attempts'),
    lastCheckedAt: dateField(row, 'last_checked_at', { optional: true }),
    nextCheckAt: dateField(row, 'next_check_at', { optional: true }),
    lastBalanceCheckAt: dateField(row, 'last_balance_check_at', { optional: true }),
    lastReason: stringField(row, 'last_reason', { optional: true }) as PendingL1Operation['lastReason'],
    createdAt: dateField(row, 'created_at'),
    updatedAt: dateField(row, 'updated_at'),
  };
}

function conditionFromRow(row: Row): L1OperationCondition {
  return L1OperationCondition.decode(
    numberField(row, 'condition_kind'),
    optionalAddressField(row, 'condition_token'),
    optionalAddressField(row, 'condition_recipient'),
  );
}

function waitingBalanceOperationFromRow(row: Row): WaitingBalanceOperation {
  return {
    operationId: stringField(row, 'operation_id') as Hex,
    token: addressField(row, 'condition_token'),
    recipient: addressField(row, 'condition_recipient'),
  };
}

/** A condition field the kind does not use is stored NULL; every kind reads back its unused fields as zero. */
function optionalAddressField(row: Row, column: string): EthAddress | undefined {
  const value = stringField(row, column, { optional: true });
  return value === undefined ? undefined : EthAddress.fromString(value);
}

function addressField(row: Row, column: string): EthAddress {
  return EthAddress.fromString(stringField(row, column));
}

function pendingL1OperationReasonSql(): string {
  return PENDING_L1_OPERATION_REASONS.map(reason => `'${reason}'`).join(', ');
}

function l1OperationStatusSql(): string {
  return L1_OPERATION_STATUSES.map(status => `'${status}'`).join(', ');
}

function relayerDeploymentEntries(deployment: RelayerDeployment): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ['chainId', deployment.chainId.toString()],
    ['portal', normalizeRequiredAddress(deployment.portal)],
    ['l2Token', normalizeL2Address(deployment.l2Token)],
    ['rollupVersion', deployment.rollupVersion.toString()],
  ];
  if (deployment.broadcaster !== undefined) {
    entries.push(['broadcaster', normalizeL2Address(deployment.broadcaster)]);
  }
  return entries;
}

function assertDeploymentMatches(entries: Array<[string, string]>, existing: Map<string, string>): void {
  for (const [name, value] of entries) {
    const stored = existing.get(name);
    if (stored !== undefined && stored !== value) {
      throw new Error(
        `state database deployment mismatch for ${name}: stored ${stored}, configured ${value}. ` +
          'Use a different state path for a different Oxide deployment.',
      );
    }
  }
}

async function populateMissingDeploymentKeys(
  db: SqliteDatabase,
  entries: Array<[string, string]>,
  existing: Map<string, string>,
): Promise<void> {
  for (const [name, value] of entries) {
    if (existing.get(name) === undefined) {
      await db.run('INSERT INTO relayer_deployment (name, value) VALUES (?, ?)', name, value);
    }
  }
}

function normalizeRequiredAddress(value: string): string {
  return EthAddress.fromString(value).toString();
}

function normalizeAddress(value: EthAddress | string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return (typeof value === 'string' ? EthAddress.fromString(value) : value).toString();
}

function normalizeL2Address(value: AztecAddress | string): string {
  return (typeof value === 'string' ? AztecAddress.fromStringUnsafe(value) : value).toString();
}

function iso(value: Date | undefined): string | null {
  return value ? value.toISOString() : null;
}
