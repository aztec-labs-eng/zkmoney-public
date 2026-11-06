/**
 * The records the activity feed reads, as stores over the session's domain stores, the records not
 * yet moved onto persistent stores, and the shared clock.
 */
import {
  UpgradeActivity,
  bestEffort,
  derived,
  onRefundInFlightChanged,
  OPEN,
  PENDING,
  legacyRecords,
  refundsInFlight,
  legacyStore,
  syncCatchUp,
  type Activity,
  type ContactActivitySources,
  type FeedSources,
  type Loaded,
  type OldVersionWithdrawal,
  type ReadonlyStore,
  type RecordSet,
  type Requests,
  type SipaDeposits,
  type SipaProcessingState,
  type Sourced,
  type Transaction,
  type Withdrawals,
} from "@obsidion/front-core"
import { getSavingsMoveStore } from "../../features/savings/savingsMoveStore"
import { getOldVersionWithdrawalStore } from "../../features/withdraw/oldVersionWithdrawals"
import { wallClock } from "../../lib/clock"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

const NO_UPGRADES: FeedSources["upgrades"] = { items: [], recipients: new Set(), loaded: false }

/** The account's upgrade runs: each session's feed loads its own account's. */
function upgradesStore(): ReadonlyStore<Sourced<FeedSources["upgrades"]>> {
  const upgrades = UpgradeActivity.get(webStorage)
  void bestEffort("unknown", upgrades.changed())
  return legacyStore(
    {
      read: () => ({
        items: upgrades.items(),
        recipients: upgrades.recipients(),
        loaded: upgrades.loaded(),
      }),
      subscribe: (listener) => upgrades.onChanged(listener),
    },
    NO_UPGRADES,
  )
}

// A record source mirrors its list for the page's life, so each is built once per page.
let moves: ReadonlyStore<FeedSources["moves"]> | undefined
let oldVersionWithdrawals: ReadonlyStore<Loaded<OldVersionWithdrawal>> | undefined

const savingsMoves = () => (moves ??= legacyRecords(getSavingsMoveStore()))
export const oldVersionWithdrawalRecords = () =>
  (oldVersionWithdrawals ??= legacyRecords(getOldVersionWithdrawalStore()))

/**
 * The activity rows Home reads beside its window: every pending row, every link still in escrow,
 * and every row that pays a request.
 */
export interface ActivityReads {
  pending: ReadonlyStore<RecordSet<Transaction>>
  open: ReadonlyStore<RecordSet<Transaction>>
  paying: ReadonlyStore<RecordSet<Transaction>>
}

export function activityReads(activity: Activity): ActivityReads {
  return {
    pending: activity.query("pending", PENDING),
    open: activity.query("open", OPEN),
    paying: activity.query("request", {}),
  }
}

/** Several row reads as one, each row once: loaded once all are, failed if any is. */
export function mergedRows(
  sets: readonly ReadonlyStore<RecordSet<Transaction>>[],
): ReadonlyStore<RecordSet<Transaction>> {
  return derived(sets, (...read) => ({
    records: [...new Map(read.flatMap((set) => set.records.map((row) => [row.id, row]))).values()],
    loaded: read.every((set) => set.loaded),
    failed: read.some((set) => set.failed),
  }))
}

export type FeedBase = Omit<FeedSources, "rows">

/** What every feed reads beside its rows. */
export function feedBase(
  requests: Requests,
  withdrawals: Withdrawals,
  sipaDeposits: SipaDeposits,
  processing: ReadonlyStore<ReadonlyMap<string, SipaProcessingState>>,
): ReadonlyStore<FeedBase> {
  const refunds: ReadonlyStore<ReadonlySet<string>> = {
    get: refundsInFlight,
    subscribe: onRefundInFlightChanged,
  }
  return derived(
    [
      requests.view,
      requests.loaded,
      sipaDeposits.view,
      withdrawals.list,
      upgradesStore(),
      savingsMoves(),
      oldVersionWithdrawalRecords(),
      processing,
      refunds,
      syncCatchUp.status,
      wallClock,
    ] as const,
    (
      requests,
      requestsLoaded,
      deposits,
      withdrawals,
      upgrades,
      moves,
      oldVersionWithdrawals,
      processing,
      refunding,
      catching,
      now,
    ) => ({
      requests,
      requestsLoaded,
      deposits,
      withdrawals,
      upgrades: upgrades.value,
      moves,
      oldVersionWithdrawals: oldVersionWithdrawals.records,
      processing,
      refunding,
      catchingUp: catching,
      now,
    }),
  )
}

/** A feed listing `rows`. */
export function feedSources(
  base: ReadonlyStore<FeedBase>,
  rows: ReadonlyStore<RecordSet<Transaction>>,
): ReadonlyStore<FeedSources> {
  return derived([base, rows] as const, (base, rows) => ({ ...base, rows }))
}

/** The rows exchanged with these L2 addresses. */
export function peerRows(
  activity: Pick<Activity, "query">,
  addresses: readonly string[],
): ReadonlyStore<RecordSet<Transaction>> {
  return mergedRows(addresses.map((address) => activity.query("peer", address.toLowerCase())))
}

/** The newest rows the recent people are read from. */
const RECENT_PEOPLE_ROWS = 100

/** What `recentContacts` reads: the newest interactions with contacts, whatever the feed shows. */
export function contactActivity(
  activity: Activity,
  requests: Requests,
  withdrawals: Withdrawals,
  sipaDeposits: SipaDeposits,
): ReadonlyStore<ContactActivitySources> {
  const recent = activity.query("time", { reverse: true, limit: RECENT_PEOPLE_ROWS })
  return derived(
    [recent, requests.view, sipaDeposits.view, withdrawals.list] as const,
    (transactions, requests, deposits, burns) => ({
      transactions: transactions.records,
      requests,
      sipaDeposits: deposits.records,
      withdrawals: burns.records,
    }),
  )
}
