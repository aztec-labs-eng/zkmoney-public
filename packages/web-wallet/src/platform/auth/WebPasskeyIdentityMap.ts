import { withFeePayer, type Database } from "@obsidion/front-core"
import type { AccountKey } from "@obsidion/passkey-web"
import type { FeePayerEntry, RecoveryMetadata } from "@obsidion/sdk"
import { DEVICE_KEYS } from "../storage/deviceKeys"
import { readFromOtherDatabases } from "../storage/walletStorage"
const MAP_VERSION = 1
const MAP_KEY = DEVICE_KEYS.passkeyMap

/**
 * The record as a reader sees it. `userHandle` is the passkey's `user.id`, base64url, from its
 * creation. `securityKey` is the creation driver's verdict, kept apart from `authenticatorType`,
 * which every sign-up record writes as platform. `backupEligible` is the authenticator's flag, from
 * creation or, for a passkey this browser did not create, its first prompt here; false means the
 * passkey lives on one device.
 */
export type StoredRecoveryMetadata = RecoveryMetadata & {
  userHandle?: string
  securityKey?: true
  backupEligible?: boolean
}

/** Where a synced passkey answered a laptop's prompt from: a phone over QR, or this computer. */
export type PasskeyAnswer = "remote" | "local"

/** `usertag` is the claimed tag in the exact form that hashes to the on-chain nameHash. */
type StoredEntry = StoredRecoveryMetadata & {
  rpId: string
  createdAt: number
  usertag?: string
  answered?: PasskeyAnswer
  /** When a session last committed with this passkey here. */
  usedAt?: number
}
type StoredMap = { version: number; entries: Record<string, StoredEntry> }

function parseMap(raw: string | null): StoredMap | undefined {
  try {
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as StoredMap
    return parsed?.entries && typeof parsed.entries === "object" ? parsed : undefined
  } catch {
    return undefined
  }
}

/** The saved map's entries; `map` is the page device's `passkeyMap`. */
const entriesOf = (map: string | null): Record<string, StoredEntry | undefined> =>
  parseMap(map)?.entries ?? {}

/** The map a write starts from: one of another version, or unreadable, starts empty. */
function writable(raw: string | null | undefined): StoredMap {
  const parsed = parseMap(raw ?? null)
  return parsed?.version === MAP_VERSION && !Array.isArray(parsed.entries)
    ? parsed
    : { version: MAP_VERSION, entries: {} }
}

/**
 * Edits the map in one write, alone among `db`'s writes. `stillOwns` is asked inside it: an
 * operation that ended while waiting writes nothing, as does an `edit` that returns false.
 */
function editMap(
  db: Database,
  edit: (map: StoredMap) => boolean | void,
  stillOwns?: () => boolean,
): Promise<void> {
  return db.write(async (w) => {
    const map = writable(await w.get(MAP_KEY))
    if (stillOwns && !stillOwns()) return
    if (edit(map) === false) return
    w.put(MAP_KEY, JSON.stringify(map))
  })
}

/** {@link editMap} on `rpId`'s entry for `credentialId`: no entry, or a false `change`, writes nothing. */
const editEntry = (
  db: Database,
  rpId: string,
  credentialId: string,
  change: (entry: StoredEntry) => StoredEntry | false,
  stillOwns?: () => boolean,
) =>
  editMap(
    db,
    (map) => {
      const entry = map.entries[credentialId]
      const next = entry?.rpId === rpId && change(entry)
      if (!next) return false
      map.entries[credentialId] = next
    },
    stillOwns,
  )

/** Raw 64-byte `x‖y` as lowercase hex without `0x`, the form every key comparison uses. */
const normalKey = (hex: string) => hex.replace(/^0x/i, "").toLowerCase()

/**
 * Whether a record opens the wallet: its PRF derives the master key (a root), or opens an
 * envelope holding it (a backup). A rotated signing credential does neither.
 */
export function opensWallet(record: Pick<RecoveryMetadata, "isMskRoot" | "backup">): boolean {
  return record.isMskRoot || record.backup !== undefined
}

