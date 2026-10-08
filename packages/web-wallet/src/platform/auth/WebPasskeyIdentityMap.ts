import type { IStorageAdapter } from "@obsidion/front-core"
import type { RecoveryMetadata } from "@obsidion/sdk"
import {
  PASSKEY_IDENTITY_MAP_KEY as STORAGE_KEY,
  WEB_STORAGE_PREFIX,
} from "../storage/WebStorageAdapter"
import { walletStorage } from "../storage/walletStorage"
import { withWebLock } from "../storage/webLock"
const MAP_VERSION = 1
const LOCK_NAME = "webwallet.passkey-identity-map"

/** Every mutation of the map runs under one lock, so two tabs cannot erase each other's writes. */
const withMapLock = <T>(fn: () => Promise<T>) => withWebLock(LOCK_NAME, fn)

/** The record as a reader sees it. */
export type StoredRecoveryMetadata = RecoveryMetadata

/** `usertag` is the claimed tag in the exact form that hashes to the on-chain nameHash. */
type StoredEntry = StoredRecoveryMetadata & { rpId: string; createdAt: number; usertag?: string }
type StoredMap = { version: number; entries: Record<string, StoredEntry> }

function readMap(): StoredMap | undefined {
  try {
    const raw = walletStorage.getItem(WEB_STORAGE_PREFIX + STORAGE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as StoredMap
    return parsed.entries ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Sync probe for route gating: does this device hold an MSK-root passkey
 * breadcrumb for `rpId`? Reads the partition directly (the adapter is async but
 * backed by the same store) so the router can gate without a loading frame. A
 * breadcrumb only proves a passkey WAS created here — deletion at the
 * authenticator is invisible until an assertion fails.
 */
export function hasMskRootBreadcrumb(rpId: string): boolean {
  return Object.values(readMap()?.entries ?? {}).some((e) => e?.rpId === rpId && e.isMskRoot)
}

/** Sync probe: does this device hold a record with an address for `credentialId` under `rpId`? */
export function hasRecordFor(rpId: string, credentialId: string): boolean {
  const entry = readMap()?.entries[credentialId]
  return entry?.rpId === rpId && Boolean(entry.l2Address)
}

/**
 * The tag this credential claimed, so /enter can name a recovered claim without
 * asking for it. Only ever a HINT: the caller re-hashes it against the on-chain
 * nameHash, so a stale or absent one costs a manual confirm, never a wrong
 * identity. Absent on a browser that has never held this account (the tag lives
 * on-chain as a hash and nowhere else), which is why /enter keeps the prompt.
 */
export function usertagFor(rpId: string, credentialId: string): string | undefined {
  const entry = readMap()?.entries[credentialId]
  return entry?.rpId === rpId ? entry.usertag : undefined
}

/** A remembered account for the sign-in screen: a root record that names the tag it claimed. */
export type RememberedAccount = {
  credentialId: string
  /** Raw 64-byte `x‖y` as lowercase hex without `0x`, the candidate form a pinned sign-in takes. */
  pubkeyHex: string
  l2Address: string
  usertag: string
}

/**
 * Every root record under `rpId` that carries a claimed tag, newest first: the sign-in screen's
 * remembered-account rows. Sync, like the probes above, so the screen renders without a loading
 * frame. No cap — the screen shows five rows and scrolls the rest.
 */
export function listUsertagCandidates(rpId: string): RememberedAccount[] {
  return Object.values(readMap()?.entries ?? {})
    .filter(
      (e): e is StoredEntry & { usertag: string; l2Address: string } =>
        e?.rpId === rpId &&
        Boolean(e.isMskRoot) &&
        Boolean(e.usertag) &&
        Boolean(e.l2Address) &&
        typeof e.pubkey === "string",
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((e) => ({
      credentialId: e.credentialId,
      pubkeyHex: e.pubkey.toLowerCase().replace(/^0x/, ""),
      l2Address: e.l2Address,
      usertag: e.usertag,
    }))
}

/** `stillOwns` is asked under the lock: a hint whose sign-in ended while waiting is not written. */
export function rememberUsertag(
  rpId: string,
  credentialId: string,
  usertag: string,
  stillOwns?: () => boolean,
): Promise<void> {
  return withMapLock(async () => {
    if (stillOwns && !stillOwns()) return
    const map = readMap()
    const entry = map?.entries[credentialId]
    if (!map || entry?.rpId !== rpId || entry.usertag === usertag) return
    map.entries[credentialId] = { ...entry, usertag }
    await walletStorage.commitItem(WEB_STORAGE_PREFIX + STORAGE_KEY, JSON.stringify(map))
  })
}

/**
 * Recovery-breadcrumb store (`credentialId → RecoveryMetadata`). Browser
 * storage is device-local, so a fresh browser legitimately has no record —
 * callers must handle map-less recovery (pubkey recovery + verify-before-
 * commit) rather than treat absence as an error. Entries are tagged with the
 * RP they were registered under and ignored when read under a different RP.
 */
export class WebPasskeyIdentityMap {
  constructor(private readonly storage: IStorageAdapter, private readonly rpId: string) {}

  private async load(): Promise<StoredMap> {
    try {
      const raw = await this.storage.getItem(STORAGE_KEY)
      if (!raw) return { version: MAP_VERSION, entries: {} }
      const parsed = JSON.parse(raw) as StoredMap
      if (
        parsed.version !== MAP_VERSION ||
        !parsed.entries ||
        typeof parsed.entries !== "object" ||
        Array.isArray(parsed.entries)
      ) {
        return { version: MAP_VERSION, entries: {} }
      }
      return parsed
    } catch {
      return { version: MAP_VERSION, entries: {} }
    }
  }

  /** `stillOwns` is asked under the lock, before the write: a caller whose operation ended writes nothing. */
  async upsert(meta: RecoveryMetadata, stillOwns?: () => boolean): Promise<void> {
    await withMapLock(async () => {
      if (stillOwns && !stillOwns()) return
      const map = await this.load()
      if (stillOwns && !stillOwns()) return
      // Spread the existing entry first: re-recording a credential (every /enter) must not drop
      // the usertag hint written after the claim.
      const stored = map.entries[meta.credentialId]
      const previous = stored?.rpId === this.rpId ? stored : undefined
      // An inference is only ever written by `setInferredTransports`; a stored one survives here.
      // A creation list is written once: a stored one stays, whatever this write carries.
      const { inferredTransports: _, transports: incoming, ...record } = meta
      const transports = previous?.transports ?? incoming
      map.entries[meta.credentialId] = {
        ...previous,
        ...record,
        ...(transports ? { transports } : {}),
        rpId: this.rpId,
        createdAt: Date.now(),
      }
      await this.storage.setItem(STORAGE_KEY, JSON.stringify(map))
    })
  }

  /**
   * Set the transports this browser's assertions implied, on an entry that exists for this RP and
   * carries neither a creation list nor an inference yet; `undefined` removes the inference. Judged
   * under the lock, so a racing creation-list write wins and a queued clear lands before a later
   * set. `stillOwns` is asked under the lock too: an attempt that ended while waiting writes nothing.
   * Nothing else on the entry changes.
   */
  async setInferredTransports(
    credentialId: string,
    transports: readonly string[] | undefined,
    stillOwns?: () => boolean,
  ): Promise<void> {
    await withMapLock(async () => {
      if (stillOwns && !stillOwns()) return
      const map = await this.load()
      if (stillOwns && !stillOwns()) return
      const entry = map.entries[credentialId]
      if (entry?.rpId !== this.rpId) return
      if (transports) {
        if (entry.transports || entry.inferredTransports) return
        map.entries[credentialId] = { ...entry, inferredTransports: transports }
      } else {
        if (!entry.inferredTransports) return
        const { inferredTransports: _, ...rest } = entry
        map.entries[credentialId] = rest
      }
      await this.storage.setItem(STORAGE_KEY, JSON.stringify(map))
    })
  }

  async get(credentialId: string): Promise<StoredRecoveryMetadata | undefined> {
    const entry = (await this.load()).entries[credentialId]
    return entry?.rpId === this.rpId ? entry : undefined
  }

  /**
   * The MSK-root credential for this RP: the one that opened `l2Address` when given (none when this
   * browser holds no root for that account), else the most recently created.
   */
  async getMskRoot(l2Address?: string): Promise<RecoveryMetadata | undefined> {
    const wanted = l2Address?.toLowerCase()
    const entries = Object.values((await this.load()).entries)
      .filter((entry) => entry?.rpId === this.rpId && entry.isMskRoot)
      .filter((entry) => wanted === undefined || entry.l2Address.toLowerCase() === wanted)
      .sort((a, b) => b.createdAt - a.createdAt)
    return entries[0]
  }

  async discardOtherRps(): Promise<void> {
    await withMapLock(async () => {
      const map = await this.load()
      const entries = Object.fromEntries(
        Object.entries(map.entries).filter(([, entry]) => entry?.rpId === this.rpId),
      )
      if (Object.keys(entries).length !== Object.keys(map.entries).length) {
        await this.storage.setItem(STORAGE_KEY, JSON.stringify({ ...map, entries }))
      }
    })
  }

  async clear(): Promise<void> {
    await withMapLock(() => this.storage.removeItem(STORAGE_KEY))
  }
}
