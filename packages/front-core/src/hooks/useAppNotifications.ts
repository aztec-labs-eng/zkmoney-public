import { useCallback } from "react"
import type { IStorageAdapter } from "../core/storages/adapter"
import { AppNotificationStore } from "../core/services/notifications"
import { useCachedRecords } from "./useCachedRecords"

/**
 * Live view of the in-app notification store singleton. Pass the platform adapter: hooks run
 * during render, before any sibling mount effect can seed the singleton.
 */
export function useAppNotifications(storage?: IStorageAdapter) {
  const store = AppNotificationStore.get(storage)
  const { records, hydrated } = useCachedRecords(store)
  const entries = records.filter((e) => !e.dismissedAt)
  const markRead = useCallback((id: string) => store.markRead(id).catch(console.warn), [store])
  const markAllRead = useCallback(() => store.markAllRead().catch(console.warn), [store])
  const dismiss = useCallback((id: string) => store.dismiss(id).catch(console.warn), [store])
  const dismissAll = useCallback(
    (opts?: { keepPending?: boolean }) => store.dismissAll(undefined, opts).catch(console.warn),
    [store],
  )
  return {
    entries,
    hydrated,
    unreadCount: entries.filter((e) => !e.read).length,
    markRead,
    markAllRead,
    dismiss,
    dismissAll,
  }
}
