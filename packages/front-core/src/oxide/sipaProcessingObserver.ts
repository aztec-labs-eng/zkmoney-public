/**
 * Live processing reasons for the deposits waiting for a sweep. Each deposit is read against its own portal (from its
 * implementation's `PORTAL()`), through the shared capacity store for that bucket, so a pending deposit and the
 * funding screen see the same observation. The observer only reads: it never writes a deposit record, never starts a
 * recovery and never sends a transaction.
 *
 * It also remembers, per deposit, the last confirmed reason a manual sweep cannot land (`SipaSweepBlocker`), and keeps
 * it until a later read shows it is gone. The memory lives for the session.
 */
import { parseUnits, type Address } from "viem"
import { SOURCE_OPERATION_CAP, type OperationCapFact, type SipaPortalTerms } from "@obsidion/sdk"
import {
  isUnfundedSipaDeposit,
  type SIPADepositRecord,
  type SIPADepositStore,
} from "../core/services/deposits/SIPADepositStore"
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

/** How long a failed terms read waits before another pass may try again. `retry` does not wait. */
const TERMS_RETRY_MS = 15_000

export interface SipaProcessingObserverOptions {
  deposits: Pick<SIPADepositStore, "get" | "list" | "onListChanged">
  /** The one shared store for a capacity bucket. */
  capacity: (key: PortalCapacityKey) => PortalCapacityStore
  /** Usually `(implementation) => readSipaPortalTerms(client, implementation)` on the configured L1 client. */
  readTerms: (implementation: Address) => Promise<SipaPortalTerms>
  /** The configured L1 chain. A deposit recorded on another chain has no portal here. */
  l1ChainId: number
  operationCap?: OperationCapFact
  now?: () => number
}

/** What a capacity read of one deposit needs from its record. */
export type SipaSweepSubject = Pick<
  SIPADepositRecord,
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
  /** Undefined for a deposit that is not waiting for a sweep. */
  stateFor(sipaAddress: string): SipaProcessingState | undefined
  /** The first subscriber starts the capacity reads for the pending deposits; the last one stops them. */
  subscribe(listener: () => void): () => void
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

type TermsEntry =
  | { status: "pending"; promise: Promise<void> }
  | { status: "ready"; terms: SipaPortalTerms }
  | { status: "failed"; at: number }

type LiveFunding = Omit<SipaSweepSubject, "sipaAddress">

/** No sweep, claim or credit is recorded, and the phase comes before one. */
function beforeSweep(record: SIPADepositRecord): boolean {
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
function withLiveFunding(stored: SIPADepositRecord, live: LiveFunding): SipaSweepSubject {
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
  const operationCap = options.operationCap ?? SOURCE_OPERATION_CAP
  const terms = new Map<string, TermsEntry>()
  const blockers = new Map<string, SipaSweepBlocker>()
  /** The largest funding a manual sweep read, per deposit, kept in memory while it can be newer than the store. */
  const liveFunding = new Map<string, LiveFunding>()
  const listeners = new Set<() => void>()
  const buckets = new Map<string, () => void>()
  let stopDeposits: (() => void) | undefined
  let emitted = ""
  /** Bumped when a portal lookup settles, so a key change reaches subscribers even for a deposit with no reason. */
  let lookups = 0

  const loadTerms = (implementation: string): TermsEntry => {
    const promise = options.readTerms(implementation as Address).then(
      (value) => {
        terms.set(implementation, { status: "ready", terms: value })
        lookups += 1
      },
      () => {
        terms.set(implementation, { status: "failed", at: now() })
        lookups += 1
      },
    )
    const entry: TermsEntry = { status: "pending", promise }
    terms.set(implementation, entry)
    void promise.then(() => update())
    return entry
  }

  const termsFor = (implementation: string, force = false): TermsEntry => {
    const id = implementation.toLowerCase()
    const known = terms.get(id)
    if (!known) return loadTerms(id)
    if (known.status === "failed" && (force || now() - known.at >= TERMS_RETRY_MS)) {
      return loadTerms(id)
    }
    return known
  }

  const portalOf = (record: SipaSweepSubject): Portal => {
    if (record.l1ChainId !== options.l1ChainId || !record.origin) return "unresolved"
    const entry = termsFor(record.origin.implementation)
    if (entry.status === "pending") return "pending"
    if (entry.status === "failed") return "failed"
    const key = portalCapacityKey({
      chainId: options.l1ChainId,
      portal: entry.terms.portal,
      token: entry.terms.token,
    })
    return { key, terms: entry.terms }
  }

  const compute = (
    record: SipaSweepSubject,
  ): { state: SipaProcessingState; key?: PortalCapacityKey } | undefined => {
    const id = record.sipaAddress.toLowerCase()
    if (!isAwaitingSweep(record)) {
      // An unfunded record keeps what a sweep's live read confirmed.
      if (!isUnfundedSipaDeposit(record as SIPADepositRecord)) {
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
          operationCap,
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

  /** Recomputes every pending deposit, follows the buckets they need and tells subscribers about a change. */
  function update(notify = true) {
    const states: [string, SipaProcessingState][] = []
    const keys = new Map<string, PortalCapacityKey>()
    for (const stored of options.deposits.list()) {
      const record = subjectOf(stored.sipaAddress)
      if (!record) continue
      const computed = compute(record)
      if (!computed) continue
      states.push([record.sipaAddress.toLowerCase(), computed.state])
      if (computed.key) keys.set(portalCapacityKeyId(computed.key), computed.key)
    }
    if (listeners.size === 0) return
    for (const [id, stop] of buckets) {
      if (keys.has(id)) continue
      stop()
      buckets.delete(id)
    }
    for (const [id, key] of keys) {
      if (!buckets.has(id))
        buckets.set(
          id,
          options.capacity(key).subscribe(() => update()),
        )
    }
    const serialized = JSON.stringify([lookups, states], (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    )
    if (serialized === emitted) return
    emitted = serialized
    if (notify) for (const listener of [...listeners]) listener()
  }

  const recordOf = (sipaAddress: string) => options.deposits.get(sipaAddress as Address)

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
    if (record.origin && record.l1ChainId === options.l1ChainId) {
      const entry = termsFor(record.origin.implementation, true)
      if (entry.status === "pending") await entry.promise
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
    stateFor,
    capacityKeyFor(sipaAddress) {
      const record = recordOf(sipaAddress)
      const portal = record ? portalOf(record) : "unresolved"
      if (typeof portal === "object") return { status: "known", key: portal.key }
      if (portal === "pending") return { status: "pending" }
      return { status: "unknown", retryable: portal === "failed" }
    },
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        stopDeposits = options.deposits.onListChanged(() => update())
        update(false)
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return
        stopDeposits?.()
        stopDeposits = undefined
        for (const stop of buckets.values()) stop()
        buckets.clear()
        emitted = ""
      }
    },
    retry: (sipaAddress) => reread(sipaAddress, (store) => store.retry()),
    refreshForSweep: (sipaAddress, live) =>
      reread(sipaAddress, (store) => store.refreshForSubmit(), live),
  }
}
