import { useSyncExternalStore } from "react"

/**
 * A request to open Home's claim flow on one stashed link. Raised by the activation surfaces for
 * a ticket-funded registration whose bound link is on this tab, so the review that claims it opens
 * in the one place that owns the claim, wherever the user asked from.
 */
let requested: string | null = null
const listeners = new Set<() => void>()

export function openClaimPrompt(fragment: string): void {
  requested = fragment
  for (const listener of listeners) listener()
}

/** Home takes the request; a second render sees nothing pending. */
export function takeClaimPromptRequest(): string | null {
  const fragment = requested
  requested = null
  return fragment
}

export function useClaimPromptRequest(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => requested,
  )
}
