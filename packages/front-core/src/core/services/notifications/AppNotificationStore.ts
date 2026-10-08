import type { IStorageAdapter } from "../../storages/adapter"
import { RecordStorage } from "../bridge/RecordStorage"

export const APP_NOTIFICATION_STORAGE_KEY = "@obsidion/app-notifications/records"
// Cap is timestamp-FIFO (oldest evicted first) with no read-state or
// severity protection. Bumped from the original 50 to 200 to keep
// headroom now that the bell serves higher-frequency events (verified
// incoming transfers in addition to bridge flows). 200 entries × ~500
// bytes ≈ 100KB JSON blob — negligible storage cost.
export const APP_NOTIFICATION_LIMIT = 200

export type AppNotificationSeverity = "info" | "success" | "error"

export type BridgeNotificationTarget =
  | {
      type: "bridge.txDetail"
      bridgeKind: "deposit"
      sourceId: string
    }
  | {
      type: "bridge.txDetail"
      bridgeKind: "withdrawal"
      sourceId: string
      l2TxHash?: string
    }

export type TransferNotificationTarget = {
  type: "transfer.txDetail"
  txHash: string
}

export type PaylinkClaimedNotificationTarget = {
  type: "paylink.claimed"
  txHash: string
}

export type PaylinkReclaimableNotificationTarget = {
  type: "paylink.reclaimable"
  txHash: string
}

export type ReorgNotificationTarget = {
  type: "reorg.txDetail"
  txHash: string
}

/** `contactId` is the contact-detail route param: the tag when registered, else the stored address. */
export type ContactAddedNotificationTarget = {
  type: "contact.added"
  contactId: string
}

/** Funds on a retired deployment with nothing to do yet: the Activity screen, where they show. */
export type MigrationResidualsNotificationTarget = {
  type: "migration.residuals"
}

export type AppNotificationTarget =
  | BridgeNotificationTarget
  | TransferNotificationTarget
  | PaylinkClaimedNotificationTarget
  | PaylinkReclaimableNotificationTarget
  | ReorgNotificationTarget
  | ContactAddedNotificationTarget
  | MigrationResidualsNotificationTarget
  | {
      type: string
      [key: string]: unknown
    }

export interface AppNotificationEntry {
  id: string
  producer: string
  domain: string
  sourceId: string
  title: string
  description: string
  timestampMs: number
  systemIcon: string
  severity: AppNotificationSeverity
  read: boolean
  readAt?: number
  /** Hidden from the list. Kept (not deleted) so producer replays cannot re-mint it. */
  dismissedAt?: number
  /** Work still in flight — the row shows a spinner where a settled row shows its timestamp. */
  pending?: boolean
  target: AppNotificationTarget
}

export type CreateAppNotificationInput = Omit<AppNotificationEntry, "read" | "readAt"> &
  Partial<Pick<AppNotificationEntry, "read" | "readAt">>

export interface CreateAppNotificationResult {
  entry: AppNotificationEntry
  created: boolean
}

function normalizeEntry(input: CreateAppNotificationInput): AppNotificationEntry {
  const read = input.read ?? false
  return {
    ...input,
    read,
    readAt: read ? input.readAt : undefined,
  }
}

/** Everything the panel renders. Equal on both sides means an upsert has nothing to write. */
function sameDisplay(a: AppNotificationEntry, b: AppNotificationEntry): boolean {
  return (
    a.title === b.title &&
    a.description === b.description &&
    a.timestampMs === b.timestampMs &&
    a.systemIcon === b.systemIcon &&
    a.severity === b.severity &&
    !!a.pending === !!b.pending
  )
}

export class AppNotificationStore {
  private static instance: AppNotificationStore | null = null
  private store: RecordStorage<AppNotificationEntry>

  constructor(storage: IStorageAdapter) {
    this.store = new RecordStorage<AppNotificationEntry>({
      storage,
      storageKey: APP_NOTIFICATION_STORAGE_KEY,
      keyOf: (entry) => entry.id,
      sortBy: (entry) => entry.timestampMs,
      label: "AppNotificationStore",
    })
  }

  static get(storage?: IStorageAdapter): AppNotificationStore {
    if (!AppNotificationStore.instance) {
      if (!storage) {
        throw new Error("First call to AppNotificationStore.get() requires a storage adapter")
      }
      AppNotificationStore.instance = new AppNotificationStore(storage)
    }
    return AppNotificationStore.instance
  }

  async load(): Promise<void> {
    await this.store.load()
    await this.enforceLimit()
  }

  // Mutations snapshot the list then write it back; two in flight at once (a row tap's dismiss +
  // the panel close's markAllRead) would clobber each other, so they run one at a time.
  private opChain: Promise<unknown> = Promise.resolve()
  private serialized<T>(op: () => Promise<T>): Promise<T> {
    const next = this.opChain.catch(() => {}).then(op)
    this.opChain = next
    return next
  }

