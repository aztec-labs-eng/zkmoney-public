import { Icon, Spinner, TopNavIconButton } from "@obsidion/web-ds"
import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useNavigate } from "react-router-dom"
import {
  useAppNotifications,
  useCachedRecords,
  type AppNotificationEntry,
  type OperationRecord,
} from "@obsidion/front-core"
import { createExternalState } from "../lib/externalState"
import { getActiveStorageId } from "../platform/storage/activeStorage"
import { webStorage } from "../platform/storage/WebStorageAdapter"
import { rowTimestamp } from "./format"
import { Modal } from "./Modal"
import { usePhoneLayout } from "./usePhoneLayout"
import { openActivationPrompt } from "../features/onboarding/activationPrompt"
import { flowCopy } from "../features/operations/operationCopy"
import { operationEntry, operationIdOf } from "../features/operations/operationEntries"
import { openTicketClaimReview } from "../features/paylink/claimPrompt"
import { pendingTicketRegistration } from "../features/paylink/ticketContinuation"
import { TabLine, type TabPlace } from "../features/operations/TabLine"
import {
  getOperationStore,
  useEndedOperations,
  useOperationsInProgress,
} from "../features/operations/operations"
import { groupEntryId, groupOfOperation } from "../features/withdraw/freshAddressGateway"
import { getWithdrawalStore } from "../features/withdraw/withdrawGateway"

const panelOpen = createExternalState(false)

/** Panel visibility, shared so any flow can open what the bell owns. */
export function useNotificationsPanelOpen(): [boolean, (open: boolean) => void] {
  return [useSyncExternalStore(panelOpen.subscribe, panelOpen.get), panelOpen.set]
}

/** SF Symbol names the producers emit → web-ds glyphs. */
const ICON: Record<string, string> = {
  "arrow.down.left": "receive",
  "arrow.up.right": "send",
  "link": "link",
  "checkmark.circle": "check-circle",
  "checkmark.circle.fill": "check-circle",
  "exclamationmark.triangle": "alert-triangle",
  "exclamationmark.triangle.fill": "alert-triangle",
  "lock.shield": "lock-shield",
  "arrow.uturn.backward": "reply",
  "person.crop.circle.badge.plus": "user-follow",
}

export interface NotificationRoute {
  to: string
  /** Router state the activity feed opens a detail modal from. */
  state?: Record<string, string>
  /** Open the pending name's review on Home: the claim's step and status, or the activation sheet. */
  activate?: boolean
}

/** Where a row tap lands: a mutual add opens the contact, everything else the matching activity detail. */
export function notificationRoute(entry: AppNotificationEntry): NotificationRoute | null {
  const t = entry.target as {
    type: string
    txHash?: string
    bridgeKind?: string
    sourceId?: string
    contactId?: string
  }
  if (t.type === "contact.added") {
    return t.contactId ? { to: `/contacts/${encodeURIComponent(t.contactId)}` } : null
  }
  if (t.type === "migration.residuals") return { to: "/activity" }
  if (t.type === "registration.pending") {
    // A payment link's registration is Home's: its claim runs there and its review reports it, so
    // the wizard's deposit ask is never the place to land.
    if (pendingTicketRegistration()) return { to: "/", activate: true }
    const tag = (entry.target as { tag?: string }).tag
    return tag ? { to: `/claim/${encodeURIComponent(tag)}` } : null
  }
  const notice = `${entry.title}: ${entry.description}`
  // A failure alert is stale once a re-inclusion confirms its row or revives its withdrawal. The
  // bridge producer's failed entry is one; "Funds not sent", an error on the same target, is not.
  const failure =
    t.type === "reorg.txDetail" || (t.bridgeKind === "withdrawal" && /:failed(:|$)/.test(entry.id))
  const noticeStale: Record<string, string> =
    failure && entry.severity === "error" ? { noticeStaleOn: "success" } : {}
  if (t.type === "bridge.txDetail" && t.sourceId) {
    return {
      to: "/activity",
      state:
        t.bridgeKind === "withdrawal"
          ? { openWithdrawalId: t.sourceId, notice, ...noticeStale }
          : { openDepositAddress: t.sourceId, notice },
    }
  }
  return t.txHash
    ? { to: "/activity", state: { openTxHash: t.txHash, notice, ...noticeStale } }
    : null
}

/** What opening an entry does; null when it has nothing to open here. */
export type EntryOpener = (entry: AppNotificationEntry) => (() => void) | null

