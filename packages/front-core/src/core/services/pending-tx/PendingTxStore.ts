/**
 * PendingTxStore — encrypted, persistent `IPendingTxStore` for the wallet.
 *
 * Implements the SDK-side `IPendingTxStore` contract; the wallet sees only
 * that interface. A platform injects this concrete impl at construction so a
 * record submitted before a cold launch is still there for the lifecycle to
 * resolve. Other consumers fall back to `InMemoryPendingTxStore`
 * (lives in SDK) which has identical semantics minus encryption + persistence.
 *
 * Backed by `RecordStorage<PendingTxRecord>` (the same primitive
 * the bridge stores use) wrapped through `EncryptedStorageAdapter`. The
 * record holds a tx hash and two timestamps; it stays on the shared
 * encrypted adapter because moving it would be a storage-key migration.
 *
 * Passive eviction model:
 *   - `get`/`list` filter expired records out (UI sees them as gone).
 *   - `listExpired` exposes them for `TxLifecycleService.expireAndTerminalize`.
 *   - `removeExpired(txHash)` actually deletes the persisted blob and
 *     defensively asserts the record IS expired before doing so — a guard
 *     against a single-writer model bug deleting a fresh record.
 *
 * Single-writer for `remove`: `TxLifecycleService` calls it on terminal
 * receipt evidence; the wallet's `sendTx` catch path is the only other
 * caller, used to undo a pre-submit `create` write when `node.sendTx`
 * throws.
 *
 * Unreadable blob: a read that throws (MSK still locked at boot, a different
 * MSK after a fresh install, tampered ciphertext) leaves the store unloaded
 * rather than empty, so a later `load()` recovers the records once the key
 * unlocks. Under a key that works but cannot read the blob, the next
 * successful write replaces it; only pending records are lost.
 */

import type {
  IPendingTxStore,
  PendingTxRecord,
  PendingTxStoreListener,
} from "@obsidion/sdk"

import { RecordStorage } from "../bridge/RecordStorage"
import type { IStorageAdapter } from "../../storages/adapter"
import { EncryptedStorageAdapter } from "../../storages/EncryptedStorageAdapter"

import {
  decodeRecord,
  encodeRecord,
  type SerializedPendingTxRecord,
} from "./encoding"
import {
  CLOCK_SKEW_MARGIN_MS,
  KEY_PENDING,
  MAX_TX_LIFETIME_MS,
} from "./types"
import { logger } from "src/utils/logger"

type ListChangedListener = (records: PendingTxRecord[]) => void

/**
 * Persisted shape stored under each record's `txHash` key. `RecordStorage`
 * JSON-stringifies the kernel as a single dictionary, so we keep the
 * encoded record (not the runtime instance) in the kernel and decode on
 * read. Encryption happens one layer below at the `IStorageAdapter` level.
 */
type StoredRecord = SerializedPendingTxRecord

export class PendingTxStore implements IPendingTxStore {
  private static instance: PendingTxStore | null = null

  private readonly store: RecordStorage<StoredRecord>
  private readonly listeners = new Set<PendingTxStoreListener>()

  private constructor(adapter: EncryptedStorageAdapter) {
    this.store = new RecordStorage<StoredRecord>({
      storage: adapter,
      storageKey: KEY_PENDING,
      keyOf: (r) => r.txHash.toLowerCase(),
      // Null-safe: a malformed persisted entry must not throw out of the kernel's sort.
      sortBy: (r) => (r ? r.submittedAt : 0),
      label: "PendingTxStore",
      // The store boots before the MSK may be unlocked; a locked read must not count as an empty store.
      retryLoadOnReadError: true,
    })
  }

