import { persistentStore } from "./persistentStore"
import type { KvStore } from "./kv"
import { legacyNotificationEvents, legacyNotificationState } from "./notificationsLegacy"
import type { ReadonlyStore } from "./store"

/** How long after its record settles an entry still rings when first seen; older ones never show. */
export const NOTIFICATION_WINDOW_MS = 24 * 60 * 60 * 1000

/** State rows past which the oldest read rows that nothing lists any more are dropped. */
export const NOTIFICATION_LIMIT = 200

/** What the user did with a bell entry. An entry is listed only once it has a row here. */
export interface NotificationState {
  id: string
  firstSeenAt: number
  readAt?: number
  dismissedAt?: number
}

/** One kind of funds left on a retired version. Amounts in base units at the default decimals. */
export type ResidualItem =
  | { kind: "balance"; amount: bigint; stranded: "small" | "frozen" }
  | { kind: "other"; amount: bigint }
  /** A waiting source's balance, when it has one, and its unclaimed deposits, which wait with it. */
  | { kind: "awaiting" | "awaitingFeature"; amount?: bigint; deposits: number }
  | {
      kind: "unclaimed" | "transit" | "waiting" | "link" | "unverified"
      count: number
      amount?: bigint
    }
  /** `until`: the latest claim window's end, unix seconds. */
  | { kind: "locked"; count: number; amount?: bigint; until: number }

/** Why a stopped upgrade waits for the user. */
export type UpgradeStop = "failed" | "needsApproval" | "needsAttention" | "paused"

/** A fact the bell reports that no record holds. */
export type NotificationEvent = { id: string; at: number } & (
  | {
      kind: "reorg"
      data: {
        outcome: "failed" | "reconfirmed"
        txHash: string
        incoming?: boolean
        withdrawal?: boolean
      }
    }
  | { kind: "contactAdded"; data: { address: string; contactId: string; tag?: string } }
  | { kind: "claimReversed"; data: { txHash: string } }
  | { kind: "reclaimable"; data: { txHash: string } }
  | { kind: "migrationResiduals"; data: { items: ResidualItem[] } }
  | { kind: "migrationRun"; data: { stop: UpgradeStop } }
)

/** An entry the writer sees, as `deriveNotifications` lists it. */
export interface Stampable {
  id: string
  pending?: boolean
  /** When its record settled. Unset: it rings whenever first seen. */
  settledAt?: number
  /** It rings whatever its age once this id has been seen. */
  seenWith?: string
}

/** Whether the writer never stamps `entry`: it settled before the window, and was not seen live. */
export const isOld = (entry: Stampable, known: (id: string) => boolean, now: number) =>
  entry.settledAt !== undefined &&
  entry.settledAt < now - NOTIFICATION_WINDOW_MS &&
  !(entry.seenWith && known(entry.seenWith))

/** Everything stored under one bell id. Neither part: the id is unknown, and rings when listed. */
export interface NotificationRecord {
  id: string
  state?: NotificationState
  event?: NotificationEvent
}

/** What happens to a bell id. `listed`: the records list it now. */
export type NotificationChange =
  /** The records list it. `old`: it settled before the window, so it never rings. */
  | { type: "listed"; at: number; old: boolean }
  | { type: "read"; at: number }
  | { type: "dismissed"; at: number }
  /** A fact reported once. */
  | { type: "recorded"; event: NotificationEvent }
  /** The latest word on a fact. */
  | { type: "reported"; event: NotificationEvent }
  /** The fact no longer holds. */
  | { type: "retracted" }
  /** A failure its record recovered from. */
  | { type: "retired"; listed: boolean }
  /** Past the limit. */
  | { type: "capped"; listed: boolean }

/** Equal for equal event data, bigints included. */
export const dataKey = (data: unknown) =>
  JSON.stringify(data, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v))
const sameData = (a: unknown, b: unknown) => dataKey(a) === dataKey(b)

/**
 * A new fact and its first state row are one write. A fact reaching a row carried over without one
 * keeps the row's time.
 */
const arrived = (id: string, event: NotificationEvent, state?: NotificationState) =>
  state
    ? { id, state, event: { ...event, at: state.firstSeenAt } }
    : { id, state: { id, firstSeenAt: event.at }, event }

/**
 * The one place a bell id changes; `undefined` leaves it as it is.
 * - An id rings only by gaining a state row, and gains one only when listed with none, unless old.
 * - A known id is forgotten only when retracted, or when nothing lists it and it is retired or,
 *   read, capped. So an id that is still listed or still reported never rings twice.
 * - A fact rings as it arrives: its event and its first state row save together.
 * - A recorded fact keeps its first word. A reported one takes a changed word, which brings a
 *   dismissed entry back, still read. A row carried over without a word has none to compare, so
 *   any word is a changed one.
 */