/** The wallet's opener: every entry's detail is a route. */
export function useRouteOpener(): EntryOpener {
  const navigate = useNavigate()
  return useCallback(
    (entry: AppNotificationEntry) => {
      const route = notificationRoute(entry)
      return route
        ? () => {
            if (route.activate && !openTicketClaimReview()) openActivationPrompt()
            navigate(route.to, route.state ? { state: route.state } : undefined)
          }
        : null
    },
    [navigate],
  )
}

/**
 * Toast identity. A live row and its settled outcome are the same entry id, so the key carries the
 * state too — otherwise a row seen in flight would count as already toasted once it settles.
 */
export function toastKey(entry: AppNotificationEntry): string {
  return entry.pending ? `${entry.id}:pending` : entry.id
}

/** Entries the bell should toast: unread, not yet shown, and settled. A live row is status. */
export function freshToasts(
  entries: AppNotificationEntry[],
  seen: Set<string>,
): AppNotificationEntry[] {
  return entries.filter((e) => !e.read && !e.pending && !seen.has(toastKey(e)))
}

/**
 * What one bell shows, for a page that is not the wallet: the entries and running operations it may
 * list, count and toast. Everything else in the store is left untouched by that bell.
 */
export interface NotificationScope {
  entry: (entry: AppNotificationEntry) => boolean
  operation: (operationId: string) => boolean
}

/**
 * What the bell lists: this scope's running operations, and the notification store's entries and
 * ended operations, read off their records, newest first. Actions route an operation's entry to its
 * record.
 */
export function useNotificationList(scope?: NotificationScope) {
  const app = useAppNotifications(webStorage)
  const { ended, loaded } = useEndedOperations()
  const { records: withdrawals } = useCachedRecords(getWithdrawalStore())
  // A sent withdrawal is already its own record's live row.
  const running = useOperationsInProgress().filter(
    (op) =>
      (!scope || scope.operation(op.operationId)) &&
      (op.state !== "sent" || flowCopy(op.flow).outcome !== "record"),
  )
  const entries = useMemo(() => {
    // A running leg stands for its group, in place of the live row the bridge producer mints. On a
    // page that did not start the leg, its record names the group.
    const stoodFor = running.flatMap(({ operationId }) => {
      const record = withdrawals.find((w) => w.operationId === operationId)
      const group = groupOfOperation(operationId) ?? record?.groupId
      return group ? groupEntryId(group, "inflight") : []
    })
    return [
      ...app.entries.filter((e) => !stoodFor.includes(e.id)),
      ...ended.map(operationEntry).filter((e) => e !== null),
    ]
      .filter((e) => !scope || scope.entry(e))
      .sort((a, b) => b.timestampMs - a.timestampMs)
  }, [app.entries, ended, running, withdrawals, scope])
  const { dismiss: dismissEntry, dismissAll, markAllRead: markEntriesRead, markRead } = app
  const dismiss = useCallback(
    (id: string) => {
      const operationId = operationIdOf(id)
      if (!operationId) return dismissEntry(id)
      return getOperationStore().dismiss(operationId).catch(console.warn)
    },
    [dismissEntry],
  )
  /** Opening an entry: an operation's is marked read, any other is cleared. */
  const opened = useCallback(
    (entry: AppNotificationEntry) => {
      const operationId = operationIdOf(entry.id)
      if (operationId) void getOperationStore().markRead([operationId]).catch(console.warn)
      else if (!entry.pending) void dismissEntry(entry.id)
    },
    [dismissEntry],
  )
  const markAllRead = useCallback(() => {
    if (scope) {
      const unread = entries.filter((e) => !e.read)
      for (const e of unread) if (!operationIdOf(e.id)) void markRead(e.id)
      const ops = unread.map((e) => operationIdOf(e.id)).filter((id) => id !== undefined)
      if (ops.length) void getOperationStore().markRead(ops).catch(console.warn)
      return
    }
    void markEntriesRead()
    const unread = ended.filter((r) => r.readAt === undefined).map((r) => r.operationId)
    if (unread.length) void getOperationStore().markRead(unread).catch(console.warn)
  }, [scope, entries, markRead, markEntriesRead, ended])
  // Running operations and live rows stay: their work has not ended.
  const clearAll = useCallback(() => {
    if (scope) {
      for (const e of entries) if (!e.pending) void dismiss(e.id)
      return
    }
    void dismissAll({ keepPending: true })
    void getOperationStore().dismissEnded(getActiveStorageId()).catch(console.warn)
  }, [scope, entries, dismiss, dismissAll])
  return {
    entries,
    running,
    hydrated: app.hydrated && loaded,
    unreadCount: entries.filter((e) => !e.read).length,
    dismiss,
    opened,
    markAllRead,
    clearAll,
  }
}

