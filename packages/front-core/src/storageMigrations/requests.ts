/**
 * Storage migration: older builds' payment requests, from the legacy blob or an older store. Remove
 * when no supported build older than the one that writes `acct/requests` v3 remains.
 */
import { REQUEST_STORAGE_KEY } from "../core/storages/storage-constants"
import type { Database, Reads, Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { decodeRecord, encodeRecord } from "../engine/persistentStore"
import type { RequestStatus, StoredRequest } from "../engine/requests"
import { LEGACY_UNLISTED_KEY } from "./receiveCodes"

type LegacyRequest = Omit<StoredRequest, "status"> & { status: RequestStatus }

/** The legacy blob's rows. A paid row stays paid, with its payment's hash where it had one. */
function legacyRequests(raw: string | null): [string, StoredRequest][] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const rows = (parsed as { requests?: unknown })?.requests
  if (!Array.isArray(rows)) return []
  const out = new Map<string, StoredRequest>()
  for (const legacy of rows as LegacyRequest[]) {
    if (typeof legacy?.id !== "string" || out.has(legacy.id)) continue
    const { fulfillmentTxHash, status, ...row } = legacy
    const paid = status === "fulfilled"
    out.set(row.id, {
      ...row,
      status: paid ? "paid" : status,
      kind: row.kind ?? "contact",
      ...(paid && fulfillmentTxHash ? { fulfillmentTxHash } : {}),
    })
  }
  return [...out]
}

/** Lowercase ids of the Receive codes older builds minted without an amount, kept apart. */
async function legacyUnlisted(legacy: Pick<Reads, "get"> | undefined): Promise<Set<string>> {
  const raw = await legacy?.get(LEGACY_UNLISTED_KEY)
  if (raw === undefined) return new Set()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Set() // the decode boundary: older builds read an unreadable list as none
  }
  return new Set(Array.isArray(parsed) ? parsed.map((id) => String(id).toLowerCase()) : [])
}

function withUnlisted(
  records: [string, StoredRequest][],
  unlisted: ReadonlySet<string>,
): [string, StoredRequest][] {
  return records.map(([id, row]) => [
    id,
    unlisted.has(id.toLowerCase()) ? { ...row, unlisted: true } : row,
  ])
}

export async function migrateRequests(
  from: number | undefined,
  w: Write,
  { db, prefix, legacy }: { db: Database; prefix: string; legacy?: Pick<Reads, "get"> },
): Promise<void> {
  if (from !== undefined && from !== 1 && from !== 2) {
    throw new WalletError("invariant", `requests: unknown version ${from}`)
  }
  const records =
    from === undefined ? legacyRequests((await w.get(REQUEST_STORAGE_KEY)) ?? null) : []
  for (const [key, raw] of await db.range(`${prefix}/`))
    records.push([key.slice(prefix.length + 1), decodeRecord(raw) as StoredRequest])
  // A request paid before the migration had its payer approved when it was paid.
  const approved = records.map(([id, row]): [string, StoredRequest] => [
    id,
    row.status === "paid" ? { ...row, payerApproved: true } : row,
  ])
  for (const [id, row] of withUnlisted(approved, await legacyUnlisted(legacy)))
    w.put(`${prefix}/${id}`, encodeRecord(row))
}
