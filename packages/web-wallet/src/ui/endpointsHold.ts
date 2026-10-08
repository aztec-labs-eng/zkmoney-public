/**
 * Pre-sign-in work a reload would cut short: a sign-in, or a signup's "Unlock access". Saving
 * endpoints reloads the page, so the invitation frame's endpoints pill stays disabled while any
 * screen holds. A count, so one holder's release never frees another's.
 */
import { useLayoutEffect, useSyncExternalStore } from "react"
import { createExternalState } from "../lib/externalState"

const holders = createExternalState(0)

export function endpointsHeld(): boolean {
  return holders.get() > 0
}

export function useEndpointsHeld(): boolean {
  return useSyncExternalStore(holders.subscribe, endpointsHeld)
}

/**
 * Holds while `active`; releases when it turns false or the caller unmounts. A layout effect, so
 * the pill is disabled in the same paint as the work that starts.
 */
export function useHoldEndpoints(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return
    holders.set(holders.get() + 1)
    return () => holders.set(holders.get() - 1)
  }, [active])
}
