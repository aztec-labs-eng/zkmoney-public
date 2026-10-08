/**
 * Shared, self-refreshing portal capacity reads. One store per capacity bucket, so every screen that shows capacity
 * for a portal sees the same observation and sends one request. A network or deployment change selects another
 * store, which starts empty.
 */
import type { Address } from "viem"
import {
  PortalCapacityUnsupportedError,
  type PortalCapacitySnapshot,
  type PortalCapacityUnsupportedReason,
} from "@obsidion/sdk"

/**
 * One capacity bucket: a portal on a chain, metered in the portal's settlement token. The bucket lives in the portal
 * contract, so the address on its chain identifies the deployment. Build it with `portalCapacityKey`.
 */
export interface PortalCapacityKey {
  chainId: number
  /** Lowercase. */
  portal: Address
  /** Lowercase. The portal's `UNDERLYING`. */
  token: Address
}

const L1_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * The key for a portal, from a manifest tuple or from any other source that names the same portal. Every source gives
 * the same key for the same bucket. Throws on a missing or malformed field.
 */
export function portalCapacityKey(source: {
  chainId?: number | string
  portal?: string
  token?: string
}): PortalCapacityKey {
  const chainId =
    typeof source.chainId === "string" && /^\d+$/.test(source.chainId)
      ? Number(source.chainId)
      : source.chainId
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`portal capacity key: invalid chainId ${JSON.stringify(source.chainId)}`)
  }
  for (const field of ["portal", "token"] as const) {
    if (typeof source[field] !== "string" || !L1_ADDRESS.test(source[field])) {
      throw new Error(`portal capacity key: invalid ${field} ${JSON.stringify(source[field])}`)
    }
  }
  return {
    chainId,
    portal: source.portal!.toLowerCase() as Address,
    token: source.token!.toLowerCase() as Address,
  }
}

export function portalCapacityKeyId(key: PortalCapacityKey): string {
  return [key.chainId, key.portal.toLowerCase(), key.token.toLowerCase()].join("|")
}

/**
 * Proposed product defaults, not protocol rules. `refreshMs`, `staleAfterMs`, `readTimeoutMs` and `referenceMaxAgeMs`
 * must be positive whole milliseconds that a timer can hold (at most 2^31 - 1); only `maxHeadAgeMs` accepts `Infinity`.
 */
export interface PortalCapacityPolicy {
  /** Poll interval while a subscriber is mounted and the page is visible. */
  refreshMs: number
  /** Age, counted from the start of the read, after which a snapshot is no longer current. */
  staleAfterMs: number
  /**
   * Largest allowed block age, by this device's clock, and longest time the block number may stay unchanged. Past
   * either, the RPC head is not current. `Infinity` turns both checks off, for a local chain that mines on demand.
   */
  maxHeadAgeMs: number
  /** A read still pending after this settles as `unavailable`. */
  readTimeoutMs: number
  /** How long, from the start of its fetch, a reference L1 time may be shared by polls. */
  referenceMaxAgeMs: number
}

export const DEFAULT_PORTAL_CAPACITY_POLICY: PortalCapacityPolicy = Object.freeze({
  refreshMs: 15_000,
  staleAfterMs: 30_000,
  maxHeadAgeMs: 60_000,
  readTimeoutMs: 20_000,
  referenceMaxAgeMs: 15_000,
})

const MAX_TIMER_MS = 2 ** 31 - 1

function checkedPolicy(policy: PortalCapacityPolicy): PortalCapacityPolicy {
  for (const field of [
    "refreshMs",
    "staleAfterMs",
    "readTimeoutMs",
    "referenceMaxAgeMs",
  ] as const) {
    const value = policy[field]
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
      throw new Error(`portal capacity policy: invalid ${field} ${value}`)
    }
  }
  if (Number.isNaN(policy.maxHeadAgeMs) || policy.maxHeadAgeMs < 0) {
    throw new Error(`portal capacity policy: invalid maxHeadAgeMs ${policy.maxHeadAgeMs}`)
  }
  return policy
}

export type CapacityUnsupportedReason = PortalCapacityUnsupportedReason | "portal-mismatch"