  get(id: string): AppNotificationEntry | null {
    return this.store.getByKey(id)
  }

  list(): AppNotificationEntry[] {
    return this.store.list()
  }

  unreadCount(): number {
    return this.store.list().filter((entry) => !entry.read).length
  }

  hasUnread(): boolean {
    return this.unreadCount() > 0
  }

  createIfAbsent(input: CreateAppNotificationInput): Promise<CreateAppNotificationResult> {
    return this.serialized(async () => {
      await this.load()
      const existing = this.store.getByKey(input.id)
      if (existing) {
        return { entry: existing, created: false }
      }

      const entry = normalizeEntry(input)
      await this.store.setRecord(entry.id, entry)
      await this.enforceLimit()
      return { entry, created: true }
    })
  }

  /**
   * Create, or rewrite in place when the id is already known — the write path for a live entry
   * whose text tracks an in-flight record. Read state carries over. A dismissed settled entry stays
   * hidden while its text is unchanged and comes back the moment it changes, so a recurring source
   * (a re-used SIPA, a second withdrawal) notifies again without minting a second row. A dismissed
   * live (pending) entry comes back as soon as its producer asserts it again: the panel never
   * dismisses a pending row, so only its producer retired it, and a funding burn tried again is in
   * flight again.
   */
  upsert(input: CreateAppNotificationInput): Promise<AppNotificationEntry> {
    return this.serialized(async () => {
      await this.load()
      const existing = this.store.getByKey(input.id)
      const entry: AppNotificationEntry = {
        ...normalizeEntry(input),
        read: existing?.read ?? false,
        readAt: existing?.readAt,
      }
      const revived = existing?.dismissedAt !== undefined && entry.pending === true
      if (existing && !revived && sameDisplay(existing, entry)) return existing
      await this.store.setRecord(entry.id, entry)
      await this.enforceLimit()
      return entry
    })
  }

  /** Rewrites where an entry opens; what it shows and its read and dismissed state stay put. */
  setTarget(id: string, target: AppNotificationTarget): Promise<AppNotificationEntry | null> {
    return this.serialized(async () => {
      await this.load()
      const existing = this.store.getByKey(id)
      if (!existing) return null
      const next: AppNotificationEntry = { ...existing, target }
      await this.store.setRecord(id, next)
      return next
    })
  }

  markRead(id: string, readAt: number = Date.now()): Promise<AppNotificationEntry | null> {
    return this.serialized(async () => {
      await this.load()
      const existing = this.store.getByKey(id)
      if (!existing) return null
      if (existing.read) return existing

      const next: AppNotificationEntry = {
        ...existing,
        read: true,
        readAt,
      }
      await this.store.setRecord(id, next)
      return next
    })
  }

  dismiss(id: string, dismissedAt: number = Date.now()): Promise<void> {
    return this.serialized(async () => {
      await this.load()
      const existing = this.store.getByKey(id)
      if (!existing || existing.dismissedAt) return
      await this.store.setRecord(id, {
        ...existing,
        read: true,
        readAt: existing.readAt ?? dismissedAt,
        dismissedAt,
      })
    })
  }

  /** Deletes the entry, where a dismiss would keep its id from being minted again. */
  remove(id: string): Promise<void> {
    return this.serialized(() => this.store.removeByKey(id))
  }

  /** `keepPending` leaves live rows, which their producer retires when the work settles. */
  dismissAll(
    dismissedAt: number = Date.now(),
    { keepPending = false }: { keepPending?: boolean } = {},
  ): Promise<void> {
    return this.serialized(async () => {
      await this.load()
      const entries = this.store.list()
      const kept = (entry: AppNotificationEntry) =>
        !!entry.dismissedAt || (keepPending && !!entry.pending)
      if (entries.every(kept)) return
      await this.store.replaceAll(
        entries.map((entry) =>
          kept(entry)
            ? entry
            : { ...entry, read: true, readAt: entry.readAt ?? dismissedAt, dismissedAt },
        ),
      )
    })
  }

  markAllRead(readAt: number = Date.now()): Promise<AppNotificationEntry[]> {
    return this.serialized(async () => {
      await this.load()
      const entries = this.store.list()
      if (entries.every((entry) => entry.read)) return entries

      const next = entries.map((entry) =>
        entry.read
          ? entry
          : {
              ...entry,
              read: true,
              readAt,
            },
      )
      await this.store.replaceAll(next)
      return this.store.list()
    })
  }

  onListChanged(listener: (entries: AppNotificationEntry[]) => void): () => void {
    return this.store.onListChanged(listener)
  }

  private async enforceLimit(): Promise<void> {
    const entries = this.store.list()
    if (entries.length <= APP_NOTIFICATION_LIMIT) return
    await this.store.replaceAll(entries.slice(0, APP_NOTIFICATION_LIMIT))
  }
}
