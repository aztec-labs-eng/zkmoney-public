/**
 * Storage migration: the blob older builds' `RecordStorage` kept for a store, one JSON object of
 * records by key. Remove when no storage migration under this directory carries one.
 */
import type { Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import { encodeRecord } from "../engine/persistentStore"

/**
 * Stages, in `w`, each record `toRecord` makes of the blob at `key`, under `prefix` by `id`. No blob
 * carries nothing. A blob that is not an object of records fails the open, or with `unreadable`
 * "empty" carries nothing; its bytes stay either way.
 * `toRecord` gets each value with its key: undefined skips the value, and a throw fails the open with
 * nothing written, for a store that must not lose one record.
 */
export async function carryRecordBlob<R>(
  w: Write,
  key: string,
  store: { prefix: string; id(record: R): string },
  toRecord: (value: unknown, key: string) => R | undefined,
  unreadable: "fail" | "empty" = "fail",
): Promise<void> {
  const raw = await w.get(key)
  if (raw === undefined) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined // the decode boundary: unreadable text fails below
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (unreadable === "empty") return
    throw new WalletError("unknown", `${key}: the saved records do not parse`)
  }
  for (const [at, value] of Object.entries(parsed)) {
    const record = toRecord(value, at)
    if (record !== undefined) w.put(`${store.prefix}/${store.id(record)}`, encodeRecord(record))
  }
}
