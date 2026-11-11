/**
 * Storage migration: the owed link-claim events older builds kept in one blob. Remove when no
 * supported build older than the one that writes `acct/owedClaims` v1 remains.
 */
import type { Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import type { OwedClaim } from "../engine/owedClaims"
import { carryRecordBlob } from "./recordBlob"

export const OWED_CLAIMS_KEY = "analytics.paylinkClaims"

const isStr = (v: unknown): v is string => typeof v === "string"

/** The blob's entry under `paylinkId` as a claim; undefined for one that does not read as one. */
function claimOf(value: unknown, paylinkId: string): OwedClaim | undefined {
  const v = value as Partial<OwedClaim> | null
  if (!v || !isStr(v.paylink_ph) || !isStr(v.flavor) || !isStr(v.amount_bucket)) return undefined
  if (typeof v.at !== "number") return undefined
  return {
    paylinkId,
    paylink_ph: v.paylink_ph,
    flavor: v.flavor,
    amount_bucket: v.amount_bucket,
    at: v.at,
  }
}

/**
 * Version 1 carries every owed claim, so none is sent twice or lost. Older builds read a blob that
 * does not parse as none owed, and so does the carry; an entry that does not read is dropped. The
 * blob stays for one release.
 */
export async function migrateOwedClaims(
  from: number | undefined,
  w: Write,
  prefix: string,
): Promise<void> {
  if (from !== undefined) throw new WalletError("invariant", `owedClaims: unknown version ${from}`)
  await carryRecordBlob(
    w,
    OWED_CLAIMS_KEY,
    { prefix, id: (c: OwedClaim) => c.paylinkId },
    claimOf,
    "empty",
  )
}
