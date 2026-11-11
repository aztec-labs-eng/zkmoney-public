/**
 * Storage migration: the balance reads older builds kept in one `RecordStorage` blob. A blob that
 * does not parse opens empty and keeps its bytes: the sync and the migration check write the reads
 * again. Remove when no supported build older than the one that writes `acct/balances` v1 remains.
 */
import type { Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { carryRecordBlob } from "./recordBlob"
import type { BalanceEntry } from "../engine/balances"

export const BALANCE_RECORDS_KEY = "@obsidion/balances/records"

const optional = (value: unknown) => (typeof value === "number" ? value : undefined)

/** A saved read whose amount parses; older builds' readers skipped any other. */
function entryOf(value: unknown): BalanceEntry | undefined {
  if (!value || typeof value !== "object") return undefined
  const r = value as Record<string, unknown>
  if (typeof r.scope !== "string" || typeof r.tokenAddress !== "string") return undefined
  let atomic: bigint
  try {
    atomic = BigInt(r.balance as string)
  } catch {
    return undefined // the decode boundary: an amount that does not parse is skipped
  }
  const updatedAt = optional(r.updatedAt)
  return {
    scope: r.scope,
    token: r.tokenAddress,
    atomic,
    anchor: optional(r.anchorBlock),
    readAt: optional(r.readAt) ?? updatedAt,
    updatedAt,
  }
}

/**
 * Version 1 carries the blob's reads. The chain gives the live balance back, but not the old-version
 * figures the rollup migration recorded once and marks read. The blob stays for one release.
 */
export async function migrateBalances(
  from: number | undefined,
  w: Write,
  store: { prefix: string; id(entry: BalanceEntry): string },
): Promise<void> {
  if (from !== undefined) throw new WalletError("invariant", `balances: unknown version ${from}`)
  await carryRecordBlob(w, BALANCE_RECORDS_KEY, store, entryOf, "empty")
}
