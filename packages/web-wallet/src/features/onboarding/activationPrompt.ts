import { useSyncExternalStore } from "react"
import type { PendingRegistrationRecord } from "@obsidion/front-core"

/**
 * The activation sheet's one open flag, shared by everything that raises it: the shell's money
 * routes, Home's controls and banner, the receive and request screens. It lives outside React so a
 * screen can raise it without owning it, and so a dismissal survives the remounts navigation causes.
 */
const DISMISSED_KEY = "webwallet.activationPromptDismissed"
let open = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function openActivationPrompt(): void {
  if (open) return
  open = true
  emit()
}

/** Closes and records the dismissal for this tab and record: it stops asking until a new tab or name. */
export function closeActivationPrompt(record: PendingRegistrationRecord | null): void {
  if (record) {
    try {
      sessionStorage.setItem(DISMISSED_KEY, record.account)
    } catch {
      // Storage refused: the prompt simply asks again on the next load.
    }
  }
  if (!open) return
  open = false
  emit()
}

export function activationPromptDismissed(record: PendingRegistrationRecord | null): boolean {
  if (!record) return false
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === record.account
  } catch {
    return false
  }
}

export function isActivationPromptOpen(): boolean {
  return open
}

export function useActivationPromptOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => open,
  )
}

/** Test seam: back to closed with the dismissal forgotten. */
export function resetActivationPrompt(): void {
  open = false
  try {
    sessionStorage.removeItem(DISMISSED_KEY)
  } catch {
    // nothing to forget
  }
}
