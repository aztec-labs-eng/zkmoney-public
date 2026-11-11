/**
 * Storage migration: the identity older builds kept under `LEGACY_IDENTITY_KEY`. Remove when no
 * supported build older than the one that writes `acct/identity` v1 remains.
 */
import { ACCOUNT_STORAGE_KEY } from "../core/storages/constants"
import type { Reads, Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import type { WalletIdentity } from "../engine/identity"
import { encodeRecord } from "../engine/persistentStore"
import { ownAddress } from "./registrations"

/** Where older builds kept the identity. This build reads it once to carry it, and writes it on. */
export const LEGACY_IDENTITY_KEY = "webwallet.identity"

/**
 * Version 1 carries the legacy identity when it is this namespace's: its address is the saved
 * account's, or the passkey's when none is saved. The saved version records that the carry ran, so
 * a later removal stays removed.
 */
export async function migrateIdentity(
  from: number | undefined,
  w: Write,
  {
    legacy,
    opened,
    record,
  }: { legacy: Pick<Reads, "get">; opened: () => string | undefined; record: string },
): Promise<void> {
  if (from !== undefined) throw new WalletError("invariant", `identity: unknown version ${from}`)
  const carried = decodeIdentity(await legacy.get(LEGACY_IDENTITY_KEY))
  if (!carried || (await w.get(record)) !== undefined) return
  const own = (await ownAddress(await w.get(ACCOUNT_STORAGE_KEY))) ?? opened()?.toLowerCase()
  if (own === carried.address.toLowerCase()) w.put(record, encodeRecord(carried))
}

/** The legacy record as older builds read it: one that does not parse is none. */
function decodeIdentity(raw: string | undefined): WalletIdentity | null {
  try {
    if (!raw) return null
    const parsed = JSON.parse(raw) as WalletIdentity
    if (typeof parsed.address !== "string") return null
    if (parsed.handle !== undefined && typeof parsed.handle !== "string") return null
    return parsed
  } catch {
    return null
  }
}
