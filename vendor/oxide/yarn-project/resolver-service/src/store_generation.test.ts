import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { Hex } from 'viem';

import { PgResolverStore } from './pg_resolver_store.js';
import { RedisRateLimiter } from './redis_rate_limiter.js';

const baseUrl = process.env.OXIDE_TEST_PG_URL;
let databaseUrl: string;
const redisUrl = process.env.OXIDE_TEST_REDIS_URL;
const user = `0x${'12'.repeat(32)}` as Hex;

(baseUrl ? describe : describe.skip)('resolver generation store', () => {
  // Split-mode stores require their schema to be bootstrapped before they open.
  const database = `oxide_generation_${randomBytes(6).toString('hex')}`;
  let control: pg.Pool;
  beforeAll(async () => {
    control = new pg.Pool({ connectionString: baseUrl });
    await control.query(`CREATE DATABASE "${database}"`);
    const url = new URL(baseUrl!);
    url.pathname = `/${database}`;
    databaseUrl = url.toString();
  });
  afterAll(async () => {
    await control.query(`DROP DATABASE "${database}"`);
    await control.end();
  });
  it('keeps legacy and generation nonces separate, including reconnects and a URL with another search path', async () => {
    const suffix = randomBytes(6).toString('hex');
    const schemas = [`oxide_a_${suffix}`, `oxide_b_${suffix}`];
    const admin = new pg.Pool({ connectionString: databaseUrl! });
    for (const schema of schemas) {
      await admin.query(`CREATE SCHEMA "${schema}"`);
    }
    const legacy = await PgResolverStore.open(databaseUrl!, { poolMax: 1 });
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', '-c search_path=public');
    const first = await PgResolverStore.open(url.toString(), { poolMax: 2, schema: schemas[0] });
    const second = await PgResolverStore.open(databaseUrl!, { poolMax: 1, schema: schemas[1] });
    let reopened: PgResolverStore | undefined;
    const day = Number.parseInt(suffix.slice(0, 6), 16);
    try {
      expect(await legacy.nextNonce(user, day)).toBe(0);
      expect(await first.nextNonce(user, day)).toBe(0);
      expect(await first.nextNonce(user, day)).toBe(1);
      expect(await second.nextNonce(user, day)).toBe(0);
      await first.close();
      reopened = await PgResolverStore.open(databaseUrl!, { poolMax: 2, schema: schemas[0] });
      expect(await reopened.nextNonce(user, day)).toBe(2);
      expect(await legacy.nextNonce(user, day)).toBe(1);
      await expect(PgResolverStore.open(databaseUrl!, { poolMax: 1, schema: 'public,other' })).rejects.toThrow(
        'identifier',
      );
    } finally {
      await Promise.all([legacy.close(), second.close(), reopened ? reopened.close() : first.close()]);
      for (const schema of schemas) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
      await admin.end();
    }
  });
  it('does not migrate public legacy tables during concurrent startup or reconnect', async () => {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const schema = `oxide_legacy_check_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query('DROP TABLE IF EXISTS public.resolutions');
    await admin.query(`CREATE TABLE public.resolutions (
      sipa TEXT PRIMARY KEY, recipient_commitment TEXT NOT NULL, shared_secret_salt TEXT NOT NULL,
      recovery_address TEXT NOT NULL, recipient_l2_address TEXT NOT NULL, rollup_version BIGINT NOT NULL,
      deposit_pool TEXT NOT NULL, day INTEGER NOT NULL, nonce INTEGER NOT NULL, sipa_state TEXT NOT NULL,
      deposit_fee_store TEXT NOT NULL
    )`);
    await admin.query(
      "INSERT INTO public.resolutions (sipa, recipient_commitment, shared_secret_salt, recovery_address, recipient_l2_address, rollup_version, deposit_pool, day, nonce, sipa_state, deposit_fee_store) VALUES ('old', 'c', 's', 'old-eoa', 'l2', 1, 'pool', 1, 0, 'funded', 'legacy-fee-store')",
    );
    const snapshot = async () => ({
      columns: (
        await admin.query(
          "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'resolutions' ORDER BY ordinal_position",
        )
      ).rows,
      rows: (await admin.query('SELECT * FROM public.resolutions ORDER BY sipa')).rows,
    });
    const before = await snapshot();
    const stores: PgResolverStore[] = [];
    try {
      stores.push(...(await Promise.all([1, 2].map(() => PgResolverStore.open(databaseUrl, { poolMax: 2, schema })))));
      const nonces = await Promise.all(stores.map(store => store.nextNonce(user, 5)));
      expect(nonces.sort()).toEqual([0, 1]);
      expect(await snapshot()).toEqual(before);
      await stores.pop()!.close();
      stores.push(await PgResolverStore.open(databaseUrl, { poolMax: 1, schema }));
      expect(await snapshot()).toEqual(before);
    } finally {
      await Promise.all(stores.map(store => store.close()));
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
});

(redisUrl ? describe : describe.skip)('resolver generation rate limit', () => {
  it('shares a generation bucket across clients while keeping another generation independent', async () => {
    const namespace = `generation-${randomBytes(6).toString('hex')}`;
    const clients = [
      new RedisRateLimiter(1, redisUrl!, undefined, namespace),
      new RedisRateLimiter(1, redisUrl!, undefined, namespace),
      new RedisRateLimiter(1, redisUrl!, undefined, `${namespace}-other`),
    ];
    try {
      expect(await clients[0].allow('127.0.0.1', user)).toBe(true);
      expect(await clients[1].allow('127.0.0.1', user)).toBe(false);
      expect(await clients[2].allow('127.0.0.1', user)).toBe(true);
    } finally {
      clients.forEach(client => client.close());
    }
  });
});
