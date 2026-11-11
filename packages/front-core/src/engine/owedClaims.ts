import { migrateOwedClaims } from "../storageMigrations/owedClaims"
import type { Database } from "./database"
import { loadRecords, persistentStore } from "./persistentStore"

/** A link claim's `claimed` analytics event, saved before its burn and sent once the burn mines. */
export interface OwedClaim {
  paylinkId: string
  paylink_ph: string
  flavor: string
  amount_bucket: string
  /** When it was owed, ms. */
  at: number
}

/** An entry whose burn never mined (it failed and was not retried) is forgotten after this. */
export const OWED_CLAIM_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface OwedClaims {
  owe(claim: OwedClaim): Promise<void>
  /**
   * Drops each owed claim whose burn `mined`, or that expired, in one write. Resolves, once
   * committed, to the mined ones: each is returned by one call only, so it is sent at most once.
   */
  settle(mined: (paylinkId: string) => boolean, now: number): Promise<OwedClaim[]>
}

export function createOwedClaims({ db }: { db: Database }): OwedClaims {
  const prefix = "acct/owedClaims"
  const store = persistentStore<OwedClaim>(db, {
    prefix,
    version: 1,
    id: (claim) => claim.paylinkId,
    migrate: (from, w) => migrateOwedClaims(from, w, prefix),
    load: "all",
  })
  return {
    owe: (claim) => store.put(claim),
    async settle(mined, now) {
      const owed = await loadRecords(store.view)
      if (owed.length === 0) return []
      return db.write(async (w) => {
        const sent: OwedClaim[] = []
        for (const { paylinkId } of owed) {
          // Read in this write: a claim another call already settled is gone.
          const claim = await store.get(paylinkId, w)
          if (!claim) continue
          if (mined(paylinkId)) sent.push(claim)
          else if (now - claim.at <= OWED_CLAIM_MAX_AGE_MS) continue
          await store.remove(paylinkId, w)
        }
        return sent
      })
    },
  }
}
