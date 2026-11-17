import type { AztecAsyncMap } from '@aztec-labs/kv-store';

import { MAX_NONCE } from '@oxide/oxide-lib/oxide_constants.gen.js';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import pg from 'pg';
import type { Hex } from 'viem';

import { LmdbResolverStore } from './lmdb_resolver_store.js';
import { PgResolverStore } from './pg_resolver_store.js';
import type { ResolverStore } from './resolver_store.js';

const USER = '0x00000000000000000000000000000000000000000000000000000000000a11ce' as Hex;

type ContractHooks = {
  openStore: () => Promise<ResolverStore>;
  /** Backdoor into the nonce counter so exhaustion is seedable without MAX_NONCE allocations. */
  setNonceCount: (store: ResolverStore, user: Hex, day: number, n: number) => Promise<void>;
};

/** Behavior every ResolverStore backend must satisfy; each backend instantiates it below. */
function describeResolverStoreContract(name: string, { openStore, setNonceCount }: ContractHooks): void {
  describe(`${name} nonces`, () => {
    let store: ResolverStore;

    beforeEach(async () => {
      store = await openStore();
    });
    afterEach(async () => {
      await store.close();
    });

    it('hands out sequential nonces starting at 0', async () => {
      expect(await store.nextNonce(USER, 100)).toBe(0);
      expect(await store.nextNonce(USER, 100)).toBe(1);
      expect(await store.nextNonce(USER, 100)).toBe(2);
    });

    it('nonces are namespaced per (user, day)', async () => {
      expect(await store.nextNonce(USER, 100)).toBe(0);
      expect(await store.nextNonce(USER, 101)).toBe(0);
      expect(await store.nextNonce(USER, 100)).toBe(1);
    });

    // Without per-key serialization, concurrent read-modify-writes would reuse a nonce. Firing 50 at once must still
    // yield a gapless 0..49, proving each call saw the prior write.
    it('concurrent allocations never collide', async () => {
      const results = await Promise.all(Array.from({ length: 50 }, () => store.nextNonce(USER, 7)));
      expect(new Set(results).size).toBe(50);
      expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    });

    it('throws once the nonce space is exhausted', async () => {
      await setNonceCount(store, USER, 9, MAX_NONCE);
      await expect(store.nextNonce(USER, 9)).rejects.toThrow('nonce space exhausted');
    });
  });

  describe(`${name} prune`, () => {
    let store: ResolverStore;

    beforeEach(async () => {
      store = await openStore();
    });
    afterEach(async () => {
      await store.close();
    });

    it('drops nonce counters older than the one-day retention window', async () => {
      for (const day of [10, 11, 12]) {
        await store.nextNonce(USER, day);
      }
      expect(await store.pruneNonces(12)).toBe(1);
      // The pruned day's counter restarts at 0; the kept days continue where they left off.
      expect(await store.nextNonce(USER, 10)).toBe(0);
      expect(await store.nextNonce(USER, 11)).toBe(1);
      expect(await store.nextNonce(USER, 12)).toBe(1);
    });
  });
}

describeResolverStoreContract('LmdbResolverStore', {
  openStore: () => LmdbResolverStore.openEphemeral(),
  setNonceCount: async (store, user, day, n) => {
    const counters = (store as unknown as { nonces: AztecAsyncMap<string, number> }).nonces;
    await counters.set(`${user}:${day}`, n);
  },
});

// Needs a live Postgres (docker run -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine and
// OXIDE_TEST_PG_URL=postgres://postgres@localhost:5432/postgres). Skipped when unset.
const PG_URL = process.env.OXIDE_TEST_PG_URL;
(PG_URL ? describe : describe.skip)('PgResolverStore backend', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  describeResolverStoreContract('PgResolverStore', {
    openStore: async () => {
      const store = await PgResolverStore.open(PG_URL!, { poolMax: 5 });
      await pool.query('TRUNCATE nonces');
      return store;
    },
    setNonceCount: async (_store, user, day, n) => {
      await pool.query(
        'INSERT INTO nonces (user_address, day, n) VALUES ($1, $2, $3) ON CONFLICT (user_address, day) DO UPDATE SET n = $3',
        [user, day, n],
      );
    },
  });
});
