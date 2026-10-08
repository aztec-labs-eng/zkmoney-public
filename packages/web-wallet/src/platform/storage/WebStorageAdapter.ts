import type { IStorageAdapter } from "@obsidion/front-core"
import {
  BROADCASTS_STORAGE_KEY,
  NETWORK_STORAGE_KEY,
  OPERATIONS_STORAGE_KEY,
} from "@obsidion/front-core"
import { CONFIG_STORAGE_KEY_PREFIX } from "@obsidion/core/constants"
import { getActiveStorageId } from "./activeStorage"
import { walletStorage } from "./walletStorage"

/**
 * Every adapter key lives under this prefix so `clear()` can wipe front-core's
 * state without touching keys other modules own directly (the claimed
 * identity, the passkey breadcrumbs, the active storage id).
 */
export const WEB_STORAGE_PREFIX = "obsidion."
export const PASSKEY_IDENTITY_MAP_KEY = "obsidion_web_passkey_identity_map"

/**
 * Per-device keys: written before any account exists (the consent prompt answers on the claim
 * page), shared by every account on this browser. Operations and broadcasts carry their own scope,
 * so a visitor's and an account's survive a sign-in between them.
 */
const GLOBAL_KEYS = new Set([
  PASSKEY_IDENTITY_MAP_KEY,
  NETWORK_STORAGE_KEY,
  OPERATIONS_STORAGE_KEY,
  BROADCASTS_STORAGE_KEY,
])
const isGlobal = (key: string) => GLOBAL_KEYS.has(key) || key.startsWith(CONFIG_STORAGE_KEY_PREFIX)

/**
 * `IStorageAdapter` over the rollup's wallet database (`walletStorage.ts`). A returned promise
 * resolves once the write is saved and rejects when it fails, which front-core's rollback and
 * "safe to leave" checks rely on. Account-scoped keys live under `obsidion.<storageId>.`, so
 * several accounts on one browser keep separate contacts, history and stores; {@link GLOBAL_KEYS}
 * stay under `obsidion.`. The namespace is the active storage id (`activeStorage.ts`), read per
 * call so a commit or a sign-out moves every instance at once. No cross-tab notifications: one
 * document holds the database.
 */
export class WebStorageAdapter implements IStorageAdapter {
  private scoped(key: string): string {
    const id = isGlobal(key) ? null : getActiveStorageId()
    return WEB_STORAGE_PREFIX + (id ? `${id}.` : "") + key
  }

  async getItem(key: string): Promise<string | null> {
    return walletStorage.getItem(this.scoped(key))
  }

  async setItem(key: string, value: string): Promise<void> {
    await walletStorage.commitItem(this.scoped(key), value)
  }

  async removeItem(key: string): Promise<void> {
    await walletStorage.commitRemove(this.scoped(key))
  }

  /** Wipes the active account's namespace, not other accounts' or the global keys. No-op without an account. */
  async clear(): Promise<void> {
    const id = getActiveStorageId()
    if (!id) return
    const prefix = `${WEB_STORAGE_PREFIX}${id}.`
    await walletStorage.batch(() => {
      for (const key of walletStorage.keys()) {
        if (key.startsWith(prefix)) walletStorage.removeItem(key)
      }
    })
  }
}

/** Whether this browser holds any account-scoped key for `storageId` on this rollup. */
export function holdsAccountRecords(storageId: string): boolean {
  const prefix = `${WEB_STORAGE_PREFIX}${storageId}.`
  return walletStorage.keys().some((key) => key.startsWith(prefix))
}

/** The app-wide adapter instance. */
export const webStorage = new WebStorageAdapter()
