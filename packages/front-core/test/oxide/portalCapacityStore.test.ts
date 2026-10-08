import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { PortalCapacityUnsupportedError, type PortalCapacitySnapshot } from "@obsidion/sdk"
import {
  createPortalCapacityRegistry,
  createPortalCapacityStore,
  portalCapacityKey,
  portalCapacityKeyId,
  PortalCapacityReadTimeoutError,
  PortalCapacityReferenceError,
  type PortalCapacityKey,
  type PortalCapacityStoreOptions,
  type VisibilitySource,
} from "../../src/oxide/portalCapacityStore"

const T0 = Date.UTC(2026, 8, 25, 12)
const KEY: PortalCapacityKey = portalCapacityKey({
  chainId: 1,
  portal: "0x" + "aa".repeat(20),
  token: "0x" + "bb".repeat(20),
})
const OTHER: PortalCapacityKey = { ...KEY, portal: `0x${"cc".repeat(20)}` }

const snapshot = (over: Partial<PortalCapacitySnapshot> = {}): PortalCapacitySnapshot => ({
  chainId: KEY.chainId,
  portal: KEY.portal,
  token: KEY.token,
  decimals: 18,
  blockNumber: 100n,
  blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
  rateAtomicPerSecond: 7n,
  globalLimitAtomic: 1_000n,
  availableAtomic: 500n,
  ...over,
})

interface Pending {
  key: PortalCapacityKey
  resolve: (s: PortalCapacitySnapshot) => void
  reject: (e: unknown) => void
}

