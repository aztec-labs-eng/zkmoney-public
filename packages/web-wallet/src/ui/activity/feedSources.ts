/**
 * The records the activity feed reads, as stores over the session's domain stores, the records not
 * yet moved onto persistent stores, and the shared clock.
 */
import {
  UpgradeActivity,
  derived,
  onRefundInFlightChanged,
  processingStates,
  legacyRecords,
  refundsInFlight,
  legacyStore,
  syncCatchUp,
  type Activity,
  type ContactActivitySources,
  type FeedSources,
  type Loaded,
  type OldVersionWithdrawal,
  type PendingRegistrationRecord,
  type ReadonlyStore,
  type Registrations,
  type Requests,
  type SipaProcessingObserver,
  type Sourced,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { bridgeActivityFeed } from "../../features/deposit/sipaProcessing"
import {
  getPendingStore,
  replacedRegistrationRecords,
} from "../../features/onboarding/webRegistration"
import { getSavingsMoveStore } from "../../features/savings/savingsMoveStore"
import { getWithdrawalStore } from "../../features/withdraw/withdrawGateway"
import { getOldVersionWithdrawalStore } from "../../features/withdraw/oldVersionWithdrawals"
import { wallClock } from "../../lib/clock"
import { depositRecords } from "../../platform/storage/requests"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

const NO_UPGRADES: FeedSources["upgrades"] = { items: [], recipients: new Set(), loaded: false }

function upgradesStore(): ReadonlyStore<Sourced<FeedSources["upgrades"]>> {
  const upgrades = UpgradeActivity.get(webStorage)
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
let withdrawals: ReadonlyStore<Loaded<WithdrawalRecord>> | undefined
let moves: ReadonlyStore<FeedSources["moves"]> | undefined
let pending: ReadonlyStore<Loaded<PendingRegistrationRecord>> | undefined
let oldVersionWithdrawals: ReadonlyStore<Loaded<OldVersionWithdrawal>> | undefined

export const withdrawalRecords = () => (withdrawals ??= legacyRecords(getWithdrawalStore()))
const savingsMoves = () => (moves ??= legacyRecords(getSavingsMoveStore()))
export const pendingRegistrations = () => (pending ??= legacyRecords(getPendingStore()))
export const oldVersionWithdrawalRecords = () =>
  (oldVersionWithdrawals ??= legacyRecords(getOldVersionWithdrawalStore()))

export function feedSources(
  activity: Activity,
  requests: Requests,
  observer: SipaProcessingObserver | undefined,
): ReadonlyStore<FeedSources> {
  // Attaches the processing observer and loads the upgrade runs, for the bell's feed too.
  bridgeActivityFeed(observer)
  const refunds: ReadonlyStore<ReadonlySet<string>> = {
    get: refundsInFlight,
    subscribe: onRefundInFlightChanged,
  }
  return derived(
    [
      activity.rows,
      requests.view,
      depositRecords(),
      withdrawalRecords(),
      upgradesStore(),
      savingsMoves(),
      oldVersionWithdrawalRecords(),
      processingStates(depositRecords(), observer),
      refunds,
      syncCatchUp.status,
      wallClock,
    ] as const,
    (
      rows,
      requests,
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
      rows,
      requests,
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

/** This wallet's registrations, live and replaced. */
export function registrationRecords(): ReadonlyStore<Registrations["records"]> {
  return derived(
    [pendingRegistrations(), replacedRegistrationRecords()] as const,
    (pending, replaced) => [...pending.records, ...replaced.value],
  )
}

/** What `recentContacts` reads: every interaction with a contact, whatever the feed shows. */
export function contactActivity(
  activity: Activity,
  requests: Requests,
): ReadonlyStore<ContactActivitySources> {
  return derived(
    [activity.rows, requests.view, depositRecords(), withdrawalRecords()] as const,
    (transactions, requests, deposits, burns) => ({
      transactions,
      requests,
      sipaDeposits: deposits.records,
      withdrawals: burns.records,
    }),
  )
}
