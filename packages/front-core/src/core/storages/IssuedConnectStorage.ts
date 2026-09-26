import { DEFAULT_MAX_AGE_MS, ISSUED_CONNECT_STORAGE_KEY } from "./storage-constants.js"
import type { IStorageAdapter, StorageLock } from "./adapter.js"

/**
 * IssuedConnectStorage — the sharer-side local ledger of handshake codes this
 * device has minted (serverless QR / link contact handshake).
 *
 * When the sharer mints a code, the per-share UUID is encoded into the inline
 * packet, and the device records the UUID here. Later, a scanner's XMTP
 * connect-back echoes the UUID back; the receiver looks it up to confirm the
 * connect-back corresponds to a code *this* device issued, then removes it
 * (single-use auto-add). There is no server blob and nothing to revoke — the
 * UUID is purely the local matching token.
 *
 * A reinstall loses this store; a replayed link then simply can't be matched
 * (graceful no-add).
 *
 * Entries carry `createdAt`; on every load we prune anything older than the
 * max age so a stale device store doesn't grow unbounded. The window only needs
 * to outlive the connect-back delivery window (a scanner that scans offline may
 * not deliver its connect-back until it next reconnects).
 */
export interface IssuedConnectRecord {
  /** Epoch ms at mint time; drives prune-on-load. */
  createdAt: number
}

type IssuedConnectMap = Record<string, IssuedConnectRecord>

export class IssuedConnectStorage {
  private static instance: IssuedConnectStorage | null = null
  private storage: IStorageAdapter
  private maxAgeMs: number
  private entries: IssuedConnectMap = {}
  private loadPromise: Promise<void> | null = null
  /** Cross-context write mutex (web: navigator.locks). Absent = writes run directly. */
  private lock?: StorageLock

  private constructor(storage: IStorageAdapter, maxAgeMs: number, lock?: StorageLock) {
    this.storage = storage
    this.maxAgeMs = maxAgeMs
    this.lock = lock
    // Another context wrote the map — drop the cache so the next read reloads.
    storage.subscribe?.(ISSUED_CONNECT_STORAGE_KEY, () => {
      this.loadPromise = null
    })
  }

  static get(
    storage?: IStorageAdapter,
    maxAgeMs: number = DEFAULT_MAX_AGE_MS,
    lock?: StorageLock,
  ): IssuedConnectStorage {
    if (!IssuedConnectStorage.instance) {
      if (!storage) {
        throw new Error("First call to getInstance requires parameter")
      }
      IssuedConnectStorage.instance = new IssuedConnectStorage(storage, maxAgeMs, lock)
    }
    return IssuedConnectStorage.instance
  }

  /** Test seam — drops the singleton. Production code never calls this. */
  static resetForTests(): void {
    IssuedConnectStorage.instance = null
  }

  /** Public initializer: loads persisted entries. */
  public async initialize(): Promise<void> {
    await this.ensureLoaded()
  }

  /**
   * Single-flight load. Subsequent callers share the in-flight promise.
   * Rejected loads clear the cached promise so a transient adapter failure
   * doesn't permanently lock the singleton — the next public call retries.
   */
  private ensureLoaded(): Promise<void> {
    if (this.loadPromise === null) {
      this.loadPromise = this.doLoad().catch((error) => {
        this.loadPromise = null
        throw error
      })
    }
    return this.loadPromise
  }

  private async doLoad(): Promise<void> {
    const raw = await this.storage.getItem(ISSUED_CONNECT_STORAGE_KEY)
    if (raw === null) {
      this.entries = {}
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await this.storage.removeItem(ISSUED_CONNECT_STORAGE_KEY)
      this.entries = {}
      return
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      await this.storage.removeItem(ISSUED_CONNECT_STORAGE_KEY)
      this.entries = {}
      return
    }

    const now = Date.now()
    const cleaned: IssuedConnectMap = {}
    let changed = false
    for (const [uuid, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!this.isValidRecord(value)) {
        changed = true
        continue
      }
      // Prune expired entries on load.
      if (now - value.createdAt > this.maxAgeMs) {
        changed = true
        continue
      }
      cleaned[uuid] = value
    }

    this.entries = cleaned
    if (changed) {
      // Persist the pruned map so the same stale data isn't re-filtered next launch.
      await this.saveToStorage()
    }
  }

  private isValidRecord(value: unknown): value is IssuedConnectRecord {
    if (typeof value !== "object" || value === null) return false
    const v = value as Record<string, unknown>
    return typeof v.createdAt === "number" && Number.isFinite(v.createdAt)
  }

  private async saveToStorage(): Promise<void> {
    await this.storage.setItem(ISSUED_CONNECT_STORAGE_KEY, JSON.stringify(this.entries))
  }

  /**
   * Every read-modify-write runs through here. With a lock, the persisted map is re-read inside
   * the critical section (refreshing the cache) so this write layers on top of any other
   * context's. Without a lock the write runs directly on the cached map.
   */
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.lock) {
      return (async () => {
        await this.ensureLoaded()
        return fn()
      })()
    }
    return this.lock(async () => {
      this.loadPromise = null
      await this.ensureLoaded()
      return fn()
    })
  }

  /**
   * Record a freshly-minted handshake code keyed by its per-share UUID — the
   * local connect-back matching token. `createdAt` defaults to now; overridable
   * for tests.
   */
  public async recordHandshake(uuid: string, createdAt: number = Date.now()): Promise<void> {
    await this.mutate(async () => {
      this.entries[uuid] = { createdAt }
      await this.saveToStorage()
    })
  }

  /**
   * Look up the local record for a UUID (the connect-back match). Returns
   * `null` when this device never issued (or has pruned/removed) that UUID —
   * the receiver treats that as "no match", not an error.
   */
  public async lookup(uuid: string): Promise<IssuedConnectRecord | null> {
    await this.ensureLoaded()
    return this.entries[uuid] ?? null
  }

  /** Remove the local record (called on redeem). No-op if absent. */
  public async remove(uuid: string): Promise<void> {
    await this.mutate(async () => {
      if (uuid in this.entries) {
        delete this.entries[uuid]
        await this.saveToStorage()
      }
    })
  }
}
