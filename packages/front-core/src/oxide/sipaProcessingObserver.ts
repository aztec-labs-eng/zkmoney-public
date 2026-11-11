/**
 * Live processing reasons for the deposits waiting for a sweep. Each deposit is read against its own portal (from its
 * forwarding-table row), through the shared capacity store for that bucket, so a pending deposit and the
 * funding screen see the same observation. The observer only reads: it never writes a deposit record, never starts a
 * recovery and never sends a transaction.
 *
 * It also remembers, per deposit, the last confirmed reason a manual sweep cannot land (`SipaSweepBlocker`), and keeps
 * it until a later read shows it is gone. The memory lives for the session.
 */
import { parseUnits, type Address } from "viem"
import type { SipaPortalTerms } from "@obsidion/sdk"
import type { RecordSet } from "../engine/persistentStore"
import { isUnfundedSipaDeposit, type SipaDeposit } from "../engine/sipaDeposits"
import { liveStore } from "../engine/liveStore"
import type { QueryEntry } from "../engine/query"
import type { ReadonlyStore } from "../engine/store"
import {
  isAwaitingSweep,
  nextSipaSweepBlocker,
  type SipaProcessingReason,
  type SipaProcessingState,
  type SipaSweepBlocker,
} from "../core/services/deposits/sipaProcessing"
import { evaluateCapacityEligibility } from "./portalCapacityEligibility"
import {
  portalCapacityKey,
  portalCapacityKeyId,
  type PortalCapacityKey,
  type PortalCapacityState,
  type PortalCapacityStore,
} from "./portalCapacityStore"
import { sipaProcessingReason, sipaRequiredCredit } from "./sipaProcessingReason"
import { sipaRecordRoute, type SipaRecordRoute } from "./sipaRoute"

export interface SipaProcessingObserverOptions {
  deposits: ReadonlyStore<RecordSet<SipaDeposit>>
  /** The one shared store for a capacity bucket. */
  capacity: (key: PortalCapacityKey) => PortalCapacityStore
  /** The terms of the row a deposit in `token` settles on: the page's one read of them. */
  terms: (route: SipaRecordRoute, token: string | undefined) => QueryEntry<SipaPortalTerms>
  /** The configured L1 chain. A deposit recorded on another chain has no portal here. */
  l1ChainId: number
  now?: () => number
}

/** What a capacity read of one deposit needs from its record. */
export type SipaSweepSubject = Pick<
  SipaDeposit,
  | "sipaAddress"
  | "l1ChainId"
  | "origin"
  | "phase"
  | "amount"
  | "sweepTxHash"
  | "inboxIndex"
  | "netAmount"
  | "tokenAddress"
  | "tokenDecimals"
  | "intent"
  | "registrationFee"
>

/**
 * The capacity bucket a recorded deposit is processed against: its own portal's key. `pending` while the portal is
 * being looked up. `unknown` otherwise: `retryable` after a failed lookup, which `retry` repeats for any recorded
 * deposit; not for a record with no origin or on another L1 chain, whose identity no retry can find. Subscribers hear
 * when a lookup settles.
 */
export type SipaCapacityKey =
  | { status: "known"; key: PortalCapacityKey }
  | { status: "pending" }
  | { status: "unknown"; retryable: boolean }

export interface SipaProcessingObserver {
  /**
   * Why each deposit waiting for its sweep waits, by lowercase address; a new value also when a portal lookup settles.
   * Reads the pending deposits' capacity while subscribed.
   */
  readonly states: ReadonlyStore<ReadonlyMap<string, SipaProcessingState>>
  /** Undefined for a deposit that is not waiting for a sweep. */
  stateFor(sipaAddress: string): SipaProcessingState | undefined
  /** The key this observer reads the deposit's capacity with, from the same portal lookup. */
  capacityKeyFor(sipaAddress: string): SipaCapacityKey
  /**
   * For "Check again": a new portal lookup after a failed one, for any recorded deposit, and a new capacity read for one
   * waiting for its sweep. Never rejects.
   */
  retry(sipaAddress: string): Promise<SipaProcessingState | undefined>
  /**
   * Before a manual sweep: a read that starts after this call. `live` is the caller's own read of the deposit: it
   * stands in for a record the store lacks, and a record still before its sweep is checked at the larger of its stored
   * and live funding, from then on. A stored origin and a record past its sweep stay as stored. Never rejects.
   */
  refreshForSweep(
    sipaAddress: string,
    live?: Omit<SipaSweepSubject, "sipaAddress">,
  ): Promise<SipaProcessingState | undefined>
}

type LiveFunding = Omit<SipaSweepSubject, "sipaAddress">

/** No sweep, claim or credit is recorded, and the phase comes before one. */
function beforeSweep(record: SipaDeposit): boolean {
  return (
    ["resolved", "funding", "funded", "broadcast", "sweeping"].includes(record.phase) &&
    !record.sweepTxHash &&
    !record.inboxIndex &&
    record.netAmount == null
  )
}

