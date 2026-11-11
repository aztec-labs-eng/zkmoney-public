import type { ClaimFpcAllowance } from "@obsidion/sdk"
import type { QueryFactory, QueryState } from "../../engine/query"
import { derived, type ReadonlyStore } from "../../engine/store"
import { deriveAllowanceState, type SponsoredAllowanceState } from "./allowanceState"
import type { AllowanceUsage } from "./allowanceUsage"

/** One allowance read: the ClaimFPC instance and rail the account's batches use, and what it holds. */
export interface AllowanceRead {
  fpcAddress: string
  railId: number
  /** The account whose notes hold the allowance: the batches' payer. */
  payer: string
  allowance: ClaimFpcAllowance
  /** Absent when the split could not be read; the count still stands. */
  usage?: AllowanceUsage
}

export type AllowanceSnapshot =
  | { status: "loading" }
  | {
      status: "ready"
      read: AllowanceRead
      state: SponsoredAllowanceState
      refreshing: boolean
      /** The last re-read failed, so `read` is from an earlier one. */
      error?: unknown
    }
  | { status: "unavailable"; error: unknown }

/** One session's sponsored-transaction allowance, read for the session's account. */
export interface SponsoredAllowance {
  /** A first reader reads it again; readers open together share that read. */
  readonly snapshot: ReadonlyStore<AllowanceSnapshot>
  /** Reads the count and its split again; a count read in flight is shared. */
  refresh(): void
}

/** How long a failed split waits before it is read again, while something shows it. */
const USAGE_RETRY = { baseMs: 5_000, maxMs: 60_000 }

/** A split, with the count read it splits. */
type Split = { of: AllowanceRead; usage: AllowanceUsage | undefined }

/**
 * The count, with the split of that same read: no count read shows whether the allowance renewed
 * since another. The count alone gates the block on a known zero.
 */
function selectAllowance(
  counted: QueryState<AllowanceRead>,
  split: QueryState<Split>,
): AllowanceSnapshot {
  if (counted.status === "pending") return { status: "loading" }
  if (counted.status === "failed") return { status: "unavailable", error: counted.error }
  const last = split.status === "ready" ? split.value : undefined
  const usage = last?.of === counted.value ? last.usage : undefined
  const read = usage ? { ...counted.value, usage } : counted.value
  return {
    status: "ready",
    read,
    state: deriveAllowanceState(read.allowance),
    refreshing: counted.refreshing,
    ...(counted.error !== undefined && { error: counted.error }),
  }
}

/**
 * The allowance over `read`. `readUsage` splits what spent it, after the count is shown, so a slow
 * split never holds the count. Both read again when a first reader opens, the split on the count's
 * latest read.
 */
export function sponsoredAllowance(
  query: QueryFactory,
  read: (signal: AbortSignal) => Promise<AllowanceRead>,
  readUsage: (read: AllowanceRead, signal: AbortSignal) => Promise<AllowanceUsage | undefined>,
): SponsoredAllowance {
  const count = query<[], AllowanceRead>("sponsoredAllowance", { load: read, stale: 0 })()
  const split = query<[], Split>("sponsoredAllowanceUsage", {
    load: async (signal) => {
      let counted = await count.read(signal)
      for (;;) {
        const usage = await readUsage(counted, signal)
        const latest = count.get()
        const current =
          latest.status !== "ready" || (latest.value === counted && !latest.refreshing)
        if (current || signal.aborted) return { of: counted, usage }
        // The count was read again during this split, so split its latest read.
        counted = latest.refreshing ? await count.read(signal) : latest.value
      }
    },
    stale: 0,
    retry: USAGE_RETRY,
  })()
  return {
    snapshot: derived([count, split] as const, selectAllowance),
    refresh: () => split.refresh(),
  }
}
