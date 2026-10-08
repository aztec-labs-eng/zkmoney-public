/**
 * Shared deposit capacity for an address the wallet shows, read from the bucket of the portal that
 * address forwards to. The active deployment is used only for an address derived from it in this
 * session; a recorded SIPA is keyed by its own implementation's portal; anything else is unknown.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { formatUnits, type Address } from "viem"
import { readSipaPortalTerms, SOURCE_OPERATION_CAP, type SipaPortalTerms } from "@obsidion/sdk"
import {
  evaluateCapacityEligibility,
  portalCapacityKey,
  sipaRequiredCredit,
  SIPADepositStore,
  useCachedRecords,
  type CapacityEligibility,
  type PortalCapacityKey,
  type PortalCapacityState,
  type PortalCapacityStore,
  type RequiredCredit,
  type SIPADepositRecord,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { activeCapacityKey, depositCapacityStore } from "./capacityStore"

export type CapacityTarget =
  /** An address derived from the active deployment in this session. */
  | { kind: "active" }
  /** A SIPA this wallet recorded; its origin names the implementation, and so the portal. */
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
  /** A recorded target's record and its implementation's terms, once read. */
  record?: SIPADepositRecord
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

const terms = new Map<string, Promise<SipaPortalTerms>>()

/** Immutable per implementation, so one read serves every surface; a failed read is dropped. */
function sipaPortalTerms(implementation: Address): Promise<SipaPortalTerms> {
  const id = implementation.toLowerCase()
  let read = terms.get(id)
  if (!read) {
    read = readSipaPortalTerms(l1PublicClient(getConfig()), implementation)
    read.catch(() => terms.delete(id))
    terms.set(id, read)
  }
  return read
}

const noSubscribe = () => () => {}
const noState = () => undefined

type Resolved = { id: string; key?: PortalCapacityKey; terms?: SipaPortalTerms; error?: unknown }

export function useTargetCapacity(target: CapacityTarget): TargetCapacity {
  const depositStore = useMemo(() => SIPADepositStore.get(webStorage), [])
  const { records, hydrated } = useCachedRecords(depositStore)
  const sipa = target.kind === "recorded" ? target.sipaAddress.toLowerCase() : undefined
  const record = sipa ? records.find((r) => r.sipaAddress.toLowerCase() === sipa) : undefined
  // Until the stored records load, a missing record is not yet evidence of a missing origin.
  const recordLoading = !!sipa && !record && !hydrated
  const implementation = record?.origin?.implementation
  // A record from another L1 names a bucket this client cannot read.
  const otherChain = !!record && record.l1ChainId !== getConfig().l1ChainId
  const id =
    target.kind === "active"
      ? "active"
      : implementation && !otherChain
      ? implementation.toLowerCase()
      : undefined

  const [resolved, setResolved] = useState<Resolved>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!id) return
    let stale = false
    const load: Promise<Omit<Resolved, "id">> =
      id === "active"
        ? activeCapacityKey().then((key) => ({ key }))
        : sipaPortalTerms(implementation as Address).then((read) => ({
            terms: read,
            key: portalCapacityKey({
              chainId: getConfig().l1ChainId,
              portal: read.portal,
              token: read.token,
            }),
          }))
    load.then(
      (next) => {
        if (!stale) setResolved({ id, ...next })
      },
      (error) => {
        console.warn("[capacity] could not name the address's capacity bucket", error)
        if (!stale) setResolved({ id, error })
      },
    )
    return () => {
      stale = true
    }
  }, [id, implementation, attempt])

  const current = resolved?.id === id ? resolved : undefined
  const key = current?.key
  const store = useMemo(() => (key ? depositCapacityStore(key) : undefined), [key])
  const state: PortalCapacityState | undefined = useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    store ? store.getState : noState,
  )
  const retry = useCallback(() => {
    if (store) void store.retry()
    else setAttempt((n) => n + 1)
  }, [store])

  const unknown: CapacityEligibility | undefined = !id
    ? recordLoading
      ? { kind: "checking" }
      : otherChain
      ? {
          kind: "unsupported",
          reason: "chain-mismatch",
          detail: "The address is on another network.",
        }
      : UNPROVEN
    : current?.error !== undefined
    ? {
        kind: "unavailable",
        error: current.error instanceof Error ? current.error : new Error(String(current.error)),
      }
    : !store
    ? { kind: "checking" }
    : undefined

  const resolution = !id
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
    operationCap: SOURCE_OPERATION_CAP,
    now: Date.now(),
    staleAfterMs: store.policy.staleAfterMs,
  })
}

/**
 * What the portal would credit for a registration ask sent to a recorded SIPA: the ask less the
 * record's signed registration fee and its portal's funding cut. Unknown until both are read.
 */
export function registrationRequiredCredit(
  capacity: TargetCapacity,
  askAtomic: bigint | undefined,
  decimals: number,
): RequiredCredit {
  const { record, terms: read } = capacity
  if (!record || !read || askAtomic === undefined) return { status: "unknown" }
  const tokenDecimals = record.tokenDecimals ?? decimals
  return sipaRequiredCredit(
    { ...record, tokenDecimals, amount: formatUnits(askAtomic, tokenDecimals) },
    read,
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
