/**
 * The account's stores, built once per page and handed down by `useSession`. A page serves one
 * account: another account's sign-in reloads the page (`reloadIfSessionSwitched`), so nothing here
 * follows an account change. A page with no account, such as a link's visitor, runs on the
 * anonymous namespace until its first sign-in replaces it; its views and their watchers start only
 * once something reads them.
 */
import {
  ContactStorage,
  WalletError,
  createActivity,
  createNotifications,
  createRequests,
  derived,
  getActiveNetworkId,
  memoryStore,
  prefixedKv,
  useStore,
  watchNotifications,
  watchPayerApprovals,
  type Activity,
  type KvStore,
  type Notifications,
  type ReadonlyStore,
  type SipaProcessingObserver,
} from "@obsidion/front-core"
import { sipaProcessingObserver } from "../features/deposit/sipaProcessing"
import { walletIdentity } from "../features/identity/walletIdentity"
import { bell, notificationSources } from "../features/notifications/notifications"
import { wallClock } from "../lib/clock"
import { contactActivity, feedSources, registrationRecords } from "../ui/activity/feedSources"
import { getActiveStorageId } from "./storage/activeStorage"
import { contactsWriteLock } from "./storage/contactsLock"
import { depositRecords, legacyUnlisted } from "./storage/requests"
import { WEB_STORAGE_PREFIX } from "./storage/storageKeys"
import { walletStorage } from "./storage/walletStorage"
import { webStorage } from "./storage/WebStorageAdapter"

/** `id` is null for the namespace a page with no account writes under. */
export type Account = { readonly id: string | null; readonly prefix: string }

const accountOf = (id: string | null): Account => ({
  id,
  prefix: WEB_STORAGE_PREFIX + (id ? `${id}.` : ""),
})

/** The committed account, or the anonymous namespace when there is none. */
export const activeAccount = (): Account => accountOf(getActiveStorageId())

/** What the feed, the bell and the contact lists read, and the watchers that write from them. */
function views(
  kv: KvStore,
  activity: Activity,
  notifications: Notifications,
  observer: SipaProcessingObserver | undefined,
) {
  const requests = createRequests({
    kv,
    payments: derived([activity.rows, depositRecords()] as const, (rows, sipa) => ({
      rows,
      deposits: sipa.records,
    })),
    legacyUnlisted,
  })
  const identity = walletIdentity()
  const feed = feedSources(activity, requests, observer)
  const sources = notificationSources(feed, identity)
  return {
    requests,
    identity,
    feed,
    contactActivity: contactActivity(activity, requests),
    registrations: registrationRecords(),
    bell: bell(sources, notifications),
    sources,
  }
}

function build(account: Account, storage: KvStore) {
  const ended = new AbortController()
  const kv = prefixedKv(storage, account.prefix, ended.signal)
  const activity = createActivity({ kv, networkId: getActiveNetworkId })
  const notifications = createNotifications(kv)
  const stops: Array<() => void> = []
  let built: ReturnType<typeof views> | undefined
  const open = () => {
    if (built) return built
    built = views(kv, activity, notifications, account.id ? sipaProcessingObserver() : undefined)
    stops.push(watchNotifications(built.sources, wallClock, notifications))
    if (account.id) {
      const contacts = ContactStorage.get(webStorage, contactsWriteLock)
      // The payer of each paid request becomes a full contact.
      stops.push(
        watchPayerApprovals({
          requests: built.requests,
          rows: activity.rows,
          approve: (address) => contacts.approveAutoAdded(address),
        }),
      )
    }
    return built
  }
  if (account.id) open()
  return {
    account,
    /** The account's namespace: a scan cursor kept here saves with the rows. */
    kv,
    activity,
    notifications,
    get requests() {
      return open().requests
    },
    get identity() {
      return open().identity
    },
    /** The records the activity feed reads. */
    get feed() {
      return open().feed
    },
    get contactActivity() {
      return open().contactActivity
    },
    /** This wallet's registrations, live and replaced. */
    get registrations() {
      return open().registrations
    },
    get bell() {
      return open().bell
    },
    /** Stops the session's watchers; its namespace stops hearing commits. */
    close: () => {
      for (const stop of stops) stop()
      ended.abort()
    },
  }
}

export type Session = ReturnType<typeof build>

const current = memoryStore<Session | null>(null)
/** The first account this page served: no other account's stores open before it reloads. */
let pageAccount: string | undefined

/** The open session: null before boot opens one and once sign-out closes it. */
export const openedSession: ReadonlyStore<Session | null> = current.readonly

/** Whether the committed account is not the one this page served, so the page must reload. */
export function servesAnotherAccount(): boolean {
  const id = getActiveStorageId()
  return id !== null && pageAccount !== undefined && id !== pageAccount
}

/**
 * The account's session, opened at boot, on sign-in and by the demo seed. The same account returns
 * the open session; an open account's session stays until it closes. Another account's never opens
 * on this page: its sign-in reloads first, and reaching here instead is a bug.
 */
export function openSession(account: Account, storage: KvStore = walletStorage): Session {
  const open = current.get()
  if (account.id !== null && (pageAccount ??= account.id) !== account.id) {
    console.error("[session] another account signed in on this page; it serves the first one")
    return open ?? openSession(accountOf(null), storage)
  }
  if (open && (open.account.id === account.id || open.account.id !== null)) return open
  open?.close()
  const session = build(account, storage)
  current.set(session)
  return session
}

export function closeSession(): void {
  current.get()?.close()
  current.set(null)
}

/** Follows each saved change of the session pointers: a sign-in, or a rejected key's removal. */
export function followSavedSession(): void {
  const account = activeAccount()
  if (account.id === null) closeSession()
  openSession(account)
}

function opened(open: Session | null): Session {
  if (!open) throw new WalletError("unknown", "no session is open")
  return open
}

export const session = (): Session => opened(current.get())

export const useSession = (): Session => opened(useStore(current.readonly))