export function notificationTransition(
  record: NotificationRecord,
  change: NotificationChange,
): NotificationRecord | undefined {
  const { id, state, event } = record
  switch (change.type) {
    case "listed":
      if (state || change.old) return undefined
      return { ...record, state: { id, firstSeenAt: change.at } }
    case "read":
      if (!state || state.readAt !== undefined) return undefined
      return { ...record, state: { ...state, readAt: change.at } }
    case "dismissed":
      if (!state || state.dismissedAt !== undefined) return undefined
      return {
        ...record,
        state: { ...state, readAt: state.readAt ?? change.at, dismissedAt: change.at },
      }
    case "recorded":
      if (event) return undefined
      return arrived(id, change.event, state)
    case "reported": {
      if (event && sameData(event.data, change.event.data)) return undefined
      if (state?.dismissedAt === undefined) {
        return event ? { ...record, event: change.event } : arrived(id, change.event, state)
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { dismissedAt, ...shown } = state
      return event ? { id, state: shown, event: change.event } : arrived(id, change.event, shown)
    }
    case "retracted":
      return state || event ? { id } : undefined
    case "retired":
      return state && !change.listed ? { id } : undefined
    case "capped":
      return state?.readAt !== undefined && !change.listed ? { id } : undefined
  }
}

/**
 * The bell's stored state. Every write goes through `notificationTransition` and saves in one
 * transaction, which resolves once durable; `state` and `events` hold only what has landed.
 */
export interface Notifications {
  readonly state: ReadonlyStore<ReadonlyMap<string, NotificationState>>
  readonly events: ReadonlyStore<ReadonlyMap<string, NotificationEvent>>
  readonly ready: Promise<void>
  /** The fact under this id is saved. */
  has(id: string): boolean
  markRead(ids: readonly string[], at?: number): Promise<void>
  dismiss(ids: readonly string[], at?: number): Promise<void>
  record(event: NotificationEvent): Promise<void>
  report(event: NotificationEvent): Promise<void>
  retract(id: string): Promise<void>
  /**
   * The one writer of `firstSeenAt`: stamps every listed id, forgets `retired` ids nothing lists,
   * and keeps the limit. `complete`: every source has loaded, so an unlisted id is really gone; only
   * then does the limit drop anything.
   */
  observe(
    listed: readonly Stampable[],
    retired: readonly string[],
    now: number,
    complete: boolean,
  ): Promise<void>
}

export function createNotifications(kv: KvStore): Notifications {
  const state = persistentStore<NotificationState>(kv, {
    scope: "acct",
    name: "notificationState",
    version: 1,
    migrate: (from, saved, kv) => {
      if (from !== undefined) throw new Error(`notificationState: unknown version ${from}`)
      const records = legacyNotificationState(kv)
      for (const [id, row] of saved) records.push([id, row as NotificationState])
      return { records }
    },
  })
  const events = persistentStore<NotificationEvent>(kv, {
    scope: "acct",
    name: "notificationEvents",
    version: 1,
    migrate: (from, saved, kv) => {
      if (from !== undefined) throw new Error(`notificationEvents: unknown version ${from}`)
      const records = legacyNotificationEvents(kv)
      for (const [id, row] of saved) records.push([id, row as NotificationEvent])
      return { records }
    },
  })

  /** Returns whether the id changed. */
  const change = (id: string, next: NotificationChange): boolean => {
    const after = notificationTransition(
      { id, state: state.latest(id), event: events.latest(id) },
      next,
    )
    if (!after) return false
    if (after.state) state.put(id, after.state)
    else state.remove(id)
    if (after.event) events.put(id, after.event)
    else events.remove(id)
    return true
  }
  /** Saves `write`'s changes in one transaction; listeners hear them once it lands. */
  const apply = (write: () => void): Promise<void> => kv.batch(write)
  const each = (ids: readonly string[], next: NotificationChange) =>
    apply(() => {
      for (const id of ids) change(id, next)
    })

  return {
    state,
    events,
    ready: Promise.all([state.ready, events.ready]).then(() => undefined),
    has: (id) => events.get().has(id),
    markRead: (ids, at = Date.now()) => each(ids, { type: "read", at }),
    dismiss: (ids, at = Date.now()) => each(ids, { type: "dismissed", at }),
    record: (event) => each([event.id], { type: "recorded", event }),
    report: (event) => each([event.id], { type: "reported", event }),
    retract: (id) => each([id], { type: "retracted" }),
    observe: (listed, retired, now, complete) =>
      apply(() => {
        const live = new Set(listed.map((entry) => entry.id))
        for (const id of retired) change(id, { type: "retired", listed: live.has(id) })
        const known = (id: string) => !!state.latest(id)
        for (const entry of listed) {
          change(entry.id, { type: "listed", at: now, old: isOld(entry, known, now) })
        }
        if (!complete) return
        // Events are always listed, so the limit drops only rows whose records are gone. Rows as
        // last written: the saved ones and those this pass stamps.
        const ids = new Set([...state.get().keys(), ...live])
        const rows = [...ids].flatMap((id) => state.latest(id) ?? [])
        let over = rows.length - NOTIFICATION_LIMIT
        const oldest = rows
          .filter((row) => !live.has(row.id))
          .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
        for (const row of oldest) {
          if (over <= 0) break
          if (change(row.id, { type: "capped", listed: false })) over--
        }
      }),
  }
}
