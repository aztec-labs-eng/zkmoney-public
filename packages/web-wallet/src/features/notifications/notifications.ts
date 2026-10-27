/** What the account's bell reads, and where the reorg monitor's outcomes go. */
import {
  bestEffort,
  bootPriority,
  derived,
  memoryStore,
  reorgEvent,
  type BootReader,
  type ConfirmationOutcome,
  type FeedSources,
  type NotificationEvent,
  type Notifications,
  type NotificationSources,
  type NotificationState,
  type ReadonlyStore,
  type Sourced,
} from "@obsidion/front-core"
import { wallClock } from "../../lib/clock"
import { pendingRegistrations } from "../../ui/activity/feedSources"
import type { WalletIdentity } from "../identity/walletIdentity"
import { flowCopy } from "../operations/operationCopy"
import { listsEnding } from "../operations/operationEntries"
import { endedOperations, runningOperations } from "../operations/operations"

export function recordReorgOutcome(
  notifications: Notifications,
  outcome: ConfirmationOutcome,
): void {
  const event = reorgEvent(outcome, Date.now(), notifications.has)
  if (event) void bestEffort("unknown", notifications.record(event))
}

/** Whether `reader`'s boot stage was reached, or its bounded wait gave up, since this call. */
function bootStage(reader: BootReader): ReadonlyStore<boolean> {
  const reached = memoryStore(false)
  void bootPriority.whenReady(reader).then(() => reached.set(true))
  return reached.readonly
}

/** The records the bell's entries are read from. */
export function notificationSources(
  feed: ReadonlyStore<FeedSources>,
  identity: ReadonlyStore<Sourced<WalletIdentity | null>>,
): ReadonlyStore<NotificationSources> {
  return derived(
    [
      feed,
      pendingRegistrations(),
      identity,
      endedOperations,
      runningOperations,
      bootStage("notifications"),
    ] as const,
    (feed, registrations, identity, ended, running, started) => ({
      rows: feed.rows,
      oldVersionWithdrawals: feed.oldVersionWithdrawals,
      deposits: feed.deposits,
      withdrawals: feed.withdrawals,
      upgrades: feed.upgrades,
      processing: feed.processing,
      registrations: registrations.records,
      account: identity.value?.address,
      operations: {
        ended: ended.filter(listsEnding),
        // A sent withdrawal is already its own record's live row.
        running: running.filter(
          (op) => op.state !== "sent" || flowCopy(op.flow).outcome !== "record",
        ),
      },
      loaded:
        feed.deposits.hydrated &&
        feed.withdrawals.hydrated &&
        feed.upgrades.loaded &&
        registrations.hydrated &&
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
  now: number
}

export function bell(
  sources: ReadonlyStore<NotificationSources>,
  notifications: Notifications,
): ReadonlyStore<Bell> {
  return derived(
    [sources, notifications.state, notifications.events, wallClock] as const,
    (sources, state, events, now) => ({ sources, state, events, now }),
  )
}
