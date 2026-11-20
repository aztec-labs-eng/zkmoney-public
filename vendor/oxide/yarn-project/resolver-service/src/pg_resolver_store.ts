import { createLogger } from '@aztec-labs/foundation/log';

import { MAX_NONCE } from '@oxide/oxide-lib/oxide_constants.gen.js';

import { readFile } from 'node:fs/promises';
import pg from 'pg';
import type { Hex } from 'viem';

import { EXPIRATION_TIME_DAYS, type ResolverStore } from './resolver_store.js';

export type PgResolverStoreOptions = {
  /** Pool size. The gateway runs 1 connection per instance. */
  poolMax: number;
  schema?: string;
  /** A local run may create its schema; deployments bootstrap it with the app role. */
  createSchema?: boolean;
  /** CA bundle for TLS to the server (the baked RDS bundle in prod). Absent → no TLS (local dev/CI). */
  caPath?: string;
};

/**
 * Postgres-backed {@link ResolverStore}: one shared store for the auto-scaling gateway fleet. Every mutation is a
 * single guarded statement so concurrent instances can't hand out duplicate nonces.
 *
 * @dev Query configs never set `name`: named prepared statements pin an RDS Proxy client connection to one backend
 * connection, defeating pooling.
 */
export class PgResolverStore implements ResolverStore {
  private constructor(
    private readonly pool: pg.Pool,
    private readonly schema?: string,
  ) {}

  #table(name: string): string {
    return this.schema ? `"${this.schema}"."${name}"` : name;
  }

  static async open(url: string, options: PgResolverStoreOptions): Promise<PgResolverStore> {
    if (options.schema && !/^[a-z][a-z0-9_]{0,62}$/.test(options.schema)) {
      throw new Error('The resolver database schema must be a lowercase SQL identifier.');
    }
    const ssl = options.caPath ? { ca: await readFile(options.caPath, 'utf8') } : undefined;
    // Bounded well under the gateway's 30 s ceiling: a stalled store must fail a resolve fast instead of pinning a
    // concurrency slot until the Lambda timeout, and must not wedge on a half-open connection (which keepalive
    // detects; the pg default waits forever on a dead peer).
    const pool = new pg.Pool({
      connectionString: url,
      max: options.poolMax,
      ssl,
      connectionTimeoutMillis: 5_000,
      // eslint-disable-next-line camelcase -- pg spells this option in snake_case
      query_timeout: 10_000,
      keepAlive: true,
    });
    // An idle pooled connection dropping (proxy recycle, failover) emits on the pool, and pg.Pool is a bare
    // EventEmitter — unhandled, that ends the process. The pool discards the dead client itself, so logging is the
    // whole handler; the next query dials fresh.
    const log = createLogger('oxide:resolver:store');
    pool.on('error', err => log.warn(`idle store connection dropped: ${err.message}`));
    const store = new PgResolverStore(pool, options.schema);
    try {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `oxide-resolver:${options.schema ?? 'default'}`,
        ]);
        if (options.schema && options.createSchema) {
          await connection.query(`CREATE SCHEMA IF NOT EXISTS "${options.schema}"`);
        } else if (options.schema) {
          const existing = await connection.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [options.schema]);
          if (existing.rowCount === 0) {
            throw new Error(`resolver schema ${options.schema} must be created before the gateway starts`);
          }
        }
        await store.#migrate(connection);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    } catch (err) {
      await pool.end();
      throw err;
    }
    return store;
  }

  async #migrate(connection: pg.PoolClient): Promise<void> {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS ${this.#table('nonces')} (
        user_address TEXT NOT NULL,
        day INTEGER NOT NULL,
        n INTEGER NOT NULL,
        PRIMARY KEY (user_address, day)
      );
    `);
  }

  async nextNonce(userIdentifier: Hex, day: number): Promise<number> {
    // Single-statement upsert-increment so concurrent gateway instances can't be handed the same nonce — duplicates
    // would derive the same SIPA, colliding two resolutions on one SIPA and breaking unlinkability. The WHERE filters
    // out an exhausted counter, surfacing as zero rows.
    const res = await this.pool.query<{ nonce: number }>({
      text: `
        INSERT INTO ${this.#table('nonces')} (user_address, day, n) VALUES ($1, $2, 1)
        ON CONFLICT (user_address, day) DO UPDATE SET n = nonces.n + 1 WHERE nonces.n < $3
        RETURNING n - 1 AS nonce
      `,
      values: [userIdentifier, day, MAX_NONCE],
    });
    if (res.rowCount === 0) {
      throw new Error(`nonce space exhausted for ${userIdentifier}:${day}`);
    }
    return res.rows[0].nonce;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async pruneNonces(currentDay: number): Promise<number> {
    const res = await this.pool.query({
      text: `DELETE FROM ${this.#table('nonces')} WHERE day < $1`,
      values: [currentDay - EXPIRATION_TIME_DAYS],
    });
    return res.rowCount ?? 0;
  }
}
