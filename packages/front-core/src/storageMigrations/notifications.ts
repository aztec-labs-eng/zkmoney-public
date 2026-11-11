/**
 * Storage migration: the bell's state and facts, from the legacy blob or the two stores before
 * `acct/notifications`. Remove when no supported build older than the one that writes
 * `acct/notifications` v1 remains.
 */
import type { Database, Write } from "../engine/database"
import { WalletError } from "../engine/errors"
import type {
  NotificationEvent,
  NotificationRecord,
  NotificationState,
  UpgradeStop,
} from "../engine/notifications"
import { decodeRecord, encodeRecord } from "../engine/persistentStore"

/** The legacy bell: one JSON object of entries keyed by id, English text included. */
export const APP_NOTIFICATION_STORAGE_KEY = "@obsidion/app-notifications/records"

interface LegacyEntry {
  id: string
  title?: string
  description?: string
  timestampMs: number
  read?: boolean
  readAt?: number
  dismissedAt?: number
  target?: { type?: string; txHash?: string; contactId?: string }
}

/** The fixed sentences older builds stored, which name what an id alone does not. */
const REORG_INCOMING = "This payment to you was reverted by the network and did not complete"
const REORG_OUTGOING = "Your transaction was reverted by the network and did not complete"
const RESUMED = "Withdrawal resumed"
const CONFIRMED = "Payment confirmed"
const STOPS: Record<string, UpgradeStop> = {
  "We couldn't check your old funds. Open it to try again.": "failed",
  "Your upgrade needs another approval. Open it to continue.": "needsApproval",
  "Your upgrade stopped. Open it to see why and continue.": "needsAttention",
  "Your upgrade is paused. Open it to continue.": "paused",
}

function entries(raw: string | undefined): LegacyEntry[] {
  if (raw === undefined) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return []
    return Object.values(parsed as Record<string, LegacyEntry>).filter(
      (e) => typeof e?.id === "string" && typeof e.timestampMs === "number",
    )
  } catch {
    return []
  }
}

export function legacyNotificationState(raw: string | undefined): [string, NotificationState][] {
  return entries(raw).map((e) => {
    const readAt = e.read || e.dismissedAt !== undefined ? e.readAt ?? e.timestampMs : undefined
    const row: NotificationState = { id: e.id, firstSeenAt: e.timestampMs }
    if (readAt !== undefined) row.readAt = readAt
    if (e.dismissedAt !== undefined) row.dismissedAt = e.dismissedAt
    return [e.id, row]
  })
}

/** The entries whose facts no record holds. One whose data cannot be rebuilt keeps its state only. */
export function legacyNotificationEvents(raw: string | undefined): [string, NotificationEvent][] {
  return entries(raw).flatMap((e): [string, NotificationEvent][] => {
    const event = eventOf(e)
    return event ? [[e.id, event]] : []
  })
}

function eventOf(e: LegacyEntry): NotificationEvent | undefined {
  const [kind, sub, key] = e.id.split(":")
  const at = e.timestampMs
  const id = e.id
  const txHash = e.target?.txHash ?? key
  if (kind === "reorg" && sub === "failed") {
    const incoming = e.description === REORG_INCOMING
    if (!incoming && e.description !== REORG_OUTGOING) return undefined
    return { id, at, kind: "reorg", data: { outcome: "failed", txHash, incoming } }
  }
  if (kind === "reorg" && sub === "reconfirmed") {
    if (e.title !== RESUMED && e.title !== CONFIRMED) return undefined
    return {
      id,
      at,
      kind: "reorg",
      data: { outcome: "reconfirmed", txHash, withdrawal: e.title === RESUMED },
    }
  }
  if (kind === "contact" && sub === "added" && key && e.target?.contactId) {
    const contactId = e.target.contactId
    const tag = contactId.toLowerCase() === key ? undefined : contactId
    return { id, at, kind: "contactAdded", data: { address: key, contactId, ...(tag && { tag }) } }
  }
  if (kind === "paylink" && sub === "claim-reversed" && key) {
    return { id, at, kind: "claimReversed", data: { txHash } }
  }
  if (kind === "paylink" && sub === "reclaimable" && key) {
    return { id, at, kind: "reclaimable", data: { txHash } }
  }
  if (id === "migration:run") {
    const stop = STOPS[e.description ?? ""]
    return stop ? { id, at, kind: "migrationRun", data: { stop } } : undefined
  }
  return undefined
}

/** Where the two stores of the previous version kept their records. */
const STATE_PREFIX = "acct/notificationState/"
const EVENTS_PREFIX = "acct/notificationEvents/"

/** Imports the previous version's two stores, or, before them, the legacy blob; they stay as they were. */
export async function migrateNotifications(
  from: number | undefined,
  w: Write,
  { db, prefix }: { db: Database; prefix: string },
): Promise<void> {
  if (from !== undefined)
    throw new WalletError("invariant", `notifications: unknown version ${from}`)
  const [stateVersion, eventsVersion, blob] = await w.getMany([
    "acct/meta/notificationState",
    "acct/meta/notificationEvents",
    APP_NOTIFICATION_STORAGE_KEY,
  ])
  const records = new Map<string, NotificationRecord>()
  const at = (id: string) => records.get(id) ?? { id }
  const states = stateVersion === undefined ? legacyNotificationState(blob) : []
  const events = eventsVersion === undefined ? legacyNotificationEvents(blob) : []
  for (const [key, raw] of await db.range(STATE_PREFIX))
    states.push([key.slice(STATE_PREFIX.length), decodeRecord(raw) as NotificationState])
  for (const [key, raw] of await db.range(EVENTS_PREFIX))
    events.push([key.slice(EVENTS_PREFIX.length), decodeRecord(raw) as NotificationEvent])
  for (const [id, state] of states) records.set(id, { ...at(id), state })
  for (const [id, event] of events) records.set(id, { ...at(id), event })
  for (const [id, record] of records) {
    if (!id.includes("/")) w.put(`${prefix}/${id}`, encodeRecord(record))
  }
}