/**
 * Sync probe for route gating: does this device hold a breadcrumb for a passkey that opens a
 * wallet under `rpId`? A breadcrumb only proves a passkey WAS recorded here — deletion at the
 * authenticator is invisible until an assertion fails.
 */
export function hasOpeningBreadcrumb(map: string | null, rpId: string): boolean {
  return Object.values(entriesOf(map)).some((e) => e?.rpId === rpId && opensWallet(e))
}

/** The address of this device's record for `credentialId` under `rpId`, if it holds one. */
export function recordAddress(
  map: string | null,
  rpId: string,
  credentialId: string,
): string | undefined {
  const entry = entriesOf(map)[credentialId]
  return (entry?.rpId === rpId && entry.l2Address) || undefined
}

/** Sync probe: does this device hold a record with an address for `credentialId` under `rpId`? */
export const hasRecordFor = (map: string | null, rpId: string, credentialId: string): boolean =>
  recordAddress(map, rpId, credentialId) !== undefined

/** What the payment screen's passkey advice reads from a record. */
export type AnswerRecord = Pick<
  StoredEntry,
  "answered" | "prfAaguid" | "transports" | "inferredTransports"
>

/**
 * Sync probe: where this credential's passkey answered from, and what is known of its
 * authenticator. Takes no RP: it is asked about the session's own credential, and `answered` is
 * only ever written under the entry's RP.
 */
export function answerRecordFor(
  map: string | null,
  credentialId: string,
): AnswerRecord | undefined {
  return entriesOf(map)[credentialId]
}

/** What the backup reminder reads from a record. */
export type BackupRecord = Pick<
  StoredEntry,
  "backupEligible" | "securityKey" | "backup" | "passkeySet"
>

/** Sync probe: what this browser knows of a credential's backups. No RP, as `answerRecordFor`. */
export function backupRecordFor(
  map: string | null,
  credentialId: string,
): BackupRecord | undefined {
  return entriesOf(map)[credentialId]
}

/**
 * The tag this credential claimed, so /enter can name a recovered claim without
 * asking for it. Only ever a HINT: the caller re-hashes it against the on-chain
 * nameHash, so a stale or absent one costs a manual confirm, never a wrong
 * identity. Absent on a browser that has never held this account (the tag lives
 * on-chain as a hash and nowhere else), which is why /enter keeps the prompt.
 */
export function usertagFor(
  map: string | null,
  rpId: string,
  credentialId: string,
): string | undefined {
  const entry = entriesOf(map)[credentialId]
  return entry?.rpId === rpId ? entry.usertag : undefined
}

/** The handle this credential was created under on this browser; the key a rename needs. */
export function userHandleFor(
  map: string | null,
  rpId: string,
  credentialId: string,
): string | undefined {
  const entry = entriesOf(map)[credentialId]
  return entry?.rpId === rpId ? entry.userHandle : undefined
}

/** What this browser recorded of the authenticator holding the passkey for a pubkey. */
export type AuthenticatorRecord = Pick<
  StoredEntry,
  "prfAaguid" | "authenticatorType" | "securityKey" | "transports" | "inferredTransports" | "usedAt"
>

/** The authenticator this browser recorded for the passkey holding `pubkeyHex`, if it ever held one. */
export function authenticatorFor(
  map: string | null,
  pubkeyHex: string,
): AuthenticatorRecord | undefined {
  const key = normalKey(pubkeyHex)
  return Object.values(entriesOf(map)).find(
    (e) => typeof e?.pubkey === "string" && normalKey(e.pubkey) === key,
  )
}

/** A remembered account for the sign-in screen: a record that opens a wallet and names the tag it claimed. */
export type RememberedAccount = {
  credentialId: string
  /** Raw 64-byte `x‖y` as lowercase hex without `0x`, the candidate form a pinned sign-in takes. */
  pubkeyHex: string
  l2Address: string
  usertag: string
  /** The row's passkey opens the wallet through its envelope, so the screen can label it. */
  backup: boolean
}

