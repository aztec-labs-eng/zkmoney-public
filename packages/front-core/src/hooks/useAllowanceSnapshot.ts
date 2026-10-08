import { useSyncExternalStore } from "react"
import type { AllowanceSnapshot, SponsoredAllowanceStore } from "../core/sponsorship"

export function useAllowanceSnapshot(store: SponsoredAllowanceStore): AllowanceSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
