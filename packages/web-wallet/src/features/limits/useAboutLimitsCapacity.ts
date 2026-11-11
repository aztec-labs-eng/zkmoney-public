import { useMemo, useSyncExternalStore } from "react"
import {
  evaluateCapacityEligibility,
  UNREAD,
  useStore,
  type PortalCapacityKey,
  type PortalCapacityState,
} from "@obsidion/front-core"
import { useSession } from "../../session/session"
import { depositCapacityStore } from "../deposit/capacityStore"
import { fundingCapacityView } from "../deposit/fundingCapacity"
import { capacityFacts } from "./aboutLimitsFacts"
import type { CapacityFacts } from "./aboutLimitsView"

/**
 * Which capacity bucket the sheet shows. `active`: the bucket new deposits of `token`'s row fund. `key`: the bucket a
 * recorded deposit was made to. `pending`: that bucket is still being named. `unresolved`: it is not
 * known; `retry` re-reads it through the context that owns the record, and is omitted when no read
 * can name it.
 */
export type CapacitySource =
  | { kind: "active"; token?: string }
  | { kind: "key"; key: PortalCapacityKey }
  | { kind: "pending" }
  | { kind: "unresolved"; retry?: () => void }

const noSubscribe = () => () => {}
const noState = () => undefined

/**
 * The sheet's capacity facts, from the shared registry's store for `source`. Only `active` resolves
 * the deployment's key; a recorded deposit never falls back to it.
 */
export function useAboutLimitsCapacity(
  source: CapacitySource,
  symbol: string,
): { facts: CapacityFacts; retry?: () => void } {
  const { page } = useSession()
  const keyRead = source.kind === "active" ? page.chain.capacityKey(source.token) : undefined
  const keyState = useStore(keyRead ?? UNREAD)
  const activeKey = keyState.status === "ready" ? keyState.value : undefined

  const key = source.kind === "key" ? source.key : activeKey
  const store = useMemo(() => (key ? depositCapacityStore(page, key) : undefined), [key, page])
  const state: PortalCapacityState | undefined = useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    store ? store.getState : noState,
  )

  if (source.kind === "pending") return { facts: { state: "loading" } }
  if (source.kind === "unresolved") return { facts: { state: "unavailable" }, retry: source.retry }
  if (keyRead && keyState.status === "failed") {
    return { facts: { state: "unavailable" }, retry: keyRead.refresh }
  }
  // The funding panel's rules and words for a current read with no amount: low, or none available.
  const eligibility =
    store && state
      ? evaluateCapacityEligibility({
          state,
          required: { status: "unknown" },
          now: Date.now(),
          staleAfterMs: store.policy.staleAfterMs,
        })
      : undefined
  const panel =
    eligibility?.kind === "amount-unknown"
      ? fundingCapacityView({
          eligibility,
          mode: "address",
          symbol,
          sentSymbol: symbol,
          exactCredit: true,
        })
      : undefined
  // A late timer can leave an old read marked fresh; the panel calls it out of date, and so does the sheet.
  const shown: PortalCapacityState | undefined =
    state?.status === "fresh" && eligibility?.kind === "stale"
      ? { ...state, status: "stale", reason: "age" }
      : state
  return { facts: capacityFacts(shown, symbol, panel), retry: store && (() => void store.retry()) }
}
