import type { ResolverConfig } from './config.js';
import type { ResolverStore } from './resolver_store.js';

/**
 * Opens the store the config selects: the shared SQL store when `dbUrl` is set (mandatory in gateway mode), else LMDB
 * at `dataDir`. Backends load lazily so a process only pulls in the one it uses.
 */
export async function createStore(config: ResolverConfig): Promise<ResolverStore> {
  if (config.dbUrl) {
    const { PgResolverStore } = await import('./pg_resolver_store.js');
    // The gateway holds one connection per instance; the fleet scales horizontally.
    return PgResolverStore.open(config.dbUrl, {
      poolMax: 1,
      caPath: config.dbCaPath,
      schema: config.dbSchema,
      createSchema: config.mode === 'local',
    });
  }
  if (!config.dataDir) {
    throw new Error('no OXIDE_RESOLVER_DB_URL and no OXIDE_RESOLVER_DATA_DIR — nowhere to put the store');
  }
  const { LmdbResolverStore } = await import('./lmdb_resolver_store.js');
  return LmdbResolverStore.open(config.dataDir);
}
