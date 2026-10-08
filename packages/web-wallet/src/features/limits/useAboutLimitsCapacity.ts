import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import {
  evaluateCapacityEligibility,
  type PortalCapacityKey,
  type PortalCapacityState,
} from "@obsidion/front-core"
import { SOURCE_OPERATION_CAP } from "@obsidion/sdk"
import { activeCapacityKey, depositCapacityStore } from "../deposit/capacityStore"
import { fundingCapacityView } from "../deposit/fundingCapacity"
import { capacityFacts } from "./aboutLimitsFacts"
import type { CapacityFacts } from "./aboutLimitsView"

/**
 * Which capacity bucket the sheet shows. `active`: the bucket new deposits fund. `key`: the bucket a
 * recorded deposit was made to. `pending`: that bucket is still being named. `unresolved`: it is not
 * known; `retry` re-reads it through the context that owns the record, and is omitted when no read
 * can name it.
 */
export type CapacitySource =
  | { kind: "active" }
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
  const active = source.kind === "active"
  const [activeKey, setActiveKey] = useState<PortalCapacityKey>()
  const [keyFailed, setKeyFailed] = useState(false)
  const [keyAttempt, setKeyAttempt] = useState(0)

  useEffect(() => {
    if (!active) return
    let stale = false
    setKeyFailed(false)
    activeCapacityKey().then(
      (key) => {
        if (!stale) setActiveKey(key)
      },
      (error: unknown) => {
        console.warn("[limits] could not resolve the deployment's capacity key", error)
        if (!stale) setKeyFailed(true)
      },
    )
    return () => {
      stale = true
    }
  }, [active, keyAttempt])

  const key = source.kind === "key" ? source.key : active ? activeKey : undefined
  const store = useMemo(() => (key ? depositCapacityStore(key) : undefined), [key])
  const state: PortalCapacityState | undefined = useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    store ? store.getState : noState,
  )

  if (source.kind === "pending") return { facts: { state: "loading" } }
  if (source.kind === "unresolved") return { facts: { state: "unavailable" }, retry: source.retry }
  if (active && keyFailed) {
    return { facts: { state: "unavailable" }, retry: () => setKeyAttempt((n) => n + 1) }
  }
  // The funding panel's rules and words for a current read with no amount: low, or none available.
  const eligibility =
    store && state
      ? evaluateCapacityEligibility({
          state,
          required: { status: "unknown" },
          operationCap: SOURCE_OPERATION_CAP,
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