export function NotificationsPanel({
  onClose,
  openEntry,
  place,
  scope,
}: {
  onClose: () => void
  openEntry?: EntryOpener
  place?: TabPlace
  scope?: NotificationScope
}) {
  const byRoute = useRouteOpener()
  const opener = openEntry ?? byRoute
  const phone = usePhoneLayout()
  const { entries, running, unreadCount, dismiss, opened, clearAll } = useNotificationList(scope)
  const rows = [
    ...running.map((op) => ({ key: op.operationId, time: op.startedAt, op, entry: undefined })),
    ...entries.map((entry) => ({ key: entry.id, time: entry.timestampMs, op: undefined, entry })),
  ].sort((a, b) => b.time - a.time)

  const open = (entry: AppNotificationEntry) => {
    opened(entry)
    onClose()
    opener(entry)?.()
  }

  const content = (
    <>
      <div className="ww-notifications__head">
        <span>Notifications</span>
        <span className="ww-notifications__head-actions">
          {unreadCount > 0 && <span className="ww-notifications__new">{unreadCount} new</span>}
          {entries.some((e) => !e.pending) && (
            <button
              type="button"
              className="zkm-btn-reset ww-notifications__clear"
              onClick={clearAll}
            >
              Clear all
            </button>
          )}
          {phone && <TopNavIconButton icon="x" ariaLabel="Close notifications" onClick={onClose} />}
        </span>
      </div>
      <div className="ww-notifications__list">
        {rows.length === 0 && <p className="ww-notifications__empty">No notifications yet</p>}
        {rows.map(({ key, op, entry }) =>
          op ? (
            <OperationRow key={key} operation={op} place={place} />
          ) : (
            <EntryRow
              key={key}
              entry={entry!}
              onOpen={open}
              onDismiss={(id) => void dismiss(id)}
            />
          ),
        )}
      </div>
    </>
  )
  return phone ? (
    <Modal variant="bare" label="Notifications" className="ww-notifications" onClose={onClose}>
      {content}
    </Modal>
  ) : (
    <div className="ww-notifications" role="dialog" aria-label="Notifications">{content}</div>
  )
}

function EntryRow({
  entry,
  onOpen,
  onDismiss,
}: {
  entry: AppNotificationEntry
  onOpen: (entry: AppNotificationEntry) => void
  onDismiss: (id: string) => void
}) {
  return (
    <div className="ww-notifications__item">
      <button
        type="button"
        className="zkm-btn-reset zkm-pressable ww-notifications__row"
        onClick={() => onOpen(entry)}
      >
        <div className="zkm-avatar__disc zkm-activity-row__glyph">
          <Icon name={ICON[entry.systemIcon] ?? "bell"} size={20} color="#fff" />
        </div>
        <span className="ww-notifications__body">
          <span className="ww-notifications__title">{entry.title}</span>
          <span className="ww-notifications__desc">{entry.description}</span>
        </span>
        <span className="ww-notifications__time">
          {entry.pending ? <Spinner size={14} /> : rowTimestamp(entry.timestampMs)}
        </span>
        {!entry.read && <span className="ww-notifications__dot" aria-label="Unread" />}
      </button>
      {/* Live rows have no dismiss: their producer retires them when the work settles. */}
      {!entry.pending && (
        <button
          type="button"
          aria-label="Dismiss"
          className="zkm-btn-reset ww-notifications__dismiss"
          onClick={() => onDismiss(entry.id)}
        >
          <Icon name="x" size={14} strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}

/** A transaction still in progress, read off its operation. */
function OperationRow({ operation, place }: { operation: OperationRecord; place?: TabPlace }) {
  const copy = flowCopy(operation.flow)
  return (
    <div className="ww-notifications__item" role="status">
      <div className="ww-notifications__row">
        <div className="zkm-avatar__disc zkm-activity-row__glyph">
          <Icon name={ICON[copy.icon] ?? "bell"} size={20} color="#fff" />
        </div>
        <span className="ww-notifications__body">
          <span className="ww-notifications__title">{copy.live}</span>
          <span className="ww-notifications__desc">{operation.summary}</span>
          <TabLine operationId={operation.operationId} place={place} />
        </span>
        <span className="ww-notifications__time">
          <Spinner size={14} />
        </span>
      </div>
    </div>
  )
}