function harness(over: Partial<PortalCapacityStoreOptions> = {}) {
  const pending: Pending[] = []
  const read = vi.fn(
    (key: PortalCapacityKey) =>
      new Promise<PortalCapacitySnapshot>((resolve, reject) =>
        pending.push({ key, resolve, reject }),
      ),
  )
  const resumeListeners = new Set<() => void>()
  let visible = true
  const visibility: VisibilitySource = {
    isVisible: () => visible,
    onResume: (listener) => {
      resumeListeners.add(listener)
      return () => resumeListeners.delete(listener)
    },
  }
  return {
    read,
    pending,
    options: { read, visibility, ...over } as PortalCapacityStoreOptions,
    setVisible(value: boolean) {
      visible = value
      if (value) for (const listener of resumeListeners) listener()
    },
    resumeListeners,
    /** Resolve the oldest open read and let the store apply it. */
    async answer(value: PortalCapacitySnapshot | Error = snapshot()) {
      const next = pending.shift()!
      if (value instanceof Error) next.reject(value)
      else next.resolve(value)
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("portalCapacityKey", () => {
  const tuple = {
    chainId: "11155111",
    portal: "0xAbC0000000000000000000000000000000000001",
    token: "0xDeF0000000000000000000000000000000000002",
    version: "v6",
    deployedAt: "2026-09-01T00:00:00.000Z",
  } as OxideEnvTuple

  it("names one bucket the same way from a manifest tuple and from a deposit's own portal", () => {
    const fromTuple = portalCapacityKey(tuple)
    expect(fromTuple).toEqual({
      chainId: 11155111,
      portal: "0xabc0000000000000000000000000000000000001",
      token: "0xdef0000000000000000000000000000000000002",
    })
    const fromSipa = portalCapacityKey({
      chainId: 11155111,
      portal: "0xABC0000000000000000000000000000000000001",
      token: "0xDEF0000000000000000000000000000000000002",
    })
    expect(portalCapacityKeyId(fromSipa)).toBe(portalCapacityKeyId(fromTuple))
    expect(portalCapacityKeyId(fromTuple)).not.toBe(
      portalCapacityKeyId(portalCapacityKey({ ...tuple, chainId: "1" })),
    )
  })

  it("refuses a missing or malformed field instead of building an unusable key", () => {
    expect(() => portalCapacityKey({ ...tuple, chainId: undefined })).toThrow(/chainId/)
    expect(() => portalCapacityKey({ ...tuple, chainId: "0x1" })).toThrow(/chainId/)
    expect(() => portalCapacityKey({ ...tuple, chainId: 0 })).toThrow(/chainId/)
    expect(() => portalCapacityKey({ ...tuple, chainId: 1.5 })).toThrow(/chainId/)
    expect(() => portalCapacityKey({ ...tuple, portal: "0x1234" })).toThrow(/portal/)
    expect(() => portalCapacityKey({ ...tuple, token: undefined })).toThrow(/token/)
  })
})

describe("createPortalCapacityStore", () => {
  it("starts loading and reads only once something subscribes", async () => {
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    expect(store.getState()).toEqual({ status: "loading", key: KEY })
    expect(h.read).not.toHaveBeenCalled()

    store.subscribe(() => {})
    expect(h.read).toHaveBeenCalledTimes(1)
    await h.answer()
    expect(store.getState()).toMatchObject({
      status: "fresh",
      fetchedAt: T0,
      snapshot: { availableAtomic: 500n },
    })
  })

  it("normalizes a checksummed key and compares the answer without regard to case", async () => {
    const h = harness()
    const upper = (address: string) => `0x${address.slice(2).toUpperCase()}` as const
    const store = createPortalCapacityStore(
      { chainId: KEY.chainId, portal: upper(KEY.portal), token: upper(KEY.token) },
      h.options,
    )
    expect(store.key).toEqual(KEY)
    store.subscribe(() => {})
    await h.answer(snapshot({ portal: upper(KEY.portal), token: upper(KEY.token) }))
    expect(store.getState().status).toBe("fresh")
  })

  it("keeps a read of zero capacity as a fresh value", async () => {
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await h.answer(snapshot({ availableAtomic: 0n }))
    expect(store.getState()).toMatchObject({ status: "fresh", snapshot: { availableAtomic: 0n } })
  })

  it("polls every refresh interval while visible, pauses while hidden and reads on resume", async () => {
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    const unsubscribe = store.subscribe(() => {})
    await h.answer()

    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.read).toHaveBeenCalledTimes(2)
    await h.answer()

    h.setVisible(false)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(h.read).toHaveBeenCalledTimes(2)

    h.setVisible(true)
    expect(h.read).toHaveBeenCalledTimes(3)
    await h.answer()

    unsubscribe()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.read).toHaveBeenCalledTimes(3)
    expect(h.resumeListeners.size).toBe(0)
  })

  it("marks a snapshot stale at the stale age, with or without subscribers", async () => {
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    const listener = vi.fn()
    store.subscribe(listener)()
    await h.answer()
    expect(store.getState().status).toBe("fresh")

    await vi.advanceTimersByTimeAsync(29_999)
    expect(store.getState().status).toBe("fresh")
    await vi.advanceTimersByTimeAsync(1)
    expect(store.getState()).toMatchObject({ status: "stale", reason: "age", fetchedAt: T0 })
  })

  it("reschedules the stale timer when it fires before the clock shows the full age", async () => {
    let offset = 0
    const h = harness({ now: () => Date.now() + offset })
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})()
    await h.answer()
    offset = -1_000 // the wall clock steps back one second

    await vi.advanceTimersByTimeAsync(30_000)
    expect(store.getState().status).toBe("fresh")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getState()).toMatchObject({ status: "stale", reason: "age" })
  })

  it("counts the stale age from the start of a slow read", async () => {
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(19_000)
    await h.answer(snapshot())
    expect(store.getState()).toMatchObject({ status: "fresh", fetchedAt: T0 })
    await vi.advanceTimersByTimeAsync(11_000)
    expect(store.getState()).toMatchObject({ status: "stale", reason: "age", fetchedAt: T0 })
  })

  it("treats a block older than the head limit as stale, at the exact boundary", async () => {
    const blockTimestamp = BigInt((T0 - 60_000) / 1000)
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await h.answer(snapshot({ blockTimestamp }))
    expect(store.getState().status).toBe("fresh")

    const late = harness()
    const other = createPortalCapacityStore(KEY, late.options)
    other.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(1)
    await late.answer(snapshot({ blockTimestamp }))
    expect(other.getState()).toMatchObject({
      status: "stale",
      reason: "head",
      head: { cause: "old", blockAgeMs: 60_001 },
    })

    const relaxed = harness({ policy: { maxHeadAgeMs: Infinity } })
    const local = createPortalCapacityStore(KEY, relaxed.options)
    local.subscribe(() => {})
    await relaxed.answer(snapshot({ blockTimestamp: 1n }))
    expect(local.getState().status).toBe("fresh")
  })

  it("stays fail-closed on its first read when the device clock is ahead, and reports the block age", async () => {
    const h = harness({ now: () => Date.now() + 61_000 })
    const store = createPortalCapacityStore(KEY, h.options)
    const submit = store.refreshForSubmit()
    await h.answer(snapshot())
    expect(await submit).toMatchObject({
      status: "stale",
      reason: "head",
      head: { cause: "old", blockAgeMs: 61_000 },
    })
  })

  it("treats a block number that stops advancing as a stale head, whatever the device clock says", async () => {
    const h = harness({ now: () => Date.now() - 600_000 })
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await h.answer(snapshot({ blockNumber: 100n }))
    expect(store.getState().status).toBe("fresh")

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(15_000)
      await h.answer(snapshot({ blockNumber: 100n }))
    }
    expect(store.getState().status).toBe("fresh") // 60 s without a new block is still within the limit
    await vi.advanceTimersByTimeAsync(15_000)
    await h.answer(snapshot({ blockNumber: 100n }))
    expect(store.getState()).toMatchObject({
      status: "stale",
      reason: "head",
      head: { cause: "stalled" },
    })

    await vi.advanceTimersByTimeAsync(15_000)
    await h.answer(snapshot({ blockNumber: 101n }))
    expect(store.getState().status).toBe("fresh")
  })

  it("does not let an answer from a lagging replica replace a newer block", async () => {
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await h.answer(snapshot({ blockNumber: 200n, availableAtomic: 10n }))

    void store.refresh()
    await h.answer(snapshot({ blockNumber: 199n, availableAtomic: 900n }))
    expect(store.getState()).toMatchObject({
      status: "stale",
      reason: "head",
      head: { cause: "regressed" },
      snapshot: { blockNumber: 200n, availableAtomic: 10n },
    })
  })

  it("settles a read that does not finish in time as unavailable and drops its late answer", async () => {
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(19_999)
    expect(store.getState().status).toBe("loading")
    await vi.advanceTimersByTimeAsync(1)
    const state = store.getState()
    expect(state.status).toBe("unavailable")
    expect(state.status === "unavailable" && state.error).toBeInstanceOf(
      PortalCapacityReadTimeoutError,
    )

    await h.answer(snapshot())
    expect(store.getState().status).toBe("unavailable")
    void store.refresh()
    expect(h.read).toHaveBeenCalledTimes(2)
  })

  it("starts a new read on retry even while one is still running", async () => {
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    const retried = store.retry()
    expect(h.read).toHaveBeenCalledTimes(2)
    const [hung, fresh] = h.pending.splice(0, 2)
    fresh.resolve(snapshot({ availableAtomic: 4n }))
    expect(await retried).toMatchObject({ status: "fresh", snapshot: { availableAtomic: 4n } })
    hung.resolve(snapshot({ availableAtomic: 999n }))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState()).toMatchObject({ snapshot: { availableAtomic: 4n } })
  })

  it("keeps the last snapshot on a failed read, marked unavailable", async () => {
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await h.answer()

    await vi.advanceTimersByTimeAsync(15_000)
    const failure = new Error("rpc down")
    await h.answer(failure)
    expect(store.getState()).toMatchObject({
      status: "unavailable",
      error: failure,
      failedAt: T0 + 15_000,
      lastFetchedAt: T0,
      lastSnapshot: { availableAtomic: 500n },
      lastWasFresh: true,
    })

    void store.refresh()
    await h.answer(new Error("rpc down"))
    expect(store.getState()).toMatchObject({ status: "unavailable", lastWasFresh: true })
  })

  it("marks a failed read's last snapshot not fresh once a stale or unsupported state was published", async () => {
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await h.answer(snapshot({ blockTimestamp: BigInt((T0 - 120_000) / 1000) }))
    expect(store.getState()).toMatchObject({ status: "stale", reason: "head" })
    void store.refresh()
    await h.answer(new Error("rpc down"))
    expect(store.getState()).toMatchObject({
      status: "unavailable",
      lastSnapshot: { availableAtomic: 500n },
      lastWasFresh: false,
    })

    void store.refresh()
    await h.answer(snapshot())
    void store.refresh()
    await h.answer(snapshot({ chainId: 5 }))
    void store.refresh()
    await h.answer(new Error("rpc down"))
    expect(store.getState()).toMatchObject({ status: "unavailable", lastWasFresh: false })

    void store.refresh()
    await h.answer(snapshot())
    await vi.advanceTimersByTimeAsync(30_000)
    expect(store.getState()).toMatchObject({ status: "stale", reason: "age" })
    void store.refresh()
    await h.answer(new Error("rpc down"))
    expect(store.getState()).toMatchObject({ status: "unavailable", lastWasFresh: false })
  })

  it("reports a failed first read as unavailable without any value", async () => {
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await h.answer(new Error("rpc down"))
    const state = store.getState()
    expect(state.status).toBe("unavailable")
    expect(state).not.toHaveProperty("snapshot")
    expect(state).toMatchObject({ lastSnapshot: undefined, lastWasFresh: false })
  })

  it("reports identity mismatches and unsupported portals as unsupported", async () => {
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await h.answer(snapshot({ chainId: 5 }))
    expect(store.getState()).toMatchObject({ status: "unsupported", reason: "chain-mismatch" })

    void store.refresh()
    await h.answer(snapshot({ token: ("0x" + "dd".repeat(20)) as `0x${string}` }))
    expect(store.getState()).toMatchObject({ status: "unsupported", reason: "token-mismatch" })

    void store.refresh()
    await h.answer(new PortalCapacityUnsupportedError("no-capacity-getters", "no data"))
    expect(store.getState()).toMatchObject({ status: "unsupported", reason: "no-capacity-getters" })
  })

  it("joins a running read on refresh", async () => {
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    const first = store.refresh()
    const second = store.refresh()
    expect(h.read).toHaveBeenCalledTimes(1)
    await h.answer()
    expect(await first).toBe(await second)
  })

  describe("refreshForSubmit", () => {
    it("starts a new read instead of joining one already running", async () => {
      const h = harness()
      const store = createPortalCapacityStore(KEY, h.options)
      store.subscribe(() => {})
      expect(h.read).toHaveBeenCalledTimes(1)

      const submit = store.refreshForSubmit()
      expect(h.read).toHaveBeenCalledTimes(2)
      await h.answer(snapshot({ blockNumber: 100n, availableAtomic: 900n }))
      await h.answer(snapshot({ blockNumber: 101n, availableAtomic: 20n }))
      expect(await submit).toMatchObject({ status: "fresh", snapshot: { availableAtomic: 20n } })
    })

    it("resolves to unavailable when the reader throws synchronously", async () => {
      const failure = new Error("no client")
      const store = createPortalCapacityStore(KEY, {
        read: () => {
          throw failure
        },
        visibility: { isVisible: () => true, onResume: () => () => {} },
      })
      await expect(store.refreshForSubmit()).resolves.toMatchObject({
        status: "unavailable",
        error: failure,
      })
    })

    it("never returns a cached fresh result", async () => {
      const h = harness()
      const store = createPortalCapacityStore(KEY, h.options)
      store.subscribe(() => {})
      await h.answer()
      expect(store.getState().status).toBe("fresh")

      const submit = store.refreshForSubmit()
      expect(h.read).toHaveBeenCalledTimes(2)
      await h.answer(new Error("rpc down"))
      expect(await submit).toMatchObject({ status: "unavailable" })
    })

    it("ignores an older read that settles after it", async () => {
      const h = harness()
      const store = createPortalCapacityStore(KEY, h.options)
      store.subscribe(() => {})
      const submit = store.refreshForSubmit()
      const [older, newer] = h.pending.splice(0, 2)
      newer.resolve(snapshot({ blockNumber: 150n, availableAtomic: 1n }))
      await vi.advanceTimersByTimeAsync(0)
      older.reject(new Error("late failure"))
      await vi.advanceTimersByTimeAsync(0)
      expect(await submit).toMatchObject({ status: "fresh", snapshot: { availableAtomic: 1n } })
      expect(store.getState().status).toBe("fresh")
    })
  })
})

