import { useSyncExternalStore } from "react"
import { createExternalState } from "../lib/externalState"

const HIDE_BALANCES_KEY = "webwallet.hide-balances"

const hideBalances = createExternalState(localStorage.getItem(HIDE_BALANCES_KEY) === "true")

function saveHideBalances(hidden: boolean): void {
  localStorage.setItem(HIDE_BALANCES_KEY, String(hidden))
  hideBalances.set(hidden)
}

/** Hide-balances preference, shared live between Home and Settings. */
export function useHideBalances(): [boolean, (hidden: boolean) => void] {
  const hidden = useSyncExternalStore(hideBalances.subscribe, hideBalances.get)
  return [hidden, saveHideBalances]
}
