/** What the account's bell reads, and where the reorg monitor's outcomes go. */
import {
  NOTIFICATION_WINDOW_MS,
  reorgFailedId,
  timeKey,
  type Transfers,
  derived,
  memoryStore,
  reorgEvent,
  type After,
  type ConfirmationOutcome,
  type Milestones,
  type NotificationEvent,
  type Notifications,
  type Operations,
  type NotificationSources,
  type NotificationState,
  type PaylinkRecord,
  type Paylinks,
  type ReadonlyStore,
  type PendingRegistrationRecord,
  type RecordSet,
  type Sourced,
  type WalletIdentity,
  type Transaction,
  type UpgradePricing,
} from "@obsidion/front-core"
import { mergedRows } from "../../ui/activity/feedSources"
import type { FeedBase } from "../../ui/activity/feedSources"
import { flowCopy } from "../operations/operationCopy"
import { listsEnding } from "../operations/operationEntries"

export async function recordReorgOutcome(
  notifications: Notifications,
  outcome: ConfirmationOutcome,
): Promise<void> {
  // A re-confirmation answers the failure the bell reported.
  const failed =
    outcome.type === "re-confirmed" ? reorgFailedId(outcome.txHash, outcome.reorgEpoch) : undefined
  const reported = failed !== undefined && (await notifications.has(failed))
  const event = reorgEvent(outcome, Date.now(), (id) => reported && id === failed)
  if (event) await notifications.record(event)
}

/** The bell's starting point: an entry the replayed history lists before it never toasts. */
const BELL_AFTER: After = {
  firstBalance: true,
  depositsReplayed: true,
  movesReplayed: true,
  historyAtHead: true,
}

function waitsOver(milestones: Pick<Milestones, "after">, after: After): ReadonlyStore<boolean> {
  const over = memoryStore(false)
  void milestones.after(after).then((ended) => ended && over.set(true))
  return over.readonly
}

/** The bell's entries read off a row or link: a receive by its time, a claim by its claim time. */
const ROW_ENTRIES = ["transfer:receive:", "paylink:claimed:"]

/** What the bell reads off activity and the links. */
export type BellRows = RecordSet<Transaction> & { links: readonly PaylinkRecord[] }

const UNREAD_ROWS: BellRows = { records: [], links: [], loaded: false, failed: false }

/**
 * The activity rows and links the bell reads: receives from 24 hours before its oldest unread one,
 * which settled within the window of when it first showed, and the links claimed since then or
 * still in escrow. The range is set once the unread notifications load.
 */
export function bellRows(
  transfers: Pick<Transfers, "where">,
  paylinks: Pick<Paylinks, "where">,
  notifications: Pick<Notifications, "unread">,
  open: ReadonlyStore<RecordSet<PaylinkRecord>>,
): ReadonlyStore<BellRows> {
  const shown = memoryStore(UNREAD_ROWS)
  let rows: ReadonlyStore<BellRows> | undefined
  let offs: (() => void)[] = []
  let watchers = 0
  const settle = () => {
    if (rows) return shown.set(rows.get())
    const unread = notifications.unread.get()
    if (unread.failed) return shown.set({ ...UNREAD_ROWS, failed: true })
    if (!unread.loaded) return
    let since = Date.now()
    for (const { id, state } of unread.records) {
      if (state && ROW_ENTRIES.some((prefix) => id.startsWith(prefix)))
        since = Math.min(since, state.firstSeenAt)
    }
    const after = timeKey(since - NOTIFICATION_WINDOW_MS)
    const links = mergedRows([open, paylinks.where("claimed", { after })])
    rows = derived([transfers.where("time", { after }), links] as const, (rows, links) => ({
      ...rows,
      links: links.records,
      loaded: rows.loaded && links.loaded,
      failed: rows.failed || links.failed,
    }))
    offs.push(rows.subscribe(settle))
    settle()
  }
  return {
    get: shown.get,
    subscribe(listener) {
      const off = shown.subscribe(listener)
      if (watchers++ === 0) {
        offs.push(notifications.unread.subscribe(settle))
        settle()
      }
      let done = false
      return () => {
        if (done) return
        done = true
        off()
        if (--watchers > 0) return
        offs.forEach((stop) => stop())
        offs = []
        rows = undefined
        shown.set(UNREAD_ROWS)
      }
    },
  }
}

/** The records the bell's entries are read from: `rows` are the activity rows and links read. */
export function notificationSources(
  feed: ReadonlyStore<FeedBase>,
  rows: ReadonlyStore<BellRows>,
  identity: ReadonlyStore<Sourced<WalletIdentity | null>>,
  milestones: Pick<Milestones, "after">,
  registrationRecords: ReadonlyStore<RecordSet<PendingRegistrationRecord>>,
  operations: Pick<Operations, "ended" | "running">,
  previousAccount: ReadonlyStore<string | undefined>,
): ReadonlyStore<NotificationSources> {
  return derived(
    [
      feed,
      rows,
      registrationRecords,
      identity,
      operations.ended,
      operations.running,
      waitsOver(milestones, BELL_AFTER),
      previousAccount,
    ] as const,
    (feed, rows, registrations, identity, ended, running, started, previousAccount) => ({
      rows: rows.records,
      links: rows.links,
      oldVersionWithdrawals: feed.oldVersionWithdrawals,
      deposits: feed.deposits,
      withdrawals: feed.withdrawals,
      bridgeIns: feed.bridgeIns,
      upgrades: feed.upgrades,
      processing: feed.processing,
      // Newest first: the bell speaks for the account's latest registration.
      registrations: [...registrations.records].sort((a, b) => b.startTime - a.startTime),
      account: identity.value?.address,
      previousAccount,
      operations: {
        ended: ended.filter(listsEnding),
        // A sent withdrawal is already its own record's live row.
        running: running.filter(
          (op) => op.state !== "sent" || flowCopy(op.flow).outcome !== "record",
        ),
      },
      loaded:
        rows.loaded &&
        !rows.failed &&
        feed.deposits.loaded &&
        !feed.deposits.failed &&
        feed.withdrawals.hydrated &&
        feed.bridgeIns.hydrated &&
        feed.upgrades.loaded &&
        registrations.loaded &&
        !registrations.failed &&
        identity.loaded &&
        started,
    }),
  )
}

/** What one bell renders from: the entries' records, their stamps and events, and the clock. */
export interface Bell {
  sources: NotificationSources
  state: ReadonlyMap<string, NotificationState>
  events: ReadonlyMap<string, NotificationEvent>
  /** Ids the writer found or gave a state row, loaded or not. */
  stamped: ReadonlySet<string>
  now: number
}

/**
 * What the bell shows: the sources with the pricing that values upgrade runs. Only the bell reads
 * the pricing, so the stamping writer keeps no price poll alive.
 */
export function bell(
  sources: ReadonlyStore<NotificationSources>,
  pricing: ReadonlyStore<UpgradePricing>,
  notifications: Notifications,
  wallClock: ReadonlyStore<number>,
): ReadonlyStore<Bell> {
  return derived(
    [
      sources,
      pricing,
      notifications.state,
      notifications.events,
      notifications.stamped,
      wallClock,
    ] as const,
    (sources, upgradePricing, state, events, stamped, now) => ({
      sources: { ...sources, upgradePricing },
      state,
      events,
      stamped,
      now,
    }),
  )
}
