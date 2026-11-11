import { migrateWithdrawFunnel } from "../storageMigrations/withdrawFunnel"
import type { Database } from "./database"
import { persistentStore } from "./persistentStore"

/** Highest withdraw funnel phase already reported per withdrawal `localId`. */
export type ReportedPhases = Record<string, "finalizing_l1" | "done">

/** One withdrawal's reported phase. */
export interface FunnelMark {
  localId: string
  phase: ReportedPhases[string]
}

export interface WithdrawFunnel {
  /**
   * Reads the marks saved for `ids` and saves the ones `decide` returns for them in one write.
   * Resolves, once committed, to what `decide` reports: a phase is reported by one call only.
   */
  report<T>(
    ids: readonly string[],
    decide: (reported: ReportedPhases) => { next: ReportedPhases; events: T[] },
  ): Promise<T[]>
}

export function createWithdrawFunnel({ db }: { db: Database }): WithdrawFunnel {
  const prefix = "acct/withdrawFunnel"
  const store = persistentStore<FunnelMark>(db, {
    prefix,
    version: 1,
    id: (mark) => mark.localId,
    migrate: (from, w) => migrateWithdrawFunnel(from, w, prefix),
    load: "all",
  })
  return {
    async report(ids, decide) {
      await store.ready
      return db.write(async (w) => {
        const reported: ReportedPhases = {}
        for (const id of ids) {
          const mark = await store.get(id, w)
          if (mark) reported[id] = mark.phase
        }
        const { next, events } = decide(reported)
        for (const id of ids) {
          if (next[id] === reported[id]) continue
          if (next[id]) await store.put({ localId: id, phase: next[id] }, w)
          else await store.remove(id, w)
        }
        return events
      })
    },
  }
}
