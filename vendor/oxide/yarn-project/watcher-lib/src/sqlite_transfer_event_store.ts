import { EthAddress } from '@aztec/foundation/eth-address';

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type Database, open } from 'sqlite';
import sqlite3Driver, { type Database as Sqlite3Database, type Statement as Sqlite3Statement } from 'sqlite3';

import type { TransferEvent } from './transfer_ingester.js';

type SqliteDatabase = Database<Sqlite3Database, Sqlite3Statement>;
type Row = Record<string, unknown>;

/**
 * Persists ERC20 Transfer events ingested from L1 so a watcher can match its own candidate addresses against them
 * locally
 */
export interface TransferEventStore {
  /** Idempotent: re-inserting an already-stored `(txHash, logIndex)` is a no-op. */
  insert(events: TransferEvent[]): Promise<void>;
  /** Recipients among `candidates` that ever received a transfer of one of `tokens`. */
  findRecipients(tokens: EthAddress[], candidates: EthAddress[]): Promise<EthAddress[]>;
  findFunders(tokens: EthAddress[], sipa: EthAddress): Promise<EthAddress[]>;
  /** Purges rows at or above `block`. */
  deleteFromBlock(block: bigint): Promise<void>;
  /**
   * Drops rows observed before `cutoff`, except rows whose recipient is in `keepRecipients`: their funder evidence
   * must outlive the retention window. Returns the number of rows dropped.
   */
  pruneObservedBefore(cutoff: Date, keepRecipients?: EthAddress[]): Promise<number>;
  close(): Promise<void>;
}

/**
 * SQLite caps a query at 32766 bound parameters (`SQLITE_MAX_VARIABLE_NUMBER`). `findRecipients` binds one parameter
 * per candidate, so a large candidate set is chunked.
 */
export const MAX_CANDIDATES_PER_QUERY = 500;

const SCHEMA_VERSION = 2;

/** SQLite implementation of {@link TransferEventStore}. */
export class SqliteTransferEventStore implements TransferEventStore {
  private constructor(private readonly db: SqliteDatabase) {}

  static async open(filename: string): Promise<SqliteTransferEventStore> {
    await mkdir(path.dirname(path.resolve(filename)), { recursive: true });
    // sqlite3 is a CJS native addon: its exports resolve as ESM named imports only as types, so the
    // runtime driver class comes off the default import.
    // eslint-disable-next-line import-x/no-named-as-default-member
    const db = await open({ filename, driver: sqlite3Driver.Database });
    await db.exec('PRAGMA busy_timeout = 5000');
    const store = new SqliteTransferEventStore(db);
    await store.migrate();
    return store;
  }

  private async migrate(): Promise<void> {
    await this.db.exec('PRAGMA journal_mode = WAL');
    const stored = await this.db.get<{ user_version: number }>('PRAGMA user_version');
    if (stored?.user_version !== SCHEMA_VERSION) {
      await this.db.exec('DROP TABLE IF EXISTS l1_transfer_events');
    }
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS l1_transfer_events (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        token TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        value TEXT NOT NULL,
        block_number TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (tx_hash, log_index)
      );

      CREATE INDEX IF NOT EXISTS l1_transfer_events_recipient_idx
        ON l1_transfer_events(recipient, token);

      CREATE INDEX IF NOT EXISTS l1_transfer_events_block_idx
        ON l1_transfer_events(block_number);

      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  /** Inserts the whole batch in one transaction, rolling back if any row fails. */
  async insert(events: TransferEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const observedAt = new Date().toISOString();
    let committed = false;
    await this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) {
        await this.db.run(
          `
            INSERT INTO l1_transfer_events
              (tx_hash, log_index, token, sender, recipient, value, block_number, observed_at)
            VALUES
              (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tx_hash, log_index) DO NOTHING
          `,
          event.txHash.toLowerCase(),
          event.logIndex,
          event.token.toString(),
          event.sender.toString(),
          event.recipient.toString(),
          event.value.toString(),
          event.block.toString(),
          observedAt,
        );
      }
      await this.db.exec('COMMIT');
      committed = true;
    } finally {
      if (!committed) {
        await this.db.exec('ROLLBACK').catch(() => undefined);
      }
    }
  }

  async findRecipients(tokens: EthAddress[], candidates: EthAddress[]): Promise<EthAddress[]> {
    if (tokens.length === 0 || candidates.length === 0) {
      return [];
    }
    const tokenStrings = tokens.map(t => t.toString());
    const tokenPlaceholders = tokens.map(() => '?').join(', ');
    const matched = new Set<string>();
    for (let i = 0; i < candidates.length; i += MAX_CANDIDATES_PER_QUERY) {
      const chunk = candidates.slice(i, i + MAX_CANDIDATES_PER_QUERY);
      const candidatePlaceholders = chunk.map(() => '?').join(', ');
      const rows = await this.db.all<Row[]>(
        `
          SELECT DISTINCT recipient
          FROM l1_transfer_events
          WHERE token IN (${tokenPlaceholders}) AND recipient IN (${candidatePlaceholders})
            AND value <> '0'
        `,
        ...tokenStrings,
        ...chunk.map(c => c.toString()),
      );
      rows.forEach(row => matched.add(String(row.recipient)));
    }
    return [...matched].map(r => EthAddress.fromString(r));
  }

  async findFunders(tokens: EthAddress[], sipa: EthAddress): Promise<EthAddress[]> {
    if (tokens.length === 0) {
      return [];
    }
    const rows = await this.db.all<Row[]>(
      `
        SELECT DISTINCT sender
        FROM l1_transfer_events
        WHERE token IN (${tokens.map(() => '?').join(', ')}) AND recipient = ?
          AND value <> '0'
      `,
      ...tokens.map(t => t.toString()),
      sipa.toString(),
    );
    return rows.map(row => EthAddress.fromString(String(row.sender)));
  }

  async deleteFromBlock(block: bigint): Promise<void> {
    await this.db.run(
      'DELETE FROM l1_transfer_events WHERE CAST(block_number AS INTEGER) >= CAST(? AS INTEGER)',
      block.toString(),
    );
  }

  // `keepRecipients` binds one parameter per address and stays far below the 32766-parameter cap: it is the set of
  // resolutions between FUNDED and finalization, not a full candidate list, so no chunking is needed.
  async pruneObservedBefore(cutoff: Date, keepRecipients: EthAddress[] = []): Promise<number> {
    const keepClause =
      keepRecipients.length > 0 ? ` AND recipient NOT IN (${keepRecipients.map(() => '?').join(', ')})` : '';
    const result = await this.db.run(
      `DELETE FROM l1_transfer_events WHERE observed_at < ?${keepClause}`,
      cutoff.toISOString(),
      ...keepRecipients.map(r => r.toString()),
    );
    return result.changes ?? 0;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
