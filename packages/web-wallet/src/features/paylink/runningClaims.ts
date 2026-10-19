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
  failures.delete(fragment)
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

/** Why a link's last claim on this page failed, until it is claimed again: its review says so. */
const failures = new Map<string, string>()

export function claimFailed(fragment: string, reason: string): void {
  failures.set(fragment, reason)
  emit()
}

/** Live: why the last claim of this link failed, if it did. */
export function useClaimFailure(fragment: string | null): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (fragment === null ? undefined : failures.get(fragment)),
  )
}

/**
 * Links whose automatic claim on Home is over on this page without a claim: it failed past its
 * retries, or it cannot run (an email link's sign-in needs the tap, or the claim window could not be
 * read). Until then the activation surfaces report the claim as under way.
 */
const gaveUp = new Set<string>()

export function autoClaimGaveUp(fragment: string): void {
  if (gaveUp.has(fragment)) return
  gaveUp.add(fragment)
  emit()
}

/** Live: whether Home's automatic claim of this link is over on this page. */
export function useAutoClaimGaveUp(fragment: string | null): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => fragment !== null && gaveUp.has(fragment),
  )
}

/**
 * What Home's automatic claim of a ticket link waits for before it starts: the claim window, with
 * its countdown, or the wallet and the link to be read. Nothing runs yet, so the bell has no row,
 * and the activation surfaces say this instead of claiming.
 */
export type AutoClaimHold = { countdown: string } | "preparing"
const holds = new Map<string, AutoClaimHold>()

const holdLabel = (hold: AutoClaimHold | undefined) =>
  typeof hold === "object" ? hold.countdown : hold

export function holdAutoClaim(fragment: string, hold: AutoClaimHold | undefined): void {
  if (holdLabel(holds.get(fragment)) === holdLabel(hold)) return
  if (hold === undefined) holds.delete(fragment)
  else holds.set(fragment, hold)
  emit()
}

/** Live: what Home's automatic claim of this link still waits for, if it has not started. */
export function useAutoClaimHold(fragment: string | null): AutoClaimHold | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (fragment === null ? undefined : holds.get(fragment)),
  )
}

/** Test seam. */
export function resetRunningClaims(): void {
  running.clear()
  failures.clear()
  gaveUp.clear()
  holds.clear()
}