describe("published states", () => {
  /** Every state a subscriber is told about, in order. */
  function record(store: ReturnType<typeof createPortalCapacityStore>) {
    const seen: string[] = []
    store.subscribe(() => {
      const state = store.getState()
      seen.push(state.status === "stale" ? `stale:${state.reason}` : state.status)
    })
    return seen
  }

  it("publishes fresh, then stale at the stale age", async () => {
    const h = harness({ policy: { staleAfterMs: 5_000 } })
    const store = createPortalCapacityStore(KEY, h.options)
    const seen = record(store)
    await vi.advanceTimersByTimeAsync(4_999)
    await h.answer(snapshot())
    expect(seen).toEqual(["fresh"])
    await vi.advanceTimersByTimeAsync(1)
    expect(seen).toEqual(["fresh", "stale:age"])
  })

  it.each([5_000, 12_000])(
    "never publishes fresh for a read that arrives %i ms after it started (stale age 5000 ms)",
    async (arrival) => {
      const h = harness({ policy: { staleAfterMs: 5_000 } })
      const store = createPortalCapacityStore(KEY, h.options)
      const seen = record(store)
      await vi.advanceTimersByTimeAsync(arrival)
      await h.answer(snapshot())
      await vi.advanceTimersByTimeAsync(1_000)
      expect(seen).toEqual(["stale:age"])
      expect(store.getState()).toMatchObject({ status: "stale", reason: "age", fetchedAt: T0 })
    },
  )

  it("resolves a submit read that arrives expired as stale", async () => {
    const h = harness({ policy: { staleAfterMs: 5_000 } })
    const store = createPortalCapacityStore(KEY, h.options)
    const seen = record(store)
    const submit = store.refreshForSubmit()
    expect(h.read).toHaveBeenCalledTimes(2) // the subscription's poll, then the submit read
    await vi.advanceTimersByTimeAsync(5_000)
    await h.answer(snapshot())
    await h.answer(snapshot())
    expect(await submit).toMatchObject({ status: "stale", reason: "age" })
    expect(seen).toEqual(["stale:age", "stale:age"])
  })

  it("applies the stale age when the head checks are off for a chain that mines on demand", async () => {
    const early = harness({ policy: { staleAfterMs: 5_000, maxHeadAgeMs: Infinity } })
    const fresh = createPortalCapacityStore(KEY, early.options)
    const freshSeen = record(fresh)
    await vi.advanceTimersByTimeAsync(4_999)
    await early.answer(snapshot({ blockTimestamp: 1n }))
    expect(freshSeen).toEqual(["fresh"])

    const late = harness({ policy: { staleAfterMs: 5_000, maxHeadAgeMs: Infinity } })
    const expired = createPortalCapacityStore(KEY, late.options)
    const expiredSeen = record(expired)
    await vi.advanceTimersByTimeAsync(5_000)
    await late.answer(snapshot({ blockTimestamp: 1n }))
    expect(expiredSeen).toEqual(["stale:age"])
  })

  it("publishes one fresh state for a read under the default policy", async () => {
    const h = harness()
    const store = createPortalCapacityStore(KEY, h.options)
    const seen = record(store)
    await h.answer(snapshot())
    expect(seen).toEqual(["fresh"])
  })
})