/** Whether `a` holds at least `b`'s funding. Undecidable across tokens or without decimals. */
function holdsAtLeast(
  a: Pick<SipaSweepSubject, "amount" | "tokenAddress" | "tokenDecimals">,
  b: Pick<SipaSweepSubject, "amount" | "tokenAddress" | "tokenDecimals">,
): boolean {
  if (a.tokenDecimals === undefined || b.tokenDecimals === undefined) return false
  if (a.tokenAddress?.toLowerCase() !== b.tokenAddress?.toLowerCase()) return false
  try {
    return parseUnits(a.amount, a.tokenDecimals) >= parseUnits(b.amount, b.tokenDecimals)
  } catch {
    return false
  }
}

/**
 * A record before its sweep, funded by what a manual sweep read on chain. Funds only arrive before a sweep, so the
 * larger amount is the current one. A self-initiated record can still say `resolved` or `funding` then; for this check
 * it is funded.
 */
function withLiveFunding(stored: SipaDeposit, live: LiveFunding): SipaSweepSubject {
  const read = {
    amount: live.amount,
    tokenAddress: live.tokenAddress ?? stored.tokenAddress,
    tokenDecimals: live.tokenDecimals ?? stored.tokenDecimals,
  }
  const funding = holdsAtLeast(stored, read)
    ? {
        amount: stored.amount,
        tokenAddress: stored.tokenAddress,
        tokenDecimals: stored.tokenDecimals,
      }
    : read
  return {
    ...stored,
    ...funding,
    phase: stored.phase === "resolved" || stored.phase === "funding" ? "funded" : stored.phase,
    intent: stored.intent ?? live.intent,
    registrationFee: stored.registrationFee ?? live.registrationFee,
    origin: stored.origin ?? live.origin,
  }
}

/** `failed`: the lookup failed and may succeed again. `unresolved`: no origin, or another L1 chain. */
type Portal =
  | { key: PortalCapacityKey; terms: SipaPortalTerms }
  | "pending"
  | "failed"
  | "unresolved"

