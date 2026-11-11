/**
 * "Notify me when ready": a browser notification when a run this page watches ends. It reaches an
 * open tab only.
 */
import { memoryStore } from "@obsidion/front-core"
import { useSyncExternalStore } from "react"

/** A page can show a notification. Android's browsers show them only from a service worker. */
export const notifySupported = () =>
  typeof Notification !== "undefined" && !/Android/i.test(navigator.userAgent)
// eslint-disable-next-line no-restricted-syntax -- debt
const armed = memoryStore(false)

/** The user asked to be notified. */
export const useNotifyArmed = () => useSyncExternalStore(armed.subscribe, armed.get)

/** A notice whose run ended while the permission prompt was open. */
// eslint-disable-next-line no-restricted-syntax -- debt
let pending: { title: string; body: string } | undefined

/** Arms the notice, and asks for the browser's permission. A refusal disarms it. */
export function armNotify(): void {
  if (!notifySupported()) return
  armed.set(true)
  if (Notification.permission === "granted") return
  void Notification.requestPermission().then((p) => {
    const notice = pending
    pending = undefined
    if (p !== "granted") return armed.set(false)
    if (notice) notifyIfArmed(notice.title, notice.body)
  })
}

/** Shows the notice once, if the user asked for it. */
export function notifyIfArmed(title: string, body: string): void {
  if (!armed.get() || !notifySupported()) return
  if (Notification.permission !== "granted") {
    pending = { title, body }
    return
  }
  armed.set(false)
  new Notification(title, { body })
}