/** Why a snapshot's RPC head is not current. */
export interface HeadCheck {
  /**
   * `behind-reference`: the block is more than `maxHeadAgeMs` older than the reference L1 time. `old`: the block is
   * older than `maxHeadAgeMs` by this device's clock. `stalled`: the block number has not advanced for longer than
   * `maxHeadAgeMs`. `regressed`: the RPC answered with a block older than one already seen.
   */
  cause: "behind-reference" | "old" | "stalled" | "regressed"
  /**
   * Arrival time minus the answered block's timestamp. An `old` head that keeps this value while the block number
   * advances normally can mean this device's clock is ahead.
   */
  blockAgeMs: number
  /** The reference L1 time minus the block's timestamp, when a reference was used. */
  referenceAgeMs?: number
}

/**
 * The latest L1 time seen by a follower of L1 independent of the capacity RPC, usually the Aztec node
 * (`getNodeInfo().l1ChainId`, `getSyncedL1Timestamp()`). The chain has reached at least this time, so it bounds real
 * time from below without trusting this device's clock. `l1Timestamp` is in whole seconds; `undefined` means the
 * follower has not synced yet.
 */
export type PortalCapacityReference = () => Promise<{
  l1ChainId: number | bigint
  l1Timestamp: bigint | number | undefined
}>

export type PortalCapacityReferenceFailure = "failed" | "unsynced" | "invalid" | "chain-mismatch"

/** A configured reference could not bound the read; the read is not current. */
export class PortalCapacityReferenceError extends Error {
  constructor(
    readonly reason: PortalCapacityReferenceFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = "PortalCapacityReferenceError"
  }
}

interface ReferenceTime {
  chainId: number
  seconds: bigint
}

/** Seconds that still convert to exact milliseconds as a `number`. */
const MAX_REFERENCE_SECONDS = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))

function checkedReference(raw: unknown): ReferenceTime {
  const invalid = (detail: string) =>
    new PortalCapacityReferenceError("invalid", `reference L1 time: ${detail}`)
  if (typeof raw !== "object" || raw === null) throw invalid("not an object")
  const { l1ChainId, l1Timestamp } = raw as Record<string, unknown>
  const chainId =
    typeof l1ChainId === "bigint" && l1ChainId <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(l1ChainId)
      : l1ChainId
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw invalid(`invalid l1ChainId ${String(l1ChainId)}`)
  }
  if (l1Timestamp === undefined || l1Timestamp === null) {
    throw new PortalCapacityReferenceError(
      "unsynced",
      "reference L1 time: the follower has not synced L1 yet",
    )
  }
  const seconds =
    typeof l1Timestamp === "bigint"
      ? l1Timestamp
      : typeof l1Timestamp === "number" && Number.isSafeInteger(l1Timestamp)
      ? BigInt(l1Timestamp)
      : undefined
  if (seconds === undefined || seconds < 0n || seconds > MAX_REFERENCE_SECONDS) {
    throw invalid(`not a whole number of seconds: ${String(l1Timestamp)}`)
  }
  return { chainId, seconds }
}

interface ReferenceSource {
  /** `force` starts a new fetch; otherwise a fetch started less than `referenceMaxAgeMs` ago is shared. */
  get(force: boolean): Promise<ReferenceTime>
}