export function createSipaProcessingObserver(
  options: SipaProcessingObserverOptions,
): SipaProcessingObserver {
  const now = options.now ?? Date.now
  const blockers = new Map<string, SipaSweepBlocker>()
  /** The largest funding a manual sweep read, per deposit, kept in memory while it can be newer than the store. */
  const liveFunding = new Map<string, LiveFunding>()
  /** Publishes `states`, while subscribed. */
  let publish: ((states: ReadonlyMap<string, SipaProcessingState>) => void) | undefined
  const buckets = new Map<string, () => void>()
  /** The terms of the deposits waiting for a sweep, heard while subscribed. */
  const heard = new Map<QueryEntry<SipaPortalTerms>, () => void>()
  /** Terms a pass started a read of. */
  const reading = new Set<QueryEntry<SipaPortalTerms>>()
  let emitted = ""
  /** Bumped when a portal lookup settles, so a key change reaches subscribers even for a deposit with no reason. */
  let lookups = 0

  const termsOf = (record: SipaSweepSubject) => {
    const route = record.l1ChainId === options.l1ChainId ? sipaRecordRoute(record) : undefined
    return route && options.terms(route, record.tokenAddress)
  }

  const looked = () => {
    lookups += 1
    update()
  }

  /** One read of terms nobody has read yet; a failed one is read again by its retry. */
  const lookUp = (entry: QueryEntry<SipaPortalTerms>) => {
    if (reading.has(entry)) return
    reading.add(entry)
    const settled = () => {
      reading.delete(entry)
      looked()
    }
    void entry.read().then(settled, settled)
  }

  const portalOf = (record: SipaSweepSubject): Portal => {
    const entry = termsOf(record)
    if (!entry) return "unresolved"
    const state = entry.get()
    if (state.status === "pending") {
      lookUp(entry)
      return "pending"
    }
    if (state.status === "failed") return "failed"
    const terms = state.value
    const key = portalCapacityKey({
      chainId: options.l1ChainId,
      portal: terms.portal,
      token: terms.token,
    })
    return { key, terms }
  }

  const compute = (
    record: SipaSweepSubject,
  ): { state: SipaProcessingState; key?: PortalCapacityKey } | undefined => {
    const id = record.sipaAddress.toLowerCase()
    if (!isAwaitingSweep(record)) {
      // An unfunded record keeps what a sweep's live read confirmed.
      if (!isUnfundedSipaDeposit(record as SipaDeposit)) {
        blockers.delete(id)
        liveFunding.delete(id)
      }
      return undefined
    }
    const portal = portalOf(record)
    let reason: SipaProcessingReason
    let key: PortalCapacityKey | undefined
    if (portal === "pending") reason = { kind: "checking" }
    else if (typeof portal === "string") reason = sipaProcessingReason(undefined, now())
    else {
      key = portal.key
      const store = options.capacity(key)
      const at = now()
      reason = sipaProcessingReason(
        evaluateCapacityEligibility({
          state: store.getState(),
          required: sipaRequiredCredit(record, portal.terms),
          txAmountCap: portal.terms.txAmountCap,
          now: at,
          staleAfterMs: store.policy.staleAfterMs,
        }),
        at,
      )
    }
    const blocker = nextSipaSweepBlocker(blockers.get(id), reason)
    if (blocker) blockers.set(id, blocker)
    else blockers.delete(id)
    return { state: blocker ? { reason, blocker } : { reason }, key }
  }

  /** Marked before it subscribes: a subscribe that notifies at once re-enters `update`. */
  const follow = <K>(map: Map<K, () => void>, key: K, subscribe: () => () => void) => {
    if (map.has(key)) return
    map.set(key, () => {})
    map.set(key, subscribe())
  }

  /** Recomputes every pending deposit, follows the buckets they need and publishes a change. */
  function update() {
    const states: [string, SipaProcessingState][] = []
    const keys = new Map<string, PortalCapacityKey>()
    const entries = new Set<QueryEntry<SipaPortalTerms>>()
    for (const stored of options.deposits.get().records) {
      const record = subjectOf(stored.sipaAddress)
      if (!record) continue
      const computed = compute(record)
      if (!computed) continue
      states.push([record.sipaAddress.toLowerCase(), computed.state])
      if (computed.key) keys.set(portalCapacityKeyId(computed.key), computed.key)
      const entry = termsOf(record)
      if (entry) entries.add(entry)
    }
    if (!publish) return
    for (const [entry, stop] of heard) {
      if (entries.has(entry)) continue
      stop()
      heard.delete(entry)
    }
    for (const entry of entries) follow(heard, entry, () => entry.subscribe(looked))
    for (const [id, stop] of buckets) {
      if (keys.has(id)) continue
      stop()
      buckets.delete(id)
    }
    for (const [id, key] of keys) follow(buckets, id, () => options.capacity(key).subscribe(update))
    const serialized = JSON.stringify([lookups, states], (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    )
    if (serialized === emitted) return
    emitted = serialized
    publish(new Map(states))
  }

  const recordOf = (sipaAddress: string) => {
    const id = sipaAddress.toLowerCase()
    return options.deposits.get().records.find((r) => r.sipaAddress.toLowerCase() === id)
  }

  /** The stored record with any live funding. `standIn` lets live funding stand for a record the store lacks. */
  const subjectOf = (sipaAddress: string, standIn = false): SipaSweepSubject | undefined => {
    const stored = recordOf(sipaAddress)
    const live = liveFunding.get(sipaAddress.toLowerCase())
    if (!stored)
      return standIn && live ? { ...live, sipaAddress: sipaAddress as Address } : undefined
    return live && beforeSweep(stored) ? withLiveFunding(stored, live) : stored
  }

  /** Waits for the deposit's portal, then runs `read` on its store. */
  const reread = async (
    sipaAddress: string,
    read: (store: PortalCapacityStore) => Promise<PortalCapacityState>,
    live?: LiveFunding,
  ): Promise<SipaProcessingState | undefined> => {
    if (live) {
      // A read from a lagging RPC can arrive after a larger one; funds only arrive before a sweep.
      const id = sipaAddress.toLowerCase()
      const kept = liveFunding.get(id)
      if (!kept || !holdsAtLeast(kept, live)) liveFunding.set(id, live)
    }
    const record = subjectOf(sipaAddress, true)
    if (!record) return undefined
    // The portal lookup serves the key of any recorded deposit, so a failed one is repeated first.
    const entry = termsOf(record)
    if (entry) {
      const before = entry.get()
      await entry.read().catch(() => undefined)
      if (entry.get() !== before) lookups += 1
      const portal = portalOf(record)
      if (typeof portal === "object" && isAwaitingSweep(record)) {
        await read(options.capacity(portal.key))
      }
    }
    update()
    const current = subjectOf(sipaAddress, true)
    return current && compute(current)?.state
  }

  function stateFor(sipaAddress: string): SipaProcessingState | undefined {
    const record = subjectOf(sipaAddress)
    return record ? compute(record)?.state : undefined
  }

  return {
    states: liveStore<ReadonlyMap<string, SipaProcessingState>>(new Map(), {
      whileSubscribed(set) {
        publish = set
        const stopDeposits = options.deposits.subscribe(() => update())
        update()
        return () => {
          publish = undefined
          stopDeposits()
          for (const stop of buckets.values()) stop()
          buckets.clear()
          for (const stop of heard.values()) stop()
          heard.clear()
          emitted = ""
        }
      },
    }),
    stateFor,
    capacityKeyFor(sipaAddress) {
      const record = recordOf(sipaAddress)
      const portal = record ? portalOf(record) : "unresolved"
      if (typeof portal === "object") return { status: "known", key: portal.key }
      if (portal === "pending") return { status: "pending" }
      return { status: "unknown", retryable: portal === "failed" }
    },
    retry: (sipaAddress) => reread(sipaAddress, (store) => store.retry()),
    refreshForSweep: (sipaAddress, live) =>
      reread(sipaAddress, (store) => store.refreshForSubmit(), live),
  }
}
