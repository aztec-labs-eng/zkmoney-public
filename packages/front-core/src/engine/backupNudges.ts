import type { Database } from "./database"
import { persistentStore } from "./persistentStore"
import { derived, memoryStore, type ReadonlyStore } from "./store"

/** The balance card's "Not now": the threshold it was showing for. */
interface BackupNudgePutOff {
  id: typeof CURRENT
  /** Main's balance threshold, atomic. */
  threshold: bigint
}

/** When the account's nudges to add a backup passkey were put off. */
export interface BackupNudges {
  /** The threshold a saved "Not now" put the balance card off at; `unread` until it reads. */
  readonly putOffAt: ReadonlyStore<bigint | null | "unread">
  /** The one-device card was put off in this session. */
  readonly hiddenForSession: ReadonlyStore<boolean>
  /** Keeps the balance card hidden until Main's balance reaches a threshold above `threshold`. */
  putOffUntilAbove(threshold: bigint): Promise<void>
  hideForSession(): void
}

const CURRENT = "current"

export function createBackupNudges({ db }: { db: Database }): BackupNudges {
  const store = persistentStore<BackupNudgePutOff>(db, {
    prefix: "acct/backupNudges",
    version: 1,
    id: (record) => record.id,
    load: "all",
  })
  const hidden = memoryStore(false)
  return {
    // A failed read is never none.
    putOffAt: derived([store.view], ({ records, loaded, failed }) =>
      failed || !loaded ? "unread" : records[0]?.threshold ?? null,
    ),
    hiddenForSession: hidden.readonly,
    putOffUntilAbove: (threshold) => store.put({ id: CURRENT, threshold }),
    hideForSession: () => hidden.set(true),
  }
}
