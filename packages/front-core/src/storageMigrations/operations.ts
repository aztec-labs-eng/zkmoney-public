/**
 * Storage migration: older builds' operations, from the page-wide blob or a version 1 store. Remove
 * when no supported build older than the one that writes `acct/operations` v2 remains.
 */
import type { Database, Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import type { OperationRecord } from "../engine/operationTransition"
import { decodeRecord, encodeRecord } from "../engine/persistentStore"

/** The page-wide blob older builds kept every namespace's operations in, each with its `scope`. */
export const OPERATIONS_STORAGE_KEY = "@obsidion/operations"

// eslint-disable-next-line no-restricted-syntax -- debt
const STATES = new Set<unknown>(["local", "sent", "settled", "failed"])

/** Each field a shipped record holds, and the type it holds it as; `scope` may also be null. */
const FIELDS: Record<string, { type: string; required?: true }> = {
  operationId: { type: "string", required: true },
  flow: { type: "string", required: true },
  summary: { type: "string", required: true },
  startedAt: { type: "number", required: true },
  scope: { type: "string" },
  parent: { type: "string" },
  resumable: { type: "boolean" },
  background: { type: "boolean" },
  provingStartedAt: { type: "number" },
  handedOffAt: { type: "number" },
  txHash: { type: "string" },
  error: { type: "string" },
  cause: { type: "string" },
  endedAt: { type: "number" },
  readAt: { type: "number" },
  dismissedAt: { type: "number" },
}

const isShipped = (r: Record<string, unknown>) =>
  STATES.has(r.state) &&
  (r.cause === undefined || r.cause === "interrupted" || r.cause === "dropped") &&
  Object.entries(FIELDS).every(([key, { type, required }]) =>
    r[key] === undefined || (key === "scope" && r[key] === null)
      ? !required
      : typeof r[key] === type,
  )

const unreadable = (detail: string) => new WalletError("unknown", `operations: ${detail}`)

/**
 * The records one namespace held in the legacy blob, without their scope. A blob or record that
 * does not parse fails the open and keeps its bytes.
 */
function legacyOperations(raw: string | undefined, scope: string | null): OperationRecord[] {
  if (raw === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw unreadable("the saved operations do not parse")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw unreadable("the saved operations are not a record map")
  return Object.values(parsed as Record<string, unknown>).flatMap((value) => {
    if (!value || typeof value !== "object" || !isShipped(value as Record<string, unknown>))
      throw unreadable("a saved operation is not one")
    const r = value as OperationRecord & { scope?: string | null }
    if ((r.scope ?? null) !== scope) return []
    const record: OperationRecord & { scope?: string | null } = { ...r }
    delete record.scope
    return [record]
  })
}

/**
 * The namespace's legacy records. A `local` one whose transfer row or burn holds a hash was sent:
 * older builds saved the hash there first and reported it to the operation after.
 */
async function carried(
  db: Pick<Database, "range">,
  w: Pick<Write, "get">,
  records: readonly OperationRecord[],
): Promise<OperationRecord[]> {
  const burns = new Map(
    (await db.range("acct/withdrawals/")).flatMap(([, raw]) => {
      const burn = decodeRecord(raw) as { operationId?: string; l2TxHash?: string }
      return burn.operationId && burn.l2TxHash ? [[burn.operationId, burn.l2TxHash] as const] : []
    }),
  )
  return Promise.all(
    records.map(async (r) => {
      if (r.state !== "local") return r
      const raw = await w.get(`acct/transfers/${r.operationId}`)
      const row = raw === undefined ? undefined : (decodeRecord(raw) as { txHash?: string })
      const txHash = row?.txHash || burns.get(r.operationId)
      return txHash ? { ...r, state: "sent" as const, txHash } : r
    }),
  )
}

/**
 * Version 1 carries the namespace's records out of the page-wide blob: the chain cannot say a
 * transaction this page started, nor whether the user read its ending. Version 2 carries the hashes
 * builds of version 1 saved only on a row or burn.
 */
export async function migrateOperations(
  from: number | undefined,
  w: Write,
  {
    db,
    prefix,
    legacy,
  }: { db: Database; prefix: string; legacy?: { db: Pick<Database, "get">; scope: string | null } },
): Promise<void> {
  if (from === 1) {
    const saved = (await db.range(`${prefix}/`)).map(
      ([, raw]) => decodeRecord(raw) as OperationRecord,
    )
    const next = await carried(db, w, saved)
    next.forEach((record, i) => {
      if (record !== saved[i]) w.put(`${prefix}/${record.operationId}`, encodeRecord(record))
    })
    return
  }
  if (from !== undefined) throw new WalletError("invariant", `operations: unknown version ${from}`)
  if (!legacy) return
  const raw = await legacy.db.get(OPERATIONS_STORAGE_KEY)
  for (const record of await carried(db, w, legacyOperations(raw, legacy.scope)))
    w.put(`${prefix}/${record.operationId}`, encodeRecord(record))
}