/**
 * A key of a wallet's set, with this browser's record that opens the wallet with it, when it holds
 * one, as a sign-in names the key.
 */
export type WalletKey = { pubkeyHex: string; record?: AccountKey }

/**
 * The keys of the set `credentialId`'s record names, in its order. Undefined unless that record
 * opens a wallet under `rpId`. Sync, for the screens that offer a choice among them.
 */
export function walletKeysFor(
  map: string | null,
  rpId: string,
  credentialId: string,
): WalletKey[] | undefined {
  const entries = entriesOf(map)
  const own = entries[credentialId]
  if (!wellFormedUnder(own, rpId) || !opensWallet(own)) return undefined
  const address = own.l2Address.toLowerCase()
  const opening = Object.values(entries).filter(
    (e): e is WellFormedEntry =>
      wellFormedUnder(e, rpId) && opensWallet(e) && e.l2Address.toLowerCase() === address,
  )
  const set = [...new Set((own.passkeySet ?? [own.pubkey]).map(normalKey))]
  return set.map((pubkeyHex) => {
    const e =
      normalKey(own.pubkey) === pubkeyHex
        ? own
        : opening.find((r) => normalKey(r.pubkey) === pubkeyHex)
    return e ? { pubkeyHex, record: accountKeyOf(e) } : { pubkeyHex }
  })
}

/** An entry with the fields a sign-in reads: its credential, its signing key and its address. */
type WellFormedEntry = StoredEntry & { credentialId: string; pubkey: string; l2Address: string }

const wellFormedUnder = (e: StoredEntry | undefined, rpId: string): e is WellFormedEntry =>
  e?.rpId === rpId &&
  typeof e.credentialId === "string" &&
  typeof e.pubkey === "string" &&
  typeof e.l2Address === "string" &&
  Boolean(e.l2Address)

const accountKeyOf = (e: WellFormedEntry): AccountKey => ({
  credentialId: e.credentialId,
  backup: e.backup !== undefined,
  ...(e.prfAaguid ? { aaguid: e.prfAaguid } : {}),
  ...(typeof e.usedAt === "number" ? { usedAt: e.usedAt } : {}),
})

/**
 * Every record under `rpId` that opens a wallet and carries a claimed tag, newest first: the
 * sign-in screen's remembered-account rows. Sync, like the probes above, so the screen renders
 * without a loading frame. No cap — the screen shows five rows and scrolls the rest.
 */
export function listUsertagCandidates(map: string | null, rpId: string): RememberedAccount[] {
  return candidatesIn(parseMap(map), rpId, opensWallet)
}

/**
 * The same rows from this browser's other rollups' databases, roots only: a retired backup's
 * envelope is not in the current map, and a row naming only its credential would send it down the
 * discovery path, where its way in is the tag. A move to a new rollup starts an empty database
 * there, so its accounts are found in the ones before it. Hints only, as on the active rollup:
 * nothing is copied over, and a malformed map lists nothing.
 */
export async function listRetiredUsertagCandidates(rpId: string): Promise<RememberedAccount[]> {
  const maps = await readFromOtherDatabases(MAP_KEY)
  return maps.flatMap((raw) => candidatesIn(parseMap(raw), rpId, (e) => Boolean(e.isMskRoot)))
}

/** A record from another rollup's identity map, with the tag it names as a hint. */
export type RetiredRecord = StoredRecoveryMetadata & { usertag?: string }

/**
 * `credentialId`'s record in a raw identity map from another rollup's database, when it opens a
 * wallet under `rpId` and its key is in its own set.
 */
export function openingRecordIn(
  raw: string | undefined,
  rpId: string,
  credentialId: string,
): RetiredRecord | undefined {
  const entry = parseMap(raw ?? null)?.entries[credentialId]
  if (entry?.rpId !== rpId || !opensWallet(entry) || typeof entry.pubkey !== "string") return
  const set: unknown = entry.passkeySet ?? [entry.pubkey]
  if (!Array.isArray(set) || !set.every((key) => typeof key === "string")) return
  return set.map(normalKey).includes(normalKey(entry.pubkey)) ? entry : undefined
}