describe("reference L1 time", () => {
  const LAG = 300_000
  const seconds = (ms: number) => BigInt(Math.floor(ms / 1000))
  /** The Aztec node's view: the real current L1 time. */
  const liveReference = () =>
    vi.fn(async () => ({ l1ChainId: KEY.chainId, l1Timestamp: seconds(Date.now()) }))
  const flush = () => vi.advanceTimersByTimeAsync(0)
  const states = (store: ReturnType<typeof createPortalCapacityStore>) => {
    const seen: string[] = []
    store.subscribe(() => {
      const state = store.getState()
      seen.push(
        state.status === "stale"
          ? state.reason === "head"
            ? `stale:${state.head.cause}`
            : "stale:age"
          : state.status,
      )
    })
    return seen
  }

  it("marks an advancing but delayed RPC stale while the device clock runs behind by the same amount", async () => {
    const delayed = (blockNumber: bigint) =>
      snapshot({ blockNumber, blockTimestamp: seconds(Date.now() - LAG) })

    // Without a reference, the slow clock hides the delay and every advancing block looks fresh.
    const blind = harness({ now: () => Date.now() - LAG })
    const unguarded = createPortalCapacityStore(KEY, blind.options)
    const blindSeen = states(unguarded)
    await blind.answer(delayed(100n))
    for (const block of [101n, 102n, 103n]) {
      await vi.advanceTimersByTimeAsync(15_000)
      await blind.answer(delayed(block))
    }
    expect(blindSeen.every((seen) => seen === "fresh")).toBe(true)

    const reference = liveReference()
    const h = harness({ now: () => Date.now() - LAG, reference, monotonic: () => Date.now() })
    const store = createPortalCapacityStore(KEY, h.options)
    const seen = states(store)
    await flush()
    await h.answer(delayed(200n))
    expect(store.getState()).toMatchObject({
      status: "stale",
      reason: "head",
      head: { cause: "behind-reference", referenceAgeMs: LAG, blockAgeMs: 0 },
    })
    for (const block of [201n, 202n, 203n]) {
      await vi.advanceTimersByTimeAsync(15_000)
      await flush()
      await h.answer(delayed(block))
    }
    const submit = store.refreshForSubmit()
    await flush()
    await h.answer(delayed(204n))
    expect(await submit).toMatchObject({ status: "stale", head: { cause: "behind-reference" } })
    expect(seen).not.toContain("fresh")
    expect(seen.every((entry) => entry === "stale:behind-reference")).toBe(true)
  })

  it("bounds from below only: a lagging reference never marks a current RPC stale", async () => {
    const reference = vi.fn(async () => ({
      l1ChainId: KEY.chainId,
      l1Timestamp: seconds(Date.now() - 120_000),
    }))
    const h = harness({ reference, monotonic: () => Date.now() })
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await flush()
    await h.answer(snapshot())
    expect(store.getState().status).toBe("fresh")
  })

  it.each([
    [60, "fresh"],
    [61, "stale"],
  ])("with the block %i s behind the reference the state is %s", async (behind, status) => {
    const reference = liveReference()
    const h = harness({ now: () => Date.now() - 120_000, reference, monotonic: () => Date.now() })
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await flush()
    await h.answer(snapshot({ blockTimestamp: seconds(Date.now()) - BigInt(behind) }))
    expect(store.getState().status).toBe(status)
  })

  it.each<[string, () => Promise<unknown>, string]>([
    ["the call fails", async () => Promise.reject(new Error("node down")), "failed"],
    [
      "the node has not synced L1",
      async () => ({ l1ChainId: 1, l1Timestamp: undefined }),
      "unsynced",
    ],
    ["a negative time", async () => ({ l1ChainId: 1, l1Timestamp: -1n }), "invalid"],
    ["a fractional time", async () => ({ l1ChainId: 1, l1Timestamp: 1.5 }), "invalid"],
    ["a string time", async () => ({ l1ChainId: 1, l1Timestamp: "1700000000" }), "invalid"],
    [
      "a time too large for milliseconds",
      async () => ({ l1ChainId: 1, l1Timestamp: 2n ** 60n }),
      "invalid",
    ],
    ["no chain id", async () => ({ l1ChainId: 0, l1Timestamp: 1n }), "invalid"],
    ["not an object", async () => null, "invalid"],
    [
      "another chain",
      async () => ({ l1ChainId: 5, l1Timestamp: seconds(Date.now()) }),
      "chain-mismatch",
    ],
  ])("fails closed when %s", async (_, fetch, reason) => {
    const reference = vi.fn(fetch as never)
    const h = harness({ reference, monotonic: () => Date.now() })
    const store = createPortalCapacityStore(KEY, h.options)
    const seen = states(store)
    await flush()
    const state = store.getState()
    expect(state.status).toBe("unavailable")
    const error = state.status === "unavailable" ? state.error : undefined
    expect(error).toBeInstanceOf(PortalCapacityReferenceError)
    expect(error).toMatchObject({ reason })
    expect(h.read).not.toHaveBeenCalled()
    expect(seen).toEqual(["unavailable"])
  })

  it("accepts a bigint chain id and a safe-integer number time", async () => {
    const reference = vi.fn(async () => ({
      l1ChainId: 1n,
      l1Timestamp: Number(seconds(Date.now())),
    }))
    const h = harness({ reference, monotonic: () => Date.now() })
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await flush()
    await h.answer(snapshot())
    expect(store.getState().status).toBe("fresh")
  })

  it("never caches a failed reference", async () => {
    const reference = vi
      .fn()
      .mockRejectedValueOnce(new Error("node down"))
      .mockImplementation(async () => ({ l1ChainId: 1, l1Timestamp: seconds(Date.now()) }))
    const h = harness({ reference, monotonic: () => Date.now() })
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await flush()
    expect(store.getState().status).toBe("unavailable")
    await vi.advanceTimersByTimeAsync(1_000)
    void store.refresh()
    await flush()
    expect(reference).toHaveBeenCalledTimes(2)
    await h.answer(snapshot())
    expect(store.getState().status).toBe("fresh")
  })

  it("times out a reference that does not answer, without reading capacity", async () => {
    const reference = vi.fn(() => new Promise<never>(() => {}))
    const h = harness({ reference, monotonic: () => Date.now() })
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(20_000)
    const state = store.getState()
    expect(state.status).toBe("unavailable")
    expect(state.status === "unavailable" && state.error).toBeInstanceOf(
      PortalCapacityReadTimeoutError,
    )
    expect(h.read).not.toHaveBeenCalled()
  })

  it("shares one bounded reference fetch across polls and stores", async () => {
    const reference = liveReference()
    const h = harness({
      reference,
      monotonic: () => Date.now(),
      policy: { referenceMaxAgeMs: 20_000 },
    })
    const registry = createPortalCapacityRegistry(h.options)
    registry.store(KEY).subscribe(() => {})
    registry.store(OTHER).subscribe(() => {})
    await flush()
    expect(reference).toHaveBeenCalledTimes(1)
    expect(h.read).toHaveBeenCalledTimes(2)
    await h.answer(snapshot())
    await h.answer(snapshot({ portal: OTHER.portal }))

    await vi.advanceTimersByTimeAsync(15_000) // both polls, 15 s after the fetch started
    expect(reference).toHaveBeenCalledTimes(1)
    await h.answer(snapshot({ blockNumber: 101n }))
    await h.answer(snapshot({ portal: OTHER.portal, blockNumber: 101n }))

    await vi.advanceTimersByTimeAsync(15_000) // 30 s: past referenceMaxAgeMs, so a new fetch
    expect(reference).toHaveBeenCalledTimes(2)
  })

  it("fetches a new reference for a submit or retry read, even with a fresh one shared", async () => {
    let nodeTime = () => seconds(Date.now()) - 30n // a node lagging 30 s: still bounds a current RPC
    const reference = vi.fn(async () => ({ l1ChainId: 1, l1Timestamp: nodeTime() }))
    const h = harness({ reference, monotonic: () => Date.now() })
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await flush()
    await h.answer(snapshot({ blockTimestamp: seconds(Date.now()) - 70n }))
    expect(store.getState().status).toBe("stale") // 70 s behind the device clock: old

    // The submit read must not reuse the shared fetch: the node has since caught up.
    nodeTime = () => seconds(Date.now()) + 0n
    const h2 = harness({ now: () => Date.now() - 120_000, reference, monotonic: () => Date.now() })
    const slowClock = createPortalCapacityStore(KEY, h2.options)
    slowClock.subscribe(() => {})
    await flush()
    await h2.answer(snapshot({ blockTimestamp: seconds(Date.now()) - 50n }))
    expect(slowClock.getState().status).toBe("fresh")
    const calls = reference.mock.calls.length

    nodeTime = () => seconds(Date.now()) + 20n // newer L1 evidence than the shared fetch
    const submit = slowClock.refreshForSubmit()
    await flush()
    expect(reference).toHaveBeenCalledTimes(calls + 1)
    await h2.answer(snapshot({ blockTimestamp: seconds(Date.now()) - 50n }))
    expect(await submit).toMatchObject({
      status: "stale",
      head: { cause: "behind-reference", referenceAgeMs: 70_000 },
    })

    const retried = slowClock.retry()
    await flush()
    expect(reference).toHaveBeenCalledTimes(calls + 2)
    await h2.answer(snapshot({ blockTimestamp: seconds(Date.now()) - 50n }))
    await retried
  })

  it("does not let a reference fetch that started before a submit decide the submit", async () => {
    const answers: ((value: { l1ChainId: number; l1Timestamp: bigint }) => void)[] = []
    const reference = vi.fn(
      () =>
        new Promise<{ l1ChainId: number; l1Timestamp: bigint }>((resolve) => answers.push(resolve)),
    )
    const h = harness({ now: () => Date.now() - 120_000, reference, monotonic: () => Date.now() })
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {}) // a poll whose reference fetch is still running
    await flush()
    const submit = store.refreshForSubmit()
    expect(reference).toHaveBeenCalledTimes(2)

    answers[1]!({ l1ChainId: 1, l1Timestamp: seconds(Date.now()) }) // the submit's own fetch: current
    await flush()
    await h.answer(snapshot({ blockTimestamp: seconds(Date.now()) - 90n }))
    expect(await submit).toMatchObject({ status: "stale", head: { cause: "behind-reference" } })

    answers[0]!({ l1ChainId: 1, l1Timestamp: seconds(Date.now()) - 3_600n }) // the obsolete fetch
    await flush()
    await h.answer(snapshot({ blockTimestamp: seconds(Date.now()) - 90n }))
    expect(store.getState()).toMatchObject({ status: "stale", head: { cause: "behind-reference" } })
  })

  it("refetches when the elapsed-time clock goes backwards", async () => {
    let mono = 1_000
    const reference = liveReference()
    const h = harness({ reference, monotonic: () => mono })
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await flush()
    await h.answer(snapshot())
    mono = 0
    void store.refresh()
    await flush()
    expect(reference).toHaveBeenCalledTimes(2)
  })

  it("never calls the reference while the head checks are off for a chain that mines on demand", async () => {
    const reference = liveReference()
    const h = harness({ reference, policy: { maxHeadAgeMs: Infinity } })
    const store = createPortalCapacityStore(KEY, h.options)
    store.subscribe(() => {})
    await h.answer(snapshot({ blockTimestamp: 1n }))
    expect(store.getState().status).toBe("fresh")
    expect(reference).not.toHaveBeenCalled()
  })
})

