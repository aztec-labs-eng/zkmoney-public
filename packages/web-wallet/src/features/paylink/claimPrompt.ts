import { useSyncExternalStore } from "react"
import { peekClaimStash } from "./claimStash"
import { ticketSignupCommitted } from "./ticketContinuation"

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

/**
 * The review of the link that pays for this account's name, with the claim's step and status:
 * what the bell's row and the hero open. False when the bound link is not on this tab.
 */
export function openTicketClaimReview(): boolean {
  const stash = peekClaimStash()
  if (!stash || !ticketSignupCommitted(stash)) return false
  openClaimPrompt(stash)
  return true
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