const createdAt = (e: StoredEntry) => (typeof e.createdAt === "number" ? e.createdAt : 0)

function candidatesIn(
  map: StoredMap | undefined,
  rpId: string,
  admits: (e: StoredEntry) => boolean,
): RememberedAccount[] {
  return Object.values(map?.entries ?? {})
    .filter(
      (e): e is WellFormedEntry & { usertag: string } =>
        wellFormedUnder(e, rpId) &&
        admits(e) &&
        typeof e.usertag === "string" &&
        Boolean(e.usertag),
    )
    .sort((a, b) => createdAt(b) - createdAt(a))
    .map((e) => ({
      credentialId: e.credentialId,
      pubkeyHex: normalKey(e.pubkey),
      l2Address: e.l2Address,
      usertag: e.usertag,
      backup: e.backup !== undefined,
    }))
}

/** `stillOwns` is asked inside the write: a hint whose sign-in ended while waiting is not written. */
export function rememberUsertag(
  db: Database,
  rpId: string,
  credentialId: string,
  usertag: string,
  stillOwns?: () => boolean,
): Promise<void> {
  return editEntry(
    db,
    rpId,
    credentialId,
    (entry) => entry.usertag !== usertag && { ...entry, usertag },
    stillOwns,
  )
}

/**
 * Recovery-breadcrumb store (`credentialId → RecoveryMetadata`). Browser
 * storage is device-local, so a fresh browser legitimately has no record —
 * callers must handle map-less recovery (pubkey recovery + verify-before-
 * commit) rather than treat absence as an error. Entries are tagged with the
 * RP they were registered under and ignored when read under a different RP.
 */
export class WebPasskeyIdentityMap {
  constructor(private readonly db: Database, private readonly rpId: string) {}

  private async load(): Promise<StoredMap> {
    return writable(await this.db.get(MAP_KEY))
  }

  /**
   * `stillOwns` is asked inside the write: a caller whose operation ended writes nothing. A set
   * that lacks the record's own key is a programming error and is refused before the write. A write
   * without a `backup` drops a stored one; a `backup` write is stored as a non-root.
   */
  async upsert(meta: StoredRecoveryMetadata, stillOwns?: () => boolean): Promise<void> {
    if (meta.passkeySet && !meta.passkeySet.some((k) => normalKey(k) === normalKey(meta.pubkey))) {
      throw new Error("the passkey set does not contain the record's own key")
    }
    await editMap(
      this.db,
      (map) => {
        // Spread the existing entry first: re-recording a credential (every /enter) must not drop
        // the usertag hint written after the claim.
        const stored = map.entries[meta.credentialId]
        const previous = stored?.rpId === this.rpId ? stored : undefined
        // An inference is only ever written by `setInferredTransports`; a stored one survives here.
        // A creation list and the backup flag are written once: a stored one stays, whatever this
        // write carries.
        const {
          inferredTransports: _,
          transports: incoming,
          backupEligible: flag,
          backup: _backup,
          ...record
        } = meta
        const transports = previous?.transports ?? incoming
        const backupEligible = previous?.backupEligible ?? flag
        const { backup: _stored, ...kept } = previous ?? {}
        map.entries[meta.credentialId] = {
          ...kept,
          ...record,
          ...(transports ? { transports } : {}),
          ...(backupEligible !== undefined ? { backupEligible } : {}),
          ...(meta.backup ? { backup: meta.backup, isMskRoot: false } : {}),
          rpId: this.rpId,
          createdAt: Date.now(),
        }
      },
      stillOwns,
    )
  }

