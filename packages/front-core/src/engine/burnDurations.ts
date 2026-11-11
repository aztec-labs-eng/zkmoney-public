import { migrateBurnDurations } from "../storageMigrations/burnDurations"
import type { Database } from "./database"
import { persistentStore } from "./persistentStore"

/** How long this device's recent burns took from confirm to mined, seconds, oldest first. */
export interface BurnDurationSamples {
  id: typeof SAMPLES
  seconds: number[]
}

const SAMPLES = "samples"
const MAX_SAMPLES = 10

export interface BurnDurations {
  /** Keeps a burn's duration, with the latest samples only. */
  add(seconds: number): Promise<void>
  samples(): Promise<number[]>
}

export function createBurnDurations({ db }: { db: Database }): BurnDurations {
  const prefix = "acct/burnDurations"
  const store = persistentStore<BurnDurationSamples>(db, {
    prefix,
    version: 1,
    id: (record) => record.id,
    migrate: (from, w) => migrateBurnDurations(from, w, `${prefix}/${SAMPLES}`),
    load: "all",
  })
  return {
    async add(seconds) {
      await store.apply(SAMPLES, (current) => ({
        id: SAMPLES,
        seconds: [...(current?.seconds ?? []), seconds].slice(-MAX_SAMPLES),
      }))
    },
    samples: async () => (await store.get(SAMPLES))?.seconds ?? [],
  }
}
