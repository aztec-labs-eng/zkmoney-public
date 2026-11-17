import type { Database } from "./database"
import { persistentStore } from "./persistentStore"

/** What the backup passkey funnel already reported of one add attempt. */
export interface BackupFunnelMark {
  attemptId: string
  /** The steps reported: rotation phases, `attention:<reason>`, `recovery:<state>`, `delay:<delay>`. */
  reported: string[]
  /** The last phase reported while the record stood at it, and the record's `updatedAt` then. */
  timed?: { step: string; at: number }
}

export type BackupFunnelMarks = Readonly<Record<string, BackupFunnelMark>>

export interface BackupFunnel {
  /**
   * Reads the marks saved for `ids` and saves the ones `decide` returns for them in one write.
   * Resolves, once committed, to what `decide` reports: a step is reported by one call only.
   */
  report<T>(
    ids: readonly string[],
    decide: (marks: BackupFunnelMarks) => { next: BackupFunnelMarks; events: T[] },
  ): Promise<T[]>
}

export function createBackupFunnel({ db }: { db: Database }): BackupFunnel {
  const store = persistentStore<BackupFunnelMark>(db, {
    prefix: "acct/backupFunnel",
    version: 1,
    id: (mark) => mark.attemptId,
    load: "all",
  })
  return {
    async report(ids, decide) {
      await store.ready
      return db.write(async (w) => {
        const marks: Record<string, BackupFunnelMark> = {}
        for (const id of ids) {
          const mark = await store.get(id, w)
          if (mark) marks[id] = mark
        }
        const { next, events } = decide(marks)
        for (const id of ids) {
          const mark = next[id]
          if (mark && mark !== marks[id]) await store.put(mark, w)
        }
        return events
      })
    },
  }
}
