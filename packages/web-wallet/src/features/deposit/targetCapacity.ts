/**
 * Shared deposit capacity for an address the wallet shows, read from the bucket of the portal that
 * address forwards to. The active deployment is used only for an address derived from it in this
 * session; a recorded SIPA is keyed by its own forwarding-table row's portal; anything else is unknown.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react"
import { formatUnits } from "viem"
import type { SipaPortalTerms } from "@obsidion/sdk"
import {
  admitDeposit,
  evaluateCapacityEligibility,
  NOMINAL_USD_VALUATION,
  portalCapacityKey,
  sipaRecordRoute,
  sipaRequiredCredit,
  UNREAD,
  useStore,
  type CapacityEligibility,
  type DepositAdmission,
  type PortalCapacityKey,
  type PortalCapacityState,
  type PortalCapacityStore,
  type RequiredCredit,
  type SipaDeposit,
} from "@obsidion/front-core"
import { useSession } from "../../session/session"
import { depositCapacityStore } from "./capacityStore"

export type CapacityTarget =
  /** An address derived from the active deployment in this session, funded with `token`'s row when named. */
  | { kind: "active"; token?: string }
  /** A SIPA this wallet recorded; its origin names the forwarding table, and so the portal. */
  | { kind: "recorded"; sipaAddress: string }
  /** An address whose portal nothing proves. */
  | { kind: "unproven" }

export interface TargetCapacity {
  /**
   * `resolved`: the bucket is named. `pending`: its key is being read. `failed`: the key read failed
   * and `retry` reads it again. `missing`: nothing proves the portal, and no read can.
   */
  resolution: "resolved" | "pending" | "failed" | "missing"
  /** The bucket's key once resolved; for a recorded target, the original portal's. */
  key?: PortalCapacityKey
  store?: PortalCapacityStore
  state?: PortalCapacityState
  /** A recorded target's record and its row's terms, once read. */
  record?: SipaDeposit
  terms?: SipaPortalTerms
  /** Set while no store can be named: why capacity is not known for this address. */
  unknown?: CapacityEligibility
  /** For Check again: a new read, or a new attempt at the key. */
  retry: () => void
}

const UNPROVEN: CapacityEligibility = {
  kind: "unsupported",
  reason: "portal-mismatch",
  detail: "The portal this address forwards to can't be confirmed.",
}

const noSubscribe = () => () => {}
const noState = () => undefined

export function useTargetCapacity(target: CapacityTarget): TargetCapacity {
  const { page, sipaDeposits } = useSession()
  const { config, chain } = page
  const { records, loaded, failed } = useStore(sipaDeposits.view)
  const sipa = target.kind === "recorded" ? target.sipaAddress.toLowerCase() : undefined
  const record = sipa ? records.find((r) => r.sipaAddress.toLowerCase() === sipa) : undefined
  // Until the stored records load, a missing record is not yet evidence of a missing origin.
  const recordLoading = !!sipa && !record && (!loaded || failed)
  const route = useMemo(() => (record ? sipaRecordRoute(record) : undefined), [record])
  // The active bucket's key, or the recorded row's terms that name it.
  const keyRead = target.kind === "active" ? chain.capacityKey(target.token) : undefined
  const termsRead =
    target.kind !== "active" && route
      ? chain.sipaPortalTerms(route, record?.tokenAddress)
      : undefined
  const read = keyRead ?? termsRead
  const activeKey = useStore(keyRead ?? UNREAD)
  const rowTerms = useStore(termsRead ?? UNREAD)
  const current: { key?: PortalCapacityKey; terms?: SipaPortalTerms; error?: unknown } | undefined =
    activeKey.status === "ready"
      ? { key: activeKey.value }
      : rowTerms.status === "ready"
      ? {
          terms: rowTerms.value,
          key: portalCapacityKey({
            chainId: config.l1ChainId,
            portal: rowTerms.value.portal,
            token: rowTerms.value.token,
          }),
        }
      : activeKey.status === "failed"
      ? { error: activeKey.error }
      : rowTerms.status === "failed"
      ? { error: rowTerms.error }
      : undefined
  const key = current?.key
  const store = useMemo(() => (key ? depositCapacityStore(page, key) : undefined), [key, page])
  const state: PortalCapacityState | undefined = useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    store ? store.getState : noState,
  )
  const retry = useCallback(() => {
    if (store) void store.retry()
    else read?.refresh()
  }, [store, read])

  const unknown: CapacityEligibility | undefined = !read
    ? recordLoading
      ? { kind: "checking" }
      : UNPROVEN
    : current?.error !== undefined
    ? {
        kind: "unavailable",
        error: current.error instanceof Error ? current.error : new Error(String(current.error)),
      }
    : !store
    ? { kind: "checking" }
    : undefined

  const resolution = !read
    ? recordLoading
      ? "pending"
      : "missing"
    : current?.error !== undefined
    ? "failed"
    : store
    ? "resolved"
    : "pending"
  return { resolution, key, store, state, record, terms: current?.terms, unknown, retry }
}

/** The eligibility of `required` against the target's bucket; unknown targets stay non-affirmative. */
export function targetEligibility(
  capacity: TargetCapacity,
  required: RequiredCredit,
): CapacityEligibility {
  const { store, state, unknown } = capacity
  if (unknown) return unknown
  if (!store || !state) return { kind: "checking" }
  return evaluateCapacityEligibility({
    state,
    required,
    now: Date.now(),
    staleAfterMs: store.policy.staleAfterMs,
  })
}

/**
 * The portal's answer for a registration ask sent to a recorded SIPA: the sweep keeps the record's
 * signed registration fee, as the SIPA's processing reads it, and credits the rest. Undefined until
 * that credit is known.
 */
export function registrationAdmission(
  capacity: TargetCapacity,
  askAtomic: bigint | undefined,
  token: { symbol: string; decimals: number },
): DepositAdmission | undefined {
  const { record, terms: read } = capacity
  if (!record || !read || askAtomic === undefined) return undefined
  const decimals = record.tokenDecimals ?? token.decimals
  const credit = sipaRequiredCredit(
    { ...record, tokenDecimals: decimals, amount: formatUnits(askAtomic, decimals) },
    read,
  )
  if (credit.status !== "known") return undefined
  return admitDeposit(
    {
      token: { symbol: token.symbol, decimals, settlesIn: credit.token, swapped: false },
      depositFeeAtomic: askAtomic - credit.atomic,
      minimumAtomic: 0n,
    },
    {
      landedAtomic: askAtomic,
      gross: { atomic: askAtomic, decimals, valuation: NOMINAL_USD_VALUATION },
    },
  )
}

/** Why a fixed amount is held by known capacity: `capacity` may clear as it refills; the others never do. */
export type CapacityHold = "capacity" | "ceiling" | "protocol"

export function capacityHold(eligibility: CapacityEligibility): CapacityHold | undefined {
  switch (eligibility.kind) {
    case "exceeds-available":
      return "capacity"
    case "exceeds-ceiling":
      return "ceiling"
    case "exceeds-operation-cap":
      return "protocol"
    default:
      return undefined
  }
}