describe("policy", () => {
  const read = async () => snapshot()

  it("refuses timer values a timer cannot hold, and accepts Infinity only for the head limit", () => {
    for (const field of [
      "refreshMs",
      "staleAfterMs",
      "readTimeoutMs",
      "referenceMaxAgeMs",
    ] as const) {
      for (const value of [Infinity, NaN, 0, -1, 1.5, 2 ** 31]) {
        expect(() => createPortalCapacityStore(KEY, { read, policy: { [field]: value } })).toThrow(
          field,
        )
        expect(() => createPortalCapacityRegistry({ read, policy: { [field]: value } })).toThrow(
          field,
        )
      }
      expect(() =>
        createPortalCapacityStore(KEY, { read, policy: { [field]: 2 ** 31 - 1 } }),
      ).not.toThrow()
    }
    expect(() =>
      createPortalCapacityStore(KEY, { read, policy: { maxHeadAgeMs: Infinity } }),
    ).not.toThrow()
    expect(() => createPortalCapacityStore(KEY, { read, policy: { maxHeadAgeMs: NaN } })).toThrow(
      "maxHeadAgeMs",
    )
    expect(() => createPortalCapacityStore(KEY, { read, policy: { maxHeadAgeMs: -1 } })).toThrow(
      "maxHeadAgeMs",
    )
  })
})

