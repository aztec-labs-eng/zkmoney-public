/**
 * Key names with no imports, so a sync probe can read the wallet store without loading the adapter.
 *
 * Every adapter key lives under this prefix so `clear()` can wipe front-core's
 * state without touching keys other modules own directly (the claimed
 * identity, the passkey breadcrumbs, the active storage id).
 */
export const WEB_STORAGE_PREFIX = "obsidion."

/** The page's chain reads the wallet database keeps, beside the device's keys. */
export const CHAIN_READS_PREFIX = "webwallet.chain."

/** Where older builds kept each view's deposit address and the pool, outside the account's keys. */
export const SIPA_SLOTS_PREFIX = "webwallet.sipa.address."

/** A key an account's persistent stores keep (`obsidion.[<id>.]acct/…`), read only through the database. */
export const isStoreKey = (key: string): boolean => /^obsidion\.(?:[0-9a-f]+\.)?acct\//.test(key)
export const PASSKEY_IDENTITY_MAP_KEY = "obsidion_web_passkey_identity_map"
