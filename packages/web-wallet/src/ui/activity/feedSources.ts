/**
 * The records the activity feed reads, as stores over the session's domain stores, the records not
 * yet moved onto persistent stores, and the shared clock.
 */
import {
  bestEffort,
  derived,
  OPEN,
  PENDING,
  legacyStore,
  newestMovesFirst,
  operationRows,
  syncCatchUp,
  type BackupRotationRecord,
  type BridgeIns,
  type Transfers,
  type ContactActivitySources,
  type FeedSources,
  type Loaded,
  type OldVersionWithdrawal,
  type Operations,
  type PaylinkRecord,
  type Paylinks,
  type ReadonlyStore,
  type RecordSet,
  type Requests,
  type SavingsMoves,
  type SipaDeposits,
  type SipaProcessingState,
  type Sourced,
  type Transaction,
  type TransferOperation,
  type UpgradeActivity,
  type Withdrawals,
} from "@obsidion/front-core"

// eslint-disable-next-line no-restricted-syntax -- debt
const NO_UPGRADES: FeedSources["upgrades"] = { items: [], recipients: new Set(), loaded: false }

/** The account's upgrade runs: each session's feed loads its own account's. */
function upgradesStore(upgrades: UpgradeActivity): ReadonlyStore<Sourced<FeedSources["upgrades"]>> {
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

/**
 * What Home reads beside its window: every pending row, every row that pays a request, the links
 * still in escrow, and this device's transfers, each of which is its operation.
 */
export interface ActivityReads {
  pending: ReadonlyStore<RecordSet<Transaction>>
  open: ReadonlyStore<RecordSet<PaylinkRecord>>
  paying: ReadonlyStore<RecordSet<Transaction>>
  transfers: ReadonlyStore<RecordSet<Transaction>>
}

export function activityReads(
  transfers: Transfers,
  paylinks: Paylinks,
  operations: Pick<Operations, "view">,
): ActivityReads {
  return {
    pending: transfers.where("pending", PENDING),
    open: paylinks.where("open", OPEN),
    paying: transfers.where("request", {}),
    transfers: transferRows(operations),
  }
}

/** The rows of this device's transfers `keep` lists. */
function transferRows(
  operations: Pick<Operations, "view">,
  keep?: (op: TransferOperation) => boolean,
): ReadonlyStore<RecordSet<Transaction>> {
  return derived([operations.view], (ops) => operationRows(ops, keep))
}

/** Several reads as one, each record once: loaded once all are, failed if any is. */
export function mergedRows<R extends { id: string } = Transaction>(
  sets: readonly ReadonlyStore<RecordSet<R>>[],
): ReadonlyStore<RecordSet<R>> {
  return derived(sets, (...read) => ({
    records: [...new Map(read.flatMap((set) => set.records.map((row) => [row.id, row]))).values()],
    loaded: read.every((set) => set.loaded),
    failed: read.some((set) => set.failed),
  }))
}

export type FeedBase = Omit<FeedSources, "rows">

/** What every feed reads beside its rows: every link and every operation among the rest. */
export function feedBase(
  requests: Requests,
  withdrawals: Withdrawals,
  sipaDeposits: SipaDeposits,
  bridgeIns: BridgeIns,
  processing: ReadonlyStore<ReadonlyMap<string, SipaProcessingState>>,
  paylinks: Pick<Paylinks, "view">,
  operations: Pick<Operations, "view">,
  savingsMoves: Pick<SavingsMoves, "view">,
  rollup: {
    upgrades: UpgradeActivity
    oldVersionWithdrawals: ReadonlyStore<Loaded<OldVersionWithdrawal>>
  },
  rotations: ReadonlyStore<RecordSet<BackupRotationRecord>>,
  wallClock: ReadonlyStore<number>,
): ReadonlyStore<FeedBase> {
  return derived(
    [
      paylinks.view,
      operations.view,
      requests.view,
      requests.loaded,
      sipaDeposits.view,
      withdrawals.list,
      bridgeIns.list,
      upgradesStore(rollup.upgrades),
      savingsMoves.view,
      rollup.oldVersionWithdrawals,
      processing,
      rotations,
      syncCatchUp.status,
      wallClock,
    ] as const,
    (
      links,
      ops,
      requests,
      requestsLoaded,
      deposits,
      withdrawals,
      bridgeIns,
      upgrades,
      moves,
      oldVersionWithdrawals,
      processing,
      rotations,
      catching,
      now,
    ) => ({
      links,
      operations: ops,
      requests,
      requestsLoaded,
      deposits,
      withdrawals,
      bridgeIns,
      upgrades: upgrades.value,
      // A failed read counts as read: the feed shows what it has.
      moves: { records: newestMovesFirst(moves.records), hydrated: moves.loaded || moves.failed },
      oldVersionWithdrawals: oldVersionWithdrawals.records,
      processing,
      // A funding whose attempt is not read reads as pending; the Passkeys sheet says why.
      rotations: rotations.loaded && !rotations.failed ? rotations.records : "unread",
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

/** The rows exchanged with these L2 addresses, this device's sends to them among them. */
export function peerRows(
  transfers: Pick<Transfers, "where">,
  operations: Pick<Operations, "view">,
  addresses: readonly string[],
): ReadonlyStore<RecordSet<Transaction>> {
  const peers = new Set(addresses.map((address) => address.toLowerCase()))
  return mergedRows([
    ...[...peers].map((address) => transfers.where("peer", address)),
    transferRows(operations, (op) => op.kind === "send" && peers.has(op.payload.to.toLowerCase())),
  ])
}

/** A failed read counts as read: a list shows what it has. */
const settled = ({ loaded, failed }: { loaded: boolean; failed: boolean }) => loaded || failed

/** The newest rows the recent people are read from. */
const RECENT_PEOPLE_ROWS = 100

/** What `recentContacts` reads: the newest interactions with contacts, whatever the feed shows. */
export function contactActivity(
  transfers: Transfers,
  reads: Pick<ActivityReads, "transfers">,
  requests: Requests,
  withdrawals: Withdrawals,
  sipaDeposits: SipaDeposits,
): ReadonlyStore<ContactActivitySources> {
  const recent = transfers.where("time", { reverse: true, limit: RECENT_PEOPLE_ROWS })
  return derived(
    [
      mergedRows([recent, reads.transfers]),
      recent,
      reads.transfers,
      requests.view,
      requests.settled,
      sipaDeposits.view,
      withdrawals.list,
      withdrawals.settled,
    ] as const,
    (transactions, newest, own, requests, requestsSettled, deposits, burns, burnsSettled) => ({
      // Each read on its own: `mergedRows` reports a failure while another read is still loading.
      hydrated:
        settled(newest) && settled(own) && settled(deposits) && requestsSettled && burnsSettled,
      transactions: transactions.records,
      requests,
      sipaDeposits: deposits.records,
      withdrawals: burns.records,
    }),
  )
}
