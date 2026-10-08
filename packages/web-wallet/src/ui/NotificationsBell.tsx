import { Icon, Toast } from "@obsidion/web-ds"
import { useCallback, useEffect, useRef, useState } from "react"
import type { AppNotificationEntry } from "@obsidion/front-core"
import { useOperationsInProgress, useTabBoundOperation } from "../features/operations/operations"
import type { TabPlace } from "../features/operations/TabLine"
import {
  NotificationsPanel,
  freshToasts,
  toastKey,
  useNotificationList,
  useNotificationsPanelOpen,
  useRouteOpener,
  type EntryOpener,
  type NotificationScope,
} from "./NotificationsPanel"
import { PhoneIcon } from "./PhoneIcon"
import { usePhoneLayout } from "./usePhoneLayout"

/** Bell + dropdown. Closing by any route marks everything read. */
export function NotificationsBell({
  openEntry,
  place = "tab",
  scope,
}: {
  openEntry?: EntryOpener
  place?: TabPlace
  scope?: NotificationScope
}) {
  const phone = usePhoneLayout()
  const byRoute = useRouteOpener()
  const opener = openEntry ?? byRoute
  const [open, setOpen] = useNotificationsPanelOpen()
  const anchorRef = useRef<HTMLDivElement>(null)
  const { entries, hydrated, unreadCount, opened, markAllRead } = useNotificationList(scope)
  const inScope = (op: { operationId: string } | undefined) =>
    !!op && (!scope || scope.operation(op.operationId))
  // Every unfinished operation, including a sent one this page no longer runs.
  const running = useOperationsInProgress().some(inScope)
  const tabBound = inScope(useTabBoundOperation())
  // A live notification (a registration sweeping, a deposit in flight) spins the bell too, so its
  // progress reads off the icon the same way a running operation does.
  const hasPending = entries.some((e) => e.pending)
  const spinning = running || hasPending
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) void markAllRead()
    wasOpen.current = open
  }, [open, markAllRead])
  const close = useCallback(() => setOpen(false), [setOpen])

  // Entries minted after hydration pop a toast, one at a time; the stored backlog stays behind the
  // bell. An id leaves the queue once its toast has shown. `seen` holds the listed entries' keys
  // only, so an entry removed and minted again under its id toasts again.
  const seen = useRef<Set<string> | null>(null)
  const [queue, setQueue] = useState<AppNotificationEntry[]>([])
  const toast = queue[0] ?? null
  useEffect(() => {
    if (!hydrated) return
    const fresh = seen.current ? freshToasts(entries, seen.current) : []
    seen.current = new Set(entries.map(toastKey))
    if (fresh.length) setQueue((q) => [...q, ...fresh])
  }, [entries, hydrated])
  const dropToast = useCallback(() => setQueue((q) => q.slice(1)), [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(dropToast, 8000)
    return () => clearTimeout(t)
  }, [toast, dropToast])
  // Opening the panel shows the same entries; a toast for a dismissed entry has nothing to open.
  useEffect(() => {
    if (open) setQueue([])
  }, [open])
  useEffect(() => {
    if (toast && !entries.some((e) => e.id === toast.id)) dropToast()
  }, [entries, toast, dropToast])
  const openToast = () => {
    if (!toast) return
    opened(toast)
    dropToast()
    opener(toast)?.()
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close()
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, close])

  return (
    <div className="ww-notifications__anchor" ref={anchorRef}>
      <button
        type="button"
        className="zkm-btn-reset zkm-pressable ww-iconbtn ww-iconbtn--lg"
        aria-label={
          spinning
            ? running
              ? `Notifications, ${
                  tabBound ? `keep this ${place} open` : "a transaction is finishing"
                }`
              : "Notifications, something is in progress"
            : "Notifications"
        }
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {spinning && (
          <span
            className={`ww-notifications__bell-ring ${tabBound ? "is-tab-bound" : "is-safe"}`}
          />
        )}
        {phone ? <PhoneIcon name="bell" color="#fff" /> : <Icon name="bell" size={24} />}
        {unreadCount > 0 && <span className="ww-notifications__bell-dot" />}
      </button>
      {open && (
        <NotificationsPanel onClose={close} openEntry={opener} place={place} scope={scope} />
      )}
      {toast && !open && (
        <Toast
          className="ww-notifications__toast"
          kind={toast.severity === "error" ? "error" : "success"}
          message={`${toast.title}: ${toast.description}`}
          actionLabel={opener(toast) ? "Open" : undefined}
          onAction={openToast}
          onDismiss={dropToast}
        />
      )}
    </div>
  )
}
