/**
 * Storage migration: older builds' transfer rows, from the legacy blob or the `activity` store.
 * Remove when no supported build older than the one that writes `acct/transfers` v5 remains and
 * the rollup migration (ZKM-1625) reads no legacy rows.
 */
import { parseUnits } from "viem"
import type { PaylinkTransaction, Transaction } from "../types/transactions"
import type { TokenInTxService } from "../types/tokens"
import type { Database, Write } from "../engine/database"
import { WalletError, type Failure } from "../engine/errors"
import { moveLinksOut } from "../engine/paylinks"
import { decodeRecord, encodeRecord } from "../engine/persistentStore"
import { transferTransition } from "../engine/transferTransition"
import { ACCOUNT_STORAGE_KEY, TRANSACTIONS_STORAGE_KEY } from "../core/storages/constants"

/** Where builds before version 5 kept the rows, as the `activity` store at versions 1 to 4. */
export const ACTIVITY = "acct/activity"
const ACTIVITY_VERSION = "acct/meta/activity"

/** The texts older builds stored on a row the tab closed on before it was sent. */
// eslint-disable-next-line no-restricted-syntax -- ZKM-1778
const INTERRUPTED_TEXTS = new Set([
  "This payment was interrupted before it was sent. The amount is still in your balance.",
  "The tab closed before it was sent. The amount is still in your balance.",
  "The tab closed before the link was funded. The amount is still in your balance.",
  "The tab closed before your claim was sent. The link can still be claimed.",
  "The tab closed before it was sent.",
])

type LegacyRow = Omit<Transaction, "id" | "amountAtomic" | "failure"> & {
  queueId?: string
  error?: string
  amountAtomic?: string
}

/**
 * The legacy blob's rows: `TRANSACTIONS_STORAGE_KEY` (one JSON array), or, where no build split it
 * out yet, the account blob's `transactions`. A malformed blob holds none.
 */
export function legacyRows(get: (key: string) => string | null | undefined): object[] {
  const own = get(TRANSACTIONS_STORAGE_KEY)
  const list =
    own === null || own === undefined
      ? (parse(get(ACCOUNT_STORAGE_KEY)) as { transactions?: unknown } | null)?.transactions
      : parse(own)
  return Array.isArray(list) ? list.filter((row) => typeof row === "object" && row !== null) : []
}

function parse(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** One row of a legacy blob, keyed as the store keys it; `index` is its place in the blob. */
export function legacyRow(row: object, index: number): Transaction {
  return convert(row as LegacyRow, index)
}

function convert(legacy: LegacyRow, index: number): Transaction {
  const { queueId, error, amountAtomic, ...row } = legacy
  const operationId = row.operationId ?? queueId
  const txHash = row.txHash ?? ""
  // A key segment holds no "/".
  const id = (
    operationId ?? (txHash ? txHash.toLowerCase() : `legacy-${row.timestamp}-${index}`)
  ).replaceAll("/", "_")
  const token = (row as { token?: TokenInTxService }).token
  const atomic =
    amountAtomic !== undefined
      ? BigInt(amountAtomic)
      : token && !token.hasUnknownAmount
      ? floatToAtomic(token.amount, token.decimals)
      : 0n
  const converted = {
    ...row,
    id,
    txHash,
    ...(operationId ? { operationId } : {}),
    amountAtomic: atomic,
    ...(error ? { failure: failureOf(error) } : {}),
  } as Transaction
  return withFlavor(converted)
}

function failureOf(error: string): Failure {
  return INTERRUPTED_TEXTS.has(error)
    ? { code: "tx.interrupted" }
    : { code: "tx.failed", detail: error }
}

/** The stored display float at the token's decimals: the precision it already had, no less. */
function floatToAtomic(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount)) return 0n
  const text = String(amount)
  try {
    return parseUnits(/e/i.test(text) ? amount.toFixed(decimals) : text, decimals)
  } catch {
    return 0n
  }
}

