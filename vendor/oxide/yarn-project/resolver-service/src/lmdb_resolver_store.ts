import type { AztecAsyncMap } from '@aztec-labs/kv-store';
import { type AztecLMDBStoreV2, openStoreAt, openTmpStore } from '@aztec-labs/kv-store/lmdb-v2';

import { MAX_NONCE } from '@oxide/oxide-lib/oxide_constants.gen.js';

import type { Hex } from 'viem';

import { EXPIRATION_TIME_DAYS, type ResolverStore } from './resolver_store.js';

/** LMDB-backed {@link ResolverStore}: single-process state for dev and e2e. */
export class LmdbResolverStore implements ResolverStore {
  private constructor(
    private readonly store: AztecLMDBStoreV2,
    private readonly nonces: AztecAsyncMap<string, number>,
  ) {}

  static async open(dataDir: string): Promise<LmdbResolverStore> {
    const store = await openStoreAt(dataDir);
    return new LmdbResolverStore(store, store.openMap('nonces'));
  }

  /** Ephemeral store for tests. */
  static async openEphemeral(): Promise<LmdbResolverStore> {
    const store = await openTmpStore('resolver-service', true);
    return new LmdbResolverStore(store, store.openMap('nonces'));
  }

  nextNonce(userIdentifier: Hex, day: number): Promise<number> {
    const key = `${userIdentifier}:${day}`;
    // The read-modify-write runs in one store transaction so concurrent gateway requests for the same key can't be
    // handed the same nonce — duplicates would derive the same SIPA, colliding two resolutions on one SIPA
    // and breaking unlinkability.
    return this.store.transactionAsync(async () => {
      const current = (await this.nonces.getAsync(key)) ?? 0;
      if (current >= MAX_NONCE) {
        throw new Error(`nonce space exhausted for ${key}`);
      }
      await this.nonces.set(key, current + 1);
      return current;
    });
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  async pruneNonces(currentDay: number): Promise<number> {
    const threshold = currentDay - EXPIRATION_TIME_DAYS;
    let dropped = 0;
    for await (const key of this.nonces.keysAsync()) {
      if (Number(key.slice(key.lastIndexOf(':') + 1)) < threshold) {
        await this.nonces.delete(key);
        dropped++;
      }
    }
    return dropped;
  }
}