  /**
   * Singleton accessor. The storage adapter MUST be an
   * `EncryptedStorageAdapter` — refuses plain adapters via brand check so
   * the blob under `KEY_PENDING` is always written through the same
   * encryption layer.
   *
   * First call must pass an adapter. Subsequent calls return the same
   * instance and the adapter argument is ignored (matches the bridge stores'
   * pattern).
   */
  static get(storage?: IStorageAdapter): PendingTxStore {
    if (!PendingTxStore.instance) {
      if (!storage) {
        throw new Error(
          "First call to PendingTxStore.get() requires a storage adapter",
        )
      }
      if (!EncryptedStorageAdapter.isEncrypted(storage)) {
        throw new Error(
          "PendingTxStore requires an EncryptedStorageAdapter — the pending blob " +
            "lives on the shared encrypted adapter and a plain IStorageAdapter " +
            "would write it under the same key unencrypted.",
        )
      }
      PendingTxStore.instance = new PendingTxStore(storage)
    }
    return PendingTxStore.instance
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Load persisted state. A blob that cannot be read (locked key, rotated key, tampered ciphertext)
   * leaves the store unloaded, so the next `load()` retries; a write that succeeds meanwhile replaces
   * the unreadable blob. The sweep below drops single malformed entries so one does not poison the rest.
   */
  async load(): Promise<void> {
    await this.store.load()

    // Drop entries that fail `decodeRecord` by their stored key: a malformed entry may have no usable txHash.
    for (const [key, stored] of this.store.entries()) {
      if (safeDecode(stored)) continue
      await this.store.removeByKey(key)
    }
  }

  // ============================================================================
  // Reads
  // ============================================================================

  async get(txHash: string): Promise<PendingTxRecord | undefined> {
    const stored = this.store.getByKey(txHash.toLowerCase())
    if (!stored) return undefined
    const decoded = safeDecode(stored)
    if (!decoded || this.isExpired(decoded)) return undefined
    return decoded
  }

  async list(): Promise<readonly PendingTxRecord[]> {
    const out: PendingTxRecord[] = []
    for (const stored of this.store.list()) {
      const decoded = safeDecode(stored)
      if (decoded && !this.isExpired(decoded)) out.push(decoded)
    }
    return out
  }

  async listExpired(): Promise<readonly PendingTxRecord[]> {
    const out: PendingTxRecord[] = []
    for (const stored of this.store.list()) {
      const decoded = safeDecode(stored)
      if (decoded && this.isExpired(decoded)) out.push(decoded)
    }
    return out
  }

  // ============================================================================
  // Writes
  // ============================================================================

  async create(record: PendingTxRecord): Promise<void> {
    const encoded = encodeRecord(record)
    await this.store.setRecord(record.txHash.toLowerCase(), encoded)
    this.notify(record.txHash)
  }

  async patch(
    txHash: string,
    fields: Partial<Omit<PendingTxRecord, "txHash">>,
  ): Promise<boolean> {
    await this.store.load()
    const key = txHash.toLowerCase()
    const stored = this.store.getByKey(key)
    if (!stored) return false
    const decoded = safeDecode(stored)
    if (!decoded) return false
    const next: PendingTxRecord = { ...decoded, ...fields }
    const encoded = encodeRecord(next)
    await this.store.setRecord(key, encoded)
    this.notify(txHash)
    return true
  }

  async remove(txHash: string): Promise<void> {
    const key = txHash.toLowerCase()
    const had = this.store.getByKey(key) !== null
    await this.store.removeByKey(key)
    if (had) this.notify(txHash)
  }

  /**
   * Defensive variant of `remove`: asserts the record is expired before
   * deleting, so a coordinator bug that calls this on a fresh record fails
   * loud rather than corrupting state.
   */
  async removeExpired(txHash: string): Promise<void> {
    const key = txHash.toLowerCase()
    const stored = this.store.getByKey(key)
    if (!stored) return
    if (!this.isExpired(stored)) {
      throw new Error(
        `PendingTxStore.removeExpired: record ${txHash} is not expired (defense-in-depth)`,
      )
    }
    await this.store.removeByKey(key)
    this.notify(txHash)
  }

  async clearAll(): Promise<void> {
    await this.store.clearAll()
  }

  // ============================================================================
  // Subscriptions
  // ============================================================================

  onUpdated(listener: PendingTxStoreListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Bonus listener over the full non-expired list — not part of
   * `IPendingTxStore` but mirrors the bridge stores' API for UI hooks
   * that want a list snapshot without repeated `list()` calls.
   *
   * The kernel `RecordStorage.onListChanged` fires on every persisted write
   * with the underlying stored shape; we filter expired and decode before
   * surfacing to the consumer.
   */
  onListChanged(listener: ListChangedListener): () => void {
    return this.store.onListChanged((records) => {
      const live: PendingTxRecord[] = []
      for (const stored of records) {
        const decoded = safeDecode(stored)
        if (decoded && !this.isExpired(decoded)) live.push(decoded)
      }
      try {
        listener(live)
      } catch (err) {
        logger.warn("[PendingTxStore] listChanged listener error:", err)
      }
    })
  }

  // ============================================================================
  // Internal
  // ============================================================================

  private notify(txHash: string): void {
    for (const listener of this.listeners) {
      try {
        listener(txHash)
      } catch (err) {
        logger.warn("[PendingTxStore] listener threw:", err)
      }
    }
  }

  /**
   * TTL formula:
   *   ttl_anchor = min(record.expiresAtMs, record.submittedAt + MAX_TX_LIFETIME_MS)
   *   expired-at-now <=> Date.now() > ttl_anchor + CLOCK_SKEW_MARGIN_MS
   *
   * The clock-skew margin is on the read side so a record dipping briefly
   * past its expiry doesn't get yanked out from under a coordinator that
   * just observed it as live.
   */
  private isExpired(record: StoredRecord): boolean {
    const ttlAnchor = Math.min(
      record.expiresAtMs,
      record.submittedAt + MAX_TX_LIFETIME_MS,
    )
    return Date.now() > ttlAnchor + CLOCK_SKEW_MARGIN_MS
  }
}

function safeDecode(stored: StoredRecord): PendingTxRecord | undefined {
  try {
    return decodeRecord(stored)
  } catch (err) {
    logger.warn(
      "[PendingTxStore] decode failed for %s: %s",
      stored?.txHash,
      (err as Error).message,
    )
    return undefined
  }
}
