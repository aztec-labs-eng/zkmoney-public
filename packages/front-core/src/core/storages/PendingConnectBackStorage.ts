import { DEFAULT_MAX_AGE_MS, PENDING_CONNECT_BACK_STORAGE_KEY } from "./storage-constants.js"
import type { IStorageAdapter, StorageLock } from "./adapter.js"

/**
 * PendingConnectBackStorage — the scanner-side outbox of connect-backs whose
 * XMTP *send* failed (Bob offline at scan time, a `canMessage` reachability
 * miss, or a `dm.send` throw).
 *
 * In the serverless handshake the scanner (B) decodes the sharer's (A's) packet
 * offline and adds A locally, then sends a connect-back over XMTP so A can
 * mutual-add B. XMTP store-and-forwards to A's mailbox, so A being offline is a
 * non-issue — but if B is offline *at scan time* the send itself fails and the
 * mutual-add would be silently dropped. This outbox persists those failed sends
 * and a foreground/connectivity flush re-attempts them.
 *
 * Resends are safe: A's side is idempotent (uuid match → add → remove), so a
 * duplicate resend after a successful first delivery finds nothing and can't
 * double-add. Entries are keyed by `uuid` (one outstanding connect-back per
 * scanned code) and carry `attempts` + `createdAt` so the flusher can give up
 * on a permanently-undeliverable peer and prune-on-load drops stale entries.
 */
export interface PendingConnectBack {
  /** The redeemed handshake uuid — the dedupe key and the connect-back payload value. */
  uuid: string
  /** The sharer's XMTP (Ethereum-format) address — the send target. */
  peerXmtp: string
  /** The connect-back wire content (version + uuid + optional claimed tag). */
  content: { version: number; uuid: string; tag?: string }
  /** How many send attempts have been made (capped by the flusher). */
  attempts: number
  /** Epoch ms at first enqueue; drives prune-on-load. */
  createdAt: number
}

/** Drop an entry once this many sends have failed — a permanently-dead peer. */
export const DEFAULT_MAX_ATTEMPTS = 10

type PendingMap = Record<string, PendingConnectBack>

export class PendingConnectBackStorage {
  private static instance: PendingConnectBackStorage | null = null
  private storage: IStorageAdapter
  private maxAgeMs: number
  private entries: PendingMap = {}
  private loadPromise: Promise<void> | null = null
  /** Cross-context write mutex (web: navigator.locks). Absent = writes run directly. */
  private lock?: StorageLock

  private constructor(storage: IStorageAdapter, maxAgeMs: number, lock?: StorageLock) {
    this.storage = storage
    this.maxAgeMs = maxAgeMs
    this.lock = lock
    // Another context wrote the outbox — drop the cache so the next read reloads.
    storage.subscribe?.(PENDING_CONNECT_BACK_STORAGE_KEY, () => {
      this.loadPromise = null
    })
  }

  static get(
    storage?: IStorageAdapter,
    maxAgeMs: number = DEFAULT_MAX_AGE_MS,
    lock?: StorageLock,
  ): PendingConnectBackStorage {
    if (!PendingConnectBackStorage.instance) {
      if (!storage) {
        throw new Error("First call to get requires a storage adapter")
      }
      PendingConnectBackStorage.instance = new PendingConnectBackStorage(storage, maxAgeMs, lock)
    }
    return PendingConnectBackStorage.instance
  }

  /** Test seam — drops the singleton. Production code never calls this. */
  static resetForTests(): void {
    PendingConnectBackStorage.instance = null
  }

  public async initialize(): Promise<void> {
    await this.ensureLoaded()
  }

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
    const raw = await this.storage.getItem(PENDING_CONNECT_BACK_STORAGE_KEY)
    if (raw === null) {
      this.entries = {}
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await this.storage.removeItem(PENDING_CONNECT_BACK_STORAGE_KEY)
      this.entries = {}
      return
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      await this.storage.removeItem(PENDING_CONNECT_BACK_STORAGE_KEY)
      this.entries = {}
      return
    }

    const now = Date.now()
    const cleaned: PendingMap = {}
    let changed = false
    for (const [uuid, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!this.isValidRecord(value)) {
        changed = true
        continue
      }
      if (now - value.createdAt > this.maxAgeMs) {
        changed = true
        continue
      }
      cleaned[uuid] = value
    }

