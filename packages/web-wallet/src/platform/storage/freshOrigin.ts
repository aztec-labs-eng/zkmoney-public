import { useSyncExternalStore } from "react"
import { createExternalState } from "../../lib/externalState"
import { opfsAvailable } from "./createPxeStore"
import { walletDatabasesExist } from "./walletStorage"

/**
 * Whether this origin held no wallet database when the page started: a first visit, or a private
 * window. Only then is nothing stored that could change the first screen, so it may show before
 * the wallet database opens. Undefined until known; a listing that fails counts as not fresh.
 */
const fresh = createExternalState<boolean | undefined>(undefined)
let check: Promise<boolean> | undefined

/** Checked once per page, before this page opens a wallet database of its own. */
export function originWasFresh(): Promise<boolean> {
  if (!check) {
    check = (async () => {
      // Without OPFS the wallet database lives in memory: nothing is stored here.
      if (!(await opfsAvailable())) return true
      return !(await walletDatabasesExist())
    })().catch(() => false)
    void check.then(fresh.set)
  }
  return check
}

export function useOriginWasFresh(): boolean | undefined {
  return useSyncExternalStore(fresh.subscribe, fresh.get)
}

export function __resetFreshOriginForTests(): void {
  check = undefined
  fresh.set(undefined)
}
