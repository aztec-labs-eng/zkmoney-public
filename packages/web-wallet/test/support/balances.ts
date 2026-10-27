import type { Balances, BalanceView } from "@obsidion/front-core"
// The store primitive itself, never a module mock of it.
import { memoryStore } from "@obsidion/front-core/dist/engine/store.js"

const UNKNOWN: BalanceView = {
  main: null,
  live: false,
  known: false,
  syncing: false,
  progress: null,
  readAt: undefined,
}

/** The asset layer's balances, holding `view`; Main's figure at 18 decimals. */
export function balancesOf(
  view: Partial<Omit<BalanceView, "main">> & { main?: bigint | null } = {},
): Pick<Balances, "view" | "records"> {
  const { main, ...rest } = view
  const full = {
    ...UNKNOWN,
    ...rest,
    main: main === undefined || main === null ? null : { atomic: main, decimals: 18 },
  }
  return {
    view: memoryStore(full).readonly,
    records: memoryStore({ hydrated: true, entries: [] }).readonly,
  }
}
