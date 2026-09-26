import type { IStorageAdapter } from "@obsidion/front-core"
import { NETWORK_STORAGE_KEY, OPERATIONS_STORAGE_KEY } from "@obsidion/front-core"
import { CONFIG_STORAGE_KEY_PREFIX } from "@obsidion/core/constants"
import { getActiveStorageId } from "./activeStorage"

/**
 * Every adapter key lives under this prefix so `clear()` can wipe front-core's
 * state without touching keys other modules own directly (the claimed
 * identity, the passkey breadcrumbs, the active storage id).
 */
export const WEB_STORAGE_PREFIX = "obsidion."
export const PASSKEY_IDENTITY_MAP_KEY = "obsidion_web_passkey_identity_map"

/**
 * Per-device keys: written before any account exists (the consent prompt answers on the claim
 * page), shared by every account on this browser. Operations carry their own scope, so a visitor's
 * and an account's survive a sign-in between them.
 */
const GLOBAL_KEYS = new Set([PASSKEY_IDENTITY_MAP_KEY, NETWORK_STORAGE_KEY, OPERATIONS_STORAGE_KEY])
const isGlobal = (key: string) => GLOBAL_KEYS.has(key) || key.startsWith(CONFIG_STORAGE_KEY_PREFIX)

/**
 * `IStorageAdapter` over `localStorage`. Account-scoped keys live under
 * `obsidion.<storageId>.`, so several accounts on one browser keep separate
 * contacts, history and stores; {@link GLOBAL_KEYS} stay under `obsidion.`.
 * The namespace is the active storage id (`activeStorage.ts`), read per call so a commit or a
 * sign-out moves every instance at once.
 */
export class WebStorageAdapter implements IStorageAdapter {
  private scoped(key: string): string {
    const id = isGlobal(key) ? null : getActiveStorageId()
    return WEB_STORAGE_PREFIX + (id ? `${id}.` : "") + key
  }

  async getItem(key: string): Promise<string | null> {
    return localStorage.getItem(this.scoped(key))
  }

  async setItem(key: string, value: string): Promise<void> {
    localStorage.setItem(this.scoped(key), value)
  }

  async removeItem(key: string): Promise<void> {
    localStorage.removeItem(this.scoped(key))
  }

  /** Wipes the active account's namespace, not other accounts' or the global keys. No-op without an account. */
  async clear(): Promise<void> {
    const id = getActiveStorageId()
    if (!id) return
    const prefix = `${WEB_STORAGE_PREFIX}${id}.`
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key)
    }
  }

  /**
   * Notify when ANOTHER tab writes a key with this prefix. The browser storage
   * event only fires in tabs that did not do the write, so there is no echo.
   * The callback receives the adapter-level key (namespace prefix stripped).
   */
  watch(prefix: string, onChange: (key: string) => void): () => void {
    const listener = (event: StorageEvent) => {
      const scoped = this.scoped(prefix)
      if (!event.key?.startsWith(scoped)) return
      onChange(prefix + event.key.slice(scoped.length))
    }
    window.addEventListener("storage", listener)
    return () => window.removeEventListener("storage", listener)
  }

  /**
   * Fires `cb` when another tab writes this key (the `storage` event only fires cross-document).
   * A null event key is a full localStorage clear — that touches every key, so notify too.
   */
  subscribe(key: string, cb: () => void): () => void {
    const prefixed = this.scoped(key)
    const handler = (event: StorageEvent) => {
      if (event.key === null || event.key === prefixed) cb()
    }
    window.addEventListener("storage", handler)
    return () => window.removeEventListener("storage", handler)
  }
}

/** Whether this browser holds any account-scoped key for `storageId`. */
export function holdsAccountRecords(storageId: string): boolean {
  if (typeof localStorage === "undefined") return false
  const prefix = `${WEB_STORAGE_PREFIX}${storageId}.`
  return Object.keys(localStorage).some((key) => key.startsWith(prefix))
}

/** The app-wide adapter instance — one set of storage-event listeners, no per-call allocation. */
export const webStorage = new WebStorageAdapter()
