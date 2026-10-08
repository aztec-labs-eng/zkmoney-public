import { useSyncExternalStore } from "react"

/**
 * Links with a claim in flight in this page, from any surface: Home offers no prompt for one. Module
 * state, so a claim outlives the screen that started it.
 */
const running = new Set<string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function isClaimRunning(fragment: string): boolean {
  return running.has(fragment)
}

export function startClaim(fragment: string): void {
  running.add(fragment)
  emit()
}

export function endClaim(fragment: string): void {
  running.delete(fragment)
  emit()
}

/** Live `isClaimRunning`, for a surface that reports the claim rather than offering it. */
export function useClaimRunning(fragment: string | null): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => fragment !== null && running.has(fragment),
  )
}

/** Test seam. */
export function resetRunningClaims(): void {
  running.clear()
}
