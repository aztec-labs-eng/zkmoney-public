import { useSyncExternalStore } from "react"
import { deviceStorage } from "../platform/storage/rollupStorage"

const HIDE_BALANCES_KEY = "webwallet.hide-balances"

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function saveHideBalances(hidden: boolean): void {
  deviceStorage.setItem(HIDE_BALANCES_KEY, String(hidden))
  for (const listener of [...listeners]) listener()
}

/** Hide-balances preference, shared live between Home and Settings. */
export function useHideBalances(): [boolean, (hidden: boolean) => void] {
  const hidden = useSyncExternalStore(
    subscribe,
    // Read at render, not at load: a tab that loads inactive and later takes over must see the
    // value the active tab last wrote.
    () => deviceStorage.getItem(HIDE_BALANCES_KEY) === "true",
  )
  return [hidden, saveHideBalances]
}