function referenceSource(
  fetch: PortalCapacityReference,
  maxAgeMs: number,
  monotonic: () => number,
): ReferenceSource {
  let shared: { startedAt: number; time: Promise<ReferenceTime> } | undefined
  return {
    get(force) {
      const startedAt = monotonic()
      const age = shared ? startedAt - shared.startedAt : Infinity
      if (!force && shared && age >= 0 && age < maxAgeMs) return shared.time
      const time = new Promise<unknown>((resolve) => resolve(fetch())).then(
        checkedReference,
        (error) => {
          throw new PortalCapacityReferenceError(
            "failed",
            `reference L1 time could not be read: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error },
          )
        },
      )
      const entry = { startedAt, time }
      shared = entry
      // A failed fetch is never shared.
      time.catch(() => {
        if (shared === entry) shared = undefined
      })
      return time
    },
  }
}

const defaultMonotonic = (): (() => number) =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : Date.now

export class PortalCapacityReadTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`capacity read did not finish within ${timeoutMs} ms`)
    this.name = "PortalCapacityReadTimeoutError"
  }
}

interface Observation {
  snapshot: PortalCapacitySnapshot
  /** Epoch ms when the read started. */
  fetchedAt: number
}

export type PortalCapacityState =
  | { status: "loading"; key: PortalCapacityKey }
  | ({ status: "fresh"; key: PortalCapacityKey } & Observation)
  | ({ status: "stale"; key: PortalCapacityKey; reason: "age" } & Observation)
  | ({ status: "stale"; key: PortalCapacityKey; reason: "head"; head: HeadCheck } & Observation)
  | {
      status: "unavailable"
      key: PortalCapacityKey
      error: unknown
      failedAt: number
      /** The last accepted snapshot. It is not current. */
      lastSnapshot?: PortalCapacitySnapshot
      lastFetchedAt?: number
      /** `lastSnapshot` was published as `fresh`, and no stale or unsupported state has been published since. */
      lastWasFresh?: boolean
    }
  | {
      status: "unsupported"
      key: PortalCapacityKey
      reason: CapacityUnsupportedReason
      detail: string
    }

/** Page visibility and focus, injected so tests and non-browser fronts can drive them. */
export interface VisibilitySource {
  isVisible(): boolean
  /** Calls `listener` when the page becomes visible or gains focus. Returns the unsubscribe. */
  onResume(listener: () => void): () => void
}

export function browserVisibility(): VisibilitySource {
  if (typeof document === "undefined") return { isVisible: () => true, onResume: () => () => {} }
  return {
    isVisible: () => document.visibilityState !== "hidden",
    onResume: (listener) => {
      const onVisibility = () => {
        if (document.visibilityState === "visible") listener()
      }
      document.addEventListener("visibilitychange", onVisibility)
      window.addEventListener("focus", listener)
      return () => {
        document.removeEventListener("visibilitychange", onVisibility)
        window.removeEventListener("focus", listener)
      }
    },
  }
}

export interface PortalCapacityStoreOptions {
  /** Usually `(key) => readPortalCapacity(client, key)`. */
  read: (key: PortalCapacityKey) => Promise<PortalCapacitySnapshot>
  /**
   * Bounds the RPC head against an independent L1 view. When set, a read that it cannot bound is `unavailable`. Not
   * called while `maxHeadAgeMs` is `Infinity`.
   */
  reference?: PortalCapacityReference
  policy?: Partial<PortalCapacityPolicy>
  /** Device clock, epoch ms. */
  now?: () => number
  /** Elapsed-time clock in ms for the reference's age. Defaults to `performance.now()`. */
  monotonic?: () => number
  visibility?: VisibilitySource
}

export interface PortalCapacityStore {
  readonly key: PortalCapacityKey
  readonly policy: PortalCapacityPolicy
  /** Stable between changes, so it can back `useSyncExternalStore`. */
  getState(): PortalCapacityState
  /** The first subscriber starts polling; the last one stops it. */
  subscribe(listener: () => void): () => void
  /** Reads now, or joins the read already running. Resolves to the resulting state; never rejects. */
  refresh(): Promise<PortalCapacityState>
  /** For a Retry action: starts a new read, with a new reference fetch, even while one is running. Never rejects. */
  retry(): Promise<PortalCapacityState>
  /**
   * For the check before a funding prompt: starts a new read, with a new reference fetch, after this call and resolves
   * to the state that read, or a later one, produced. It never returns a cached result and never rejects: a failed
   * read resolves to `unavailable`.
   */
  refreshForSubmit(): Promise<PortalCapacityState>
}

/** Throws on a malformed key or policy. The key is normalized, so a checksummed key names the same bucket. */
export function createPortalCapacityStore(
  bucket: PortalCapacityKey,
  options: PortalCapacityStoreOptions,
): PortalCapacityStore {
  const policy = checkedPolicy({ ...DEFAULT_PORTAL_CAPACITY_POLICY, ...options.policy })
  const source =
    options.reference &&
    referenceSource(
      options.reference,
      policy.referenceMaxAgeMs,
      options.monotonic ?? defaultMonotonic(),
    )
  return storeFor(bucket, options, policy, source)
}

function storeFor(
  bucket: PortalCapacityKey,
  options: PortalCapacityStoreOptions,
  policy: PortalCapacityPolicy,
  source: ReferenceSource | undefined,
): PortalCapacityStore {
  const key = portalCapacityKey(bucket)
  const now = options.now ?? Date.now
  const visibility = options.visibility ?? browserVisibility()
  const listeners = new Set<() => void>()
  let state: PortalCapacityState = { status: "loading", key }
  /** The newest accepted snapshot, and when its block number last advanced. */
  let accepted: (Observation & { advancedAt: number }) | undefined
  let lastWasFresh = false
  let started = 0
  let applied = 0
  let running: Promise<PortalCapacityState> | undefined
  let staleTimer: ReturnType<typeof setTimeout> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let stopResume: (() => void) | undefined

  const set = (next: PortalCapacityState) => {
    state = next
    if (next.status !== "unavailable") lastWasFresh = next.status === "fresh"
    for (const listener of [...listeners]) listener()
  }

  // A timer can fire before the clock shows the full age (a clock step back, a coarse clock), so it checks the age
  // and schedules itself again for the rest.
  function expire() {
    clearTimeout(staleTimer)
    if (state.status !== "fresh") return
    const remaining = state.fetchedAt + policy.staleAfterMs - now()
    if (remaining > 0) {
      staleTimer = setTimeout(expire, remaining)
      return
    }
    const { snapshot, fetchedAt } = state
    set({ status: "stale", key, snapshot, fetchedAt, reason: "age" })
  }

  const mismatch = (snapshot: PortalCapacitySnapshot): PortalCapacityState | undefined => {
    const unsupported = (reason: CapacityUnsupportedReason, detail: string) =>
      ({ status: "unsupported", key, reason, detail } as const)
    if (snapshot.chainId !== key.chainId) {
      return unsupported(
        "chain-mismatch",
        `RPC serves chain ${snapshot.chainId}, not ${key.chainId}`,
      )
    }
    if (snapshot.portal.toLowerCase() !== key.portal) {
      return unsupported("portal-mismatch", `read ${snapshot.portal}, not ${key.portal}`)
    }
    if (snapshot.token.toLowerCase() !== key.token) {
      return unsupported("token-mismatch", `portal settles in ${snapshot.token}, not ${key.token}`)
    }
    return undefined
  }

  const accept = (
    snapshot: PortalCapacitySnapshot,
    fetchedAt: number,
    reference: ReferenceTime | undefined,
  ) => {
    const refused = mismatch(snapshot)
    if (refused) return set(refused)
    const arrivedAt = now()
    const blockMs = Number(snapshot.blockTimestamp) * 1000
    const blockAgeMs = arrivedAt - blockMs
    const ages =
      reference === undefined
        ? { blockAgeMs }
        : { blockAgeMs, referenceAgeMs: Number(reference.seconds) * 1000 - blockMs }
    // A load-balanced RPC can answer from a replica behind a block already seen; that answer is not current.
    if (accepted && snapshot.blockNumber < accepted.snapshot.blockNumber) {
      const head: HeadCheck = { cause: "regressed", ...ages }
      return set({
        status: "stale",
        key,
        snapshot: accepted.snapshot,
        fetchedAt: accepted.fetchedAt,
        reason: "head",
        head,
      })
    }
    const advancedAt =
      accepted && snapshot.blockNumber === accepted.snapshot.blockNumber
        ? accepted.advancedAt
        : fetchedAt
    accepted = { snapshot, fetchedAt, advancedAt }
    const cause =
      ages.referenceAgeMs !== undefined && ages.referenceAgeMs > policy.maxHeadAgeMs
        ? "behind-reference"
        : blockAgeMs > policy.maxHeadAgeMs
        ? "old"
        : fetchedAt - advancedAt > policy.maxHeadAgeMs
        ? "stalled"
        : undefined
    if (cause) {
      return set({
        status: "stale",
        key,
        snapshot,
        fetchedAt,
        reason: "head",
        head: { cause, ...ages },
      })
    }
    // A read that arrives after its snapshot's stale age (a slow read, or staleAfterMs below readTimeoutMs) is
    // published as stale directly, so no subscriber sees it as fresh.
    if (arrivedAt - fetchedAt >= policy.staleAfterMs) {
      return set({ status: "stale", key, snapshot, fetchedAt, reason: "age" })
    }
    set({ status: "fresh", key, snapshot, fetchedAt })
    expire()
  }

  const fail = (error: unknown) => {
    if (error instanceof PortalCapacityUnsupportedError) {
      return set({ status: "unsupported", key, reason: error.reason, detail: error.message })
    }
    set({
      status: "unavailable",
      key,
      error,
      failedAt: now(),
      lastSnapshot: accepted?.snapshot,
      lastFetchedAt: accepted?.fetchedAt,
      lastWasFresh,
    })
  }

  /** The reference for this read, checked against the key's chain. Undefined when no reference applies. */
  const referenceFor = (force: boolean): Promise<ReferenceTime> | undefined => {
    if (!source || policy.maxHeadAgeMs === Infinity) return undefined
    return source.get(force).then((time) => {
      if (time.chainId !== key.chainId) {
        throw new PortalCapacityReferenceError(
          "chain-mismatch",
          `reference L1 time is for chain ${time.chainId}, not ${key.chainId}`,
        )
      }
      return time
    })
  }

  const read = (force: boolean): Promise<PortalCapacityState> => {
    const seq = ++started
    const fetchedAt = now()
    // A result applies only if no read started later has applied already. A read that timed out has applied, so its
    // late answer is dropped.
    const settle = (apply: () => void) => {
      if (seq > applied) {
        applied = seq
        apply()
      }
      return state
    }
    let deadline: ReturnType<typeof setTimeout> | undefined
    const reference = referenceFor(force)
    // The reference is observed before the capacity read starts. A current RPC's block is then no older than the
    // reference's, so the check cannot mark a current RPC stale.
    const observed: Promise<[PortalCapacitySnapshot, ReferenceTime | undefined]> = reference
      ? reference.then(async (time) => [await options.read(key), time])
      : // The executor turns a synchronous throw from `read` into a rejection.
        new Promise<PortalCapacitySnapshot>((resolve) => resolve(options.read(key))).then(
          (snapshot) => [snapshot, undefined],
        )
    const answer = Promise.race([
      observed,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new PortalCapacityReadTimeoutError(policy.readTimeoutMs)),
          policy.readTimeoutMs,
        )
      }),
    ])
    const request = answer
      .then(
        ([snapshot, time]) => settle(() => accept(snapshot, fetchedAt, time)),
        (error) => settle(() => fail(error)),
      )
      .finally(() => {
        clearTimeout(deadline)
        if (running === request) running = undefined
      })
    running = request
    return request
  }

  const refresh = () => running ?? read(false)

  const poll = () => {
    if (visibility.isVisible()) void refresh()
  }

  const start = () => {
    stopResume = visibility.onResume(() => void refresh())
    pollTimer = setInterval(poll, policy.refreshMs)
    expire()
    if (state.status !== "fresh" || now() - state.fetchedAt >= policy.refreshMs) poll()
  }

  const stop = () => {
    clearInterval(pollTimer)
    stopResume?.()
    pollTimer = undefined
    stopResume = undefined
  }

  return {
    key,
    policy,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => {
        if (listeners.delete(listener) && listeners.size === 0) stop()
      }
    },
    refresh,
    retry: () => read(true),
    refreshForSubmit: () => read(true),
  }
}

export interface PortalCapacityRegistry {
  /** The one store for `key`'s bucket, created on first use. */
  store(key: PortalCapacityKey): PortalCapacityStore
}

/** One reference fetch is shared by every store in the registry. */
export function createPortalCapacityRegistry(
  options: PortalCapacityStoreOptions,
): PortalCapacityRegistry {
  const policy = checkedPolicy({ ...DEFAULT_PORTAL_CAPACITY_POLICY, ...options.policy })
  const source =
    options.reference &&
    referenceSource(
      options.reference,
      policy.referenceMaxAgeMs,
      options.monotonic ?? defaultMonotonic(),
    )
  const stores = new Map<string, PortalCapacityStore>()
  return {
    store(bucket) {
      const key = portalCapacityKey(bucket)
      const id = portalCapacityKeyId(key)
      let store = stores.get(id)
      if (!store) {
        store = storeFor(key, options, policy, source)
        stores.set(id, store)
      }
      return store
    },
  }
}
