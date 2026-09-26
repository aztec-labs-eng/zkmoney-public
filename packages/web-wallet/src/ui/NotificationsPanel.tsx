import { Icon, Spinner, TopNavIconButton } from "@obsidion/web-ds"
import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useNavigate } from "react-router-dom"
import {
  useAppNotifications,
  type AppNotificationEntry,
  type OperationRecord,
} from "@obsidion/front-core"
import { createExternalState } from "../lib/externalState"
import { getActiveStorageId } from "../platform/storage/activeStorage"
import { webStorage } from "../platform/storage/WebStorageAdapter"
import { rowTimestamp } from "./format"
import { Modal } from "./Modal"
import { usePhoneLayout } from "./usePhoneLayout"
import { flowCopy } from "../features/operations/operationCopy"
import { operationEntry, operationIdOf } from "../features/operations/operationEntries"
import {
  getOperationStore,
  useEndedOperations,
  useOperationsInProgress,
} from "../features/operations/operations"

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
  const notice = `${entry.title}: ${entry.description}`
  if (t.type === "bridge.txDetail" && t.sourceId) {
    return {
      to: "/activity",
      state:
        t.bridgeKind === "withdrawal"
          ? { openWithdrawalId: t.sourceId, notice }
          : { openDepositAddress: t.sourceId, notice },
    }
  }
  return t.txHash ? { to: "/activity", state: { openTxHash: t.txHash, notice } } : null
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
 * What the bell lists: the notification store's entries and this scope's ended operations, read off
 * their records, newest first. Actions route an operation's entry to its record.
 */
export function useNotificationList() {
  const app = useAppNotifications(webStorage)
  const { ended, loaded } = useEndedOperations()
  const entries = useMemo(
    () =>
      [...app.entries, ...ended.map(operationEntry).filter((e) => e !== null)].sort(
        (a, b) => b.timestampMs - a.timestampMs,
      ),
    [app.entries, ended],
  )
  const { dismiss: dismissEntry, dismissAll, markAllRead: markEntriesRead } = app
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
    void markEntriesRead()
    const unread = ended.filter((r) => r.readAt === undefined).map((r) => r.operationId)
    if (unread.length) void getOperationStore().markRead(unread).catch(console.warn)
  }, [markEntriesRead, ended])
  // Running operations and live rows stay: their work has not ended.
  const clearAll = useCallback(() => {
    void dismissAll({ keepPending: true })
    void getOperationStore().dismissEnded(getActiveStorageId()).catch(console.warn)
  }, [dismissAll])
  return {
    entries,
    hydrated: app.hydrated && loaded,
    unreadCount: entries.filter((e) => !e.read).length,
    dismiss,
    opened,
    markAllRead,
    clearAll,
  }
}

export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const phone = usePhoneLayout()
  const { entries, unreadCount, dismiss, opened, clearAll } = useNotificationList()
  // A sent withdrawal is already its own record's live row.
  const running = useOperationsInProgress().filter(
    (op) => op.state !== "sent" || flowCopy(op.flow).outcome !== "record",
  )
  const rows = [
    ...running.map((op) => ({ key: op.operationId, time: op.startedAt, op, entry: undefined })),
    ...entries.map((entry) => ({ key: entry.id, time: entry.timestampMs, op: undefined, entry })),
  ].sort((a, b) => b.time - a.time)

  const open = (entry: AppNotificationEntry) => {
    opened(entry)
    onClose()
    const route = notificationRoute(entry)
    if (route) navigate(route.to, route.state ? { state: route.state } : undefined)
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
            <OperationRow key={key} operation={op} />
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
function OperationRow({ operation }: { operation: OperationRecord }) {
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
        </span>
        <span className="ww-notifications__time">
          <Spinner size={14} />
        </span>
      </div>
    </div>
  )
}