/** Paylink rows from before `flavor` existed: an email recipient makes it an email link. */
function withFlavor(row: Transaction): Transaction {
  const link = row as PaylinkTransaction
  if (typeof link.emailPaymentAction !== "string" || link.flavor !== undefined) return row
  const email = typeof link.to === "string" && /^[^@\s]+@[^@\s]+$/.test(link.to)
  return { ...link, flavor: email ? "email" : "direct" }
}

/**
 * Moves the rows an `activity` store kept to the transfers store's keys under `prefix`, and drops
 * its index entries and version, in `w`. Returns the version they were migrated to and their ids;
 * none when it never opened.
 */
async function moveActivity(
  db: Database,
  prefix: string,
  w: Write,
): Promise<{ from: number | undefined; ids: string[] }> {
  const [saved, build] = await w.getMany([ACTIVITY_VERSION, `${ACTIVITY_VERSION}.build`])
  // An index build in progress ran its migration already, to the version it builds.
  const at = build === undefined ? saved : String((JSON.parse(build) as { to: number }).to)
  if (at === undefined) return { from: undefined, ids: [] }
  const rows = await db.range(`${ACTIVITY}/`)
  for (const [key, raw] of rows) {
    w.put(`${prefix}${key.slice(ACTIVITY.length)}`, raw)
    w.remove(key)
  }
  for (const [key] of await db.range(`${ACTIVITY}.i/`)) w.remove(key)
  w.remove(ACTIVITY_VERSION)
  w.remove(`${ACTIVITY_VERSION}.build`)
  return { from: Number(at), ids: rows.map(([key]) => key.slice(ACTIVITY.length + 1)) }
}

/**
 * Takes over an `activity` store's rows, or imports the legacy blob's on the first open, rows saved
 * under the store winning, and moves every created link out to `paylinks`. The blob is never
 * edited. An own row an older build left pending with no hash was never sent, and fails as
 * interrupted: nothing sends it now.
 */
export async function migrateTransfers(
  saved: number | undefined,
  w: Write,
  { db, prefix }: { db: Database; prefix: string },
): Promise<void> {
  if (saved !== undefined) throw new WalletError("invariant", `transfers: unknown version ${saved}`)
  const moved = await moveActivity(db, prefix, w)
  const { from } = moved
  if (from !== undefined && from !== 1 && from !== 2 && from !== 3 && from !== 4)
    throw new WalletError("invariant", `activity: unknown version ${from}`)
  const ids = new Set(moved.ids)
  for (const [key] of await db.range(`${prefix}/`)) ids.add(key.slice(prefix.length + 1))
  if (from === undefined) {
    const [own, account] = await w.getMany([TRANSACTIONS_STORAGE_KEY, ACCOUNT_STORAGE_KEY])
    const legacy = new Map<string, string | undefined>([
      [TRANSACTIONS_STORAGE_KEY, own],
      [ACCOUNT_STORAGE_KEY, account],
    ])
    const rows = new Map<string, Transaction>()
    legacyRows((key) => legacy.get(key)).forEach((row, i) => {
      const converted = legacyRow(row, i)
      rows.set(converted.id, converted)
    })
    const fresh = [...rows.keys()]
    const saved = await w.getMany(fresh.map((id) => `${prefix}/${id}`))
    fresh.forEach((id, i) => {
      if (saved[i] !== undefined) return
      w.put(`${prefix}/${id}`, encodeRecord(rows.get(id)))
      ids.add(id)
    })
  }
  await moveLinksOut(w, [...ids])
  const keys = [...ids].map((id) => `${prefix}/${id}`)
  const rows = await w.getMany(keys)
  rows.forEach((raw, i) => {
    const row = raw === undefined ? undefined : (decodeRecord(raw) as Transaction)
    const next = row?.operationId && !row.txHash && transferTransition(row, { type: "interrupted" })
    if (next) w.put(keys[i], encodeRecord(next))
  })
}
