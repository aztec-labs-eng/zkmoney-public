import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import {
  DEFAULT_PORTAL_CAPACITY_POLICY,
  type CapacityEligibility,
  type PortalCapacityKey,
  type PortalCapacityState,
  type PortalCapacityStore,
  type RequiredCredit,
} from "@obsidion/front-core"
import { SOURCE_OPERATION_CAP } from "@obsidion/sdk"
import { activeCapacityKey, depositCapacityStore } from "./capacityStore"
import {
  fundingCapacityView,
  fundingEligibility,
  type FundingCapacityView,
  type FundingMode,
  type UnknownCapacityPolicy,
} from "./fundingCapacity"

const noSubscribe = () => () => {}
const noState = () => undefined

export interface FundingCapacity {
  view: FundingCapacityView
  eligibility: CapacityEligibility
  /** The active deployment's store, once its key is known. */
  store?: PortalCapacityStore
  /** What the portal would credit for `amountAtomic`, in the store's settlement token. */
  required: RequiredCredit
  /** For Retry / Check again: a new read, or a new attempt at the deployment key. */
  retry: () => void
}

/**
 * Live shared-capacity state for new funding to the active deployment. `amountAtomic` is the entered amount in the
 * settlement token's base units; it is the credit only when `exactCredit`.
 */
export function useFundingCapacity(input: {
  amountAtomic?: bigint
  decimals: number
  exactCredit: boolean
  mode: FundingMode
  symbol: string
  sentSymbol: string
  minimumAtomic?: bigint
  unknownCapacity?: UnknownCapacityPolicy
}): FundingCapacity {
  const [key, setKey] = useState<PortalCapacityKey>()
  const [keyFailed, setKeyFailed] = useState(false)
  const [keyAttempt, setKeyAttempt] = useState(0)

  useEffect(() => {
    let stale = false
    let again: ReturnType<typeof setTimeout> | undefined
    activeCapacityKey().then(
      (next) => {
        if (stale) return
        setKeyFailed(false)
        setKey(next)
      },
      (err) => {
        console.warn("[capacity] could not resolve the deployment's capacity key", err)
        if (stale) return
        setKeyFailed(true)
        // Tries again on the store's poll interval, so a failed manifest fetch does not stick until a reload.
        again = setTimeout(
          () => setKeyAttempt((n) => n + 1),
          DEFAULT_PORTAL_CAPACITY_POLICY.refreshMs,
        )
      },
    )
    return () => {
      stale = true
      clearTimeout(again)
    }
  }, [keyAttempt])

  const store = useMemo(() => (key ? depositCapacityStore(key) : undefined), [key])
  const state: PortalCapacityState | undefined = useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    store ? store.getState : noState,
  )

  const { amountAtomic, decimals, exactCredit } = input
  const required: RequiredCredit = useMemo(
    () =>
      store && exactCredit && amountAtomic !== undefined
        ? { status: "known", atomic: amountAtomic, token: store.key.token, decimals }
        : { status: "unknown" },
    [store, exactCredit, amountAtomic, decimals],
  )

  const eligibility: CapacityEligibility =
    store && state
      ? fundingEligibility({
          state,
          required,
          operationCap: SOURCE_OPERATION_CAP,
          now: Date.now(),
          staleAfterMs: store.policy.staleAfterMs,
          unknownCapacity: input.unknownCapacity,
        })
      : keyFailed
      ? { kind: "unavailable", error: new Error("capacity key unavailable") }
      : { kind: "checking" }

  const retry = useCallback(() => {
    if (store) void store.retry()
    else setKeyAttempt((n) => n + 1)
  }, [store])

  const view = fundingCapacityView({ ...input, eligibility })
  return { view, eligibility, store, required, retry }
}