  /**
   * Set the transports this browser's assertions implied, on an entry that exists for this RP and
   * carries neither a creation list nor an inference yet; `undefined` removes the inference. Judged
   * inside the write, so a racing creation-list write wins and a queued clear lands before a later
   * set. `stillOwns` is asked there too. Nothing else on the entry changes.
   */
  async setInferredTransports(
    credentialId: string,
    transports: readonly string[] | undefined,
    stillOwns?: () => boolean,
  ): Promise<void> {
    await editEntry(
      this.db,
      this.rpId,
      credentialId,
      ({ inferredTransports, ...entry }) => {
        if (transports)
          return (
            !entry.transports && !inferredTransports && { ...entry, inferredTransports: transports }
          )
        return !!inferredTransports && entry
      },
      stillOwns,
    )
  }

  /**
   * Record where the passkey last answered from, on an entry that exists for this RP. `stillOwns`
   * is asked inside the write, as in `setInferredTransports`.
   */
  async setAnswered(
    credentialId: string,
    where: PasskeyAnswer,
    stillOwns?: () => boolean,
  ): Promise<void> {
    await editEntry(
      this.db,
      this.rpId,
      credentialId,
      (entry) => entry.answered !== where && { ...entry, answered: where },
      stillOwns,
    )
  }

  /**
   * Record the backup flag a prompt reported, on an entry that exists for this RP and carries none
   * yet: the flag never changes for a credential, so the first reading stands.
   */
  async setBackupEligible(
    credentialId: string,
    backupEligible: boolean,
    stillOwns?: () => boolean,
  ): Promise<void> {
    await editEntry(
      this.db,
      this.rpId,
      credentialId,
      (entry) => entry.backupEligible === undefined && { ...entry, backupEligible },
      stillOwns,
    )
  }

  /** Stamp the passkey as the one a session just committed with, on an entry that exists for this RP. */
  async setUsed(credentialId: string): Promise<void> {
    await editEntry(this.db, this.rpId, credentialId, (entry) => ({ ...entry, usedAt: Date.now() }))
  }

  /**
   * Write the fee payer for one ClaimFPC instance on an entry that exists for this RP. Nothing else
   * on the entry changes, so the record keeps its place among the opening records.
   */
  async setFeePayer(credentialId: string, fpc: string, payer: FeePayerEntry): Promise<void> {
    await editEntry(this.db, this.rpId, credentialId, (entry) => ({
      ...entry,
      feePayer: withFeePayer(entry, fpc, payer),
    }))
  }

  async get(credentialId: string): Promise<StoredRecoveryMetadata | undefined> {
    const entry = (await this.load()).entries[credentialId]
    return entry?.rpId === this.rpId ? entry : undefined
  }

  /** The root record of `l2Address` for this RP: the credential whose PRF derives its master key. */
  async getRootRecord(l2Address: string): Promise<StoredRecoveryMetadata | undefined> {
    const wanted = l2Address.toLowerCase()
    return Object.values((await this.load()).entries)
      .filter(
        (entry) =>
          entry?.rpId === this.rpId && entry.isMskRoot && entry.l2Address.toLowerCase() === wanted,
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  /**
   * A record for this RP that opens a wallet: the one that opened `l2Address` when given (none
   * when this browser holds no such record for that account), else the most recently created.
   */
  async getOpeningRecord(l2Address?: string): Promise<RecoveryMetadata | undefined> {
    const wanted = l2Address?.toLowerCase()
    const entries = Object.values((await this.load()).entries)
      .filter((entry) => entry?.rpId === this.rpId && opensWallet(entry))
      .filter((entry) => wanted === undefined || entry.l2Address.toLowerCase() === wanted)
      .sort((a, b) => b.createdAt - a.createdAt)
    return entries[0]
  }

  async discardOtherRps(): Promise<void> {
    await editMap(this.db, (map) => {
      const entries = Object.entries(map.entries)
      const kept = entries.filter(([, entry]) => entry?.rpId === this.rpId)
      if (kept.length === entries.length) return false
      map.entries = Object.fromEntries(kept)
    })
  }

  async clear(): Promise<void> {
    await this.db.write(async (w) => w.remove(MAP_KEY))
  }
}