describe("createPortalCapacityRegistry", () => {
  it("normalizes a checksummed key from the first caller, so every consumer of the bucket can read it", async () => {
    const h = harness()
    const registry = createPortalCapacityRegistry(h.options)
    const checksummed = {
      chainId: KEY.chainId,
      portal: `0x${KEY.portal.slice(2).toUpperCase()}` as const,
      token: `0x${KEY.token.slice(2).toUpperCase()}` as const,
    }
    const first = registry.store(checksummed)
    expect(first.key).toEqual(KEY)
    expect(registry.store(KEY)).toBe(first)

    const submit = first.refreshForSubmit()
    expect(h.pending[0].key).toEqual(KEY)
    await h.answer(snapshot({ token: checksummed.token }))
    expect(await submit).toMatchObject({ status: "fresh" })
  })

  it("shares one store and one request per key", async () => {
    const h = harness()
    const registry = createPortalCapacityRegistry(h.options)
    const a = registry.store(KEY)
    const b = registry.store({ ...KEY, portal: `0x${KEY.portal.slice(2).toUpperCase()}` })
    expect(a).toBe(b)
    a.subscribe(() => {})
    b.subscribe(() => {})
    expect(h.read).toHaveBeenCalledTimes(1)
  })

  it("gives another deployment its own empty store, untouched by the old key's late answer", async () => {
    const h = harness()
    const registry = createPortalCapacityRegistry(h.options)
    const before = registry.store(KEY)
    before.subscribe(() => {})

    const after = registry.store(OTHER)
    expect(after.getState()).toEqual({ status: "loading", key: OTHER })
    after.subscribe(() => {})

    await h.answer(snapshot({ availableAtomic: 999n }))
    expect(after.getState().status).toBe("loading")
    expect(h.pending[0].key).toEqual(OTHER)
    await h.answer(snapshot({ portal: OTHER.portal, availableAtomic: 3n }))
    expect(after.getState()).toMatchObject({ status: "fresh", snapshot: { availableAtomic: 3n } })
    expect(before.getState()).toMatchObject({
      status: "fresh",
      snapshot: { availableAtomic: 999n },
    })
  })
})
