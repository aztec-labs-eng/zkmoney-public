import { useCallback, useMemo, useSyncExternalStore } from "react"
import {
  useStore,
  type CapacityEligibility,
  type PortalCapacityState,
  type PortalCapacityStore,
  type RequiredCredit,
} from "@obsidion/front-core"
import { useSession } from "../../session/session"
import { depositCapacityStore } from "./capacityStore"
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
  /** The row the picked token settles on; the pinned bridge's when unset. */
  rowToken?: string
  amountAtomic?: bigint
  decimals: number
  exactCredit: boolean
  mode: FundingMode
  symbol: string
  sentSymbol: string
  minimumAtomic?: bigint
  unknownCapacity?: UnknownCapacityPolicy
}): FundingCapacity {
  const { page } = useSession()
  // Each row is its own bucket, its key read once per page.
  const keyRead = page.chain.capacityKey(input.rowToken)
  const keyState = useStore(keyRead)
  const key = keyState.status === "ready" ? keyState.value : undefined
  const keyFailed = keyState.status === "failed"

  const store = useMemo(() => (key ? depositCapacityStore(page, key) : undefined), [key, page])
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
          now: Date.now(),
          staleAfterMs: store.policy.staleAfterMs,
          unknownCapacity: input.unknownCapacity,
        })
      : keyFailed
      ? { kind: "unavailable", error: new Error("capacity key unavailable") }
      : { kind: "checking" }

  const retry = useCallback(() => {
    if (store) void store.retry()
    else keyRead.refresh()
  }, [store, keyRead])

  const view = fundingCapacityView({ ...input, eligibility })
  return { view, eligibility, store, required, retry }
}