    this.entries = cleaned
    if (changed) await this.saveToStorage()
  }

  private isValidRecord(value: unknown): value is PendingConnectBack {
    if (typeof value !== "object" || value === null) return false
    const v = value as Record<string, unknown>
    return (
      typeof v.uuid === "string" &&
      typeof v.peerXmtp === "string" &&
      typeof v.attempts === "number" &&
      Number.isFinite(v.attempts) &&
      typeof v.createdAt === "number" &&
      Number.isFinite(v.createdAt) &&
      typeof v.content === "object" &&
      v.content !== null &&
      typeof (v.content as Record<string, unknown>).version === "number" &&
      typeof (v.content as Record<string, unknown>).uuid === "string"
    )
  }

  private async saveToStorage(): Promise<void> {
    await this.storage.setItem(PENDING_CONNECT_BACK_STORAGE_KEY, JSON.stringify(this.entries))
  }

  /**
   * Every read-modify-write runs through here. With a lock, the persisted outbox is re-read inside
   * the critical section (refreshing the cache) so this write layers on top of any other
   * context's. Without a lock the write runs directly on the cached outbox.
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
   * Enqueue (or replace) a failed connect-back, keyed by its uuid. A re-scan of
   * the same code overwrites the existing entry and resets `attempts` —
   * intentional, since the user clearly wants it delivered. `createdAt`
   * defaults to now; overridable for tests.
   */
  public async enqueue(
    entry: Pick<PendingConnectBack, "uuid" | "peerXmtp" | "content">,
    createdAt: number = Date.now(),
  ): Promise<void> {
    await this.mutate(async () => {
      this.entries[entry.uuid] = {
        uuid: entry.uuid,
        peerXmtp: entry.peerXmtp,
        content: entry.content,
        attempts: 0,
        createdAt,
      }
      await this.saveToStorage()
    })
  }

  /** All currently-pending connect-backs. */
  public async list(): Promise<PendingConnectBack[]> {
    await this.ensureLoaded()
    return Object.values(this.entries)
  }

  /** Remove an entry (called on a successful resend or on giving up). No-op if absent. */
  public async remove(uuid: string): Promise<void> {
    await this.mutate(async () => {
      if (uuid in this.entries) {
        delete this.entries[uuid]
        await this.saveToStorage()
      }
    })
  }

  /**
   * Record a failed resend attempt. Returns the new attempt count. The flusher
   * compares it to the max-attempts cap to decide whether to give up.
   */
  public async recordAttempt(uuid: string): Promise<number> {
    return this.mutate(async () => {
      const entry = this.entries[uuid]
      if (!entry) return 0
      entry.attempts += 1
      await this.saveToStorage()
      return entry.attempts
    })
  }
}

/* -------------------------------------------------------------------------- */
/*  Flusher                                                                   */
/* -------------------------------------------------------------------------- */

/** The send port the flusher drives (structural subset of XmtpClientManager). */
export interface ConnectBackSender {
  sendConnectBack(
    peerXmtp: string,
    content: { version: number; uuid: string; tag?: string },
  ): Promise<{ ok: boolean }>
}

export interface FlushConnectBacksOptions {
  /** Give up on an entry after this many failed attempts. */
  maxAttempts?: number
  /** Optional logger seam. */
  log?: (msg: string, ...args: unknown[]) => void
}

/**
 * Re-send every pending connect-back. On a successful (`ok: true`) send, remove
 * the entry. On a non-ok result or a throw, record the attempt and drop the
 * entry once it exceeds `maxAttempts` (a permanently-dead peer). Never throws —
 * one bad entry can't stall the rest. Safe to call repeatedly (idempotent on
 * A's side), so a foreground/connectivity trigger can fire it freely.
 */
export async function flushPendingConnectBacks(
  store: PendingConnectBackStorage,
  sender: ConnectBackSender,
  options: FlushConnectBacksOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const log = options.log ?? (() => {})

  const pending = await store.list()
  for (const entry of pending) {
    let delivered = false
    try {
      const result = await sender.sendConnectBack(entry.peerXmtp, entry.content)
      delivered = result.ok === true
    } catch (err) {
      log("[flushPendingConnectBacks] send threw", err)
      delivered = false
    }

    if (delivered) {
      await store.remove(entry.uuid)
      continue
    }

    const attempts = await store.recordAttempt(entry.uuid)
    if (attempts >= maxAttempts) {
      log("[flushPendingConnectBacks] giving up after max attempts", {
        uuid: entry.uuid,
        attempts,
      })
      await store.remove(entry.uuid)
    }
  }
}
