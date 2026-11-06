import { ACCOUNT_STORAGE_KEY } from "../core/storages/constants"
import type { Database, Reads, Write } from "./database"
import { WalletError } from "./errors"
import type { Sourced } from "./legacyStore"
import { decodeRecord, encodeRecord, loadRecords, persistentStore } from "./persistentStore"
import { ownAddress } from "./registrations"
import { derived, type ReadonlyStore } from "./store"

/** The account this namespace entered: its L2 address, plus its tag once one is claimed. */
export interface WalletIdentity {
  /** Absent until a name is registered: the wallet runs nameless, and tag surfaces ask for one. */
  handle?: string
  address: string
  claimedAt: number
  /** Written while the tag's registration is open, for an older build; this one derives it. */
  pending?: boolean
}

/** `failed` while the store cannot be read: the identity is unknown, never absent. */
export type IdentityView = Sourced<WalletIdentity | null> & { failed: boolean }

/** The namespace's identity, at `acct/identity/current`. Its presence marks a completed entry. */
export interface Identity extends ReadonlyStore<IdentityView> {
  /** Resolves once the view has loaded; rejects when it cannot. */
  readonly ready: Promise<void>
}

/** Where older builds kept the identity. This build reads it once to carry it, and writes it on. */
export const LEGACY_IDENTITY_KEY = "webwallet.identity"
const RECORD = "acct/identity/current"

/**
 * Stages the identity of the namespace under `prefix`, or its removal for null, in `w` on the
 * page's database. The legacy key gets the same change, for a rollback build.
 */
export function stageIdentity(w: Write, prefix: string, identity: WalletIdentity | null): void {
  if (!identity) {
    w.remove(prefix + RECORD)
    return w.remove(LEGACY_IDENTITY_KEY)
  }
  w.put(prefix + RECORD, encodeRecord(identity))
  w.put(LEGACY_IDENTITY_KEY, JSON.stringify(identity))
}

/** The identity saved under `reads`, a namespace's database, read once. */
export async function readIdentity(reads: Pick<Reads, "get">): Promise<WalletIdentity | null> {
  const raw = await reads.get(RECORD)
  return raw === undefined ? null : (decodeRecord(raw) as WalletIdentity)
}

export interface IdentityDeps {
  db: Database
  /** The page's database, which holds the legacy key. */
  legacy: Pick<Reads, "get">
  /** The address the namespace's passkey opened, for a namespace that saved no account. */
  opened(): string | undefined
}

/**
 * Version 1 carries the legacy identity when it is this namespace's: its address is the saved
 * account's, or the passkey's when none is saved. The saved version records that the carry ran, so
 * a later removal stays removed.
 */
export function createIdentity({ db, legacy, opened }: IdentityDeps): Identity {
  const store = persistentStore<WalletIdentity>(db, {
    prefix: "acct/identity",
    version: 1,
    id: () => "current",
    load: "all",
    async migrate(from, w) {
      if (from !== undefined)
        throw new WalletError("invariant", `identity: unknown version ${from}`)
      const carried = decodeIdentity(await legacy.get(LEGACY_IDENTITY_KEY))
      if (!carried || (await w.get(RECORD)) !== undefined) return
      const own = (await ownAddress(await w.get(ACCOUNT_STORAGE_KEY))) ?? opened()?.toLowerCase()
      if (own === carried.address.toLowerCase()) w.put(RECORD, encodeRecord(carried))
    },
  })
  const view = derived([store.view], ({ records, loaded, failed }) => ({
    value: records[0] ?? null,
    loaded,
    failed,
  }))
  return {
    ...view,
    // Made per read, so a load nothing waits for fails only as the view's `failed`.
    get ready() {
      return store.ready.then(async () => void (await loadRecords(store.view)))
    },
  }
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
