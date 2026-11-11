// @vitest-environment node
/**
 * The pipeline's tasks under the runtime. No config boots here, so every pass fails at its first
 * read, and the backoff each task saves counts the runs it made.
 */
import { createPace } from "@obsidion/core/cadence"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createCatchUp,
  createMilestones,
  createSipaDeposits,
  fixed,
  memoryBackend,
  memoryStore,
  openDatabase,
  startRuntime,
} from "@obsidion/front-core"
import { sipaPipeline } from "../../../../src/features/deposit/sipaTasks"

const BACKOFF_MS = 12_000
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

const stops: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function start() {
  const backend = memoryBackend()
  const db = openDatabase(backend)
  const store = createSipaDeposits({ db, account: true, now: () => Date.now() })
  const catchUp = createCatchUp()
  const milestones = createMilestones({ catchUp })
  const visible = memoryStore(true).readonly
  const custody = memoryStore(false)
  const pipeline = sipaPipeline({
    store,
    registrations: { view: memoryStore({ records: [], loaded: true, failed: false }).readonly },
    db,
    wallet: fixed("wallet", { networkId: "0xnet" } as never),
    keys: fixed("keys", {} as never),
    discovery: () => fixed("discovery", {} as never),
    deployments: () => ({ read: async () => [] } as never),
    account: fixed("account", {} as never),
    token: fixed("token", {} as never),
    milestones,
    visible,
    catchUp,
    custody: custody.readonly,
    contacts: { upsertL1WalletContact: async (input) => input as never },
    refreshBalance: async () => {},
    wakeBroadcasts: () => {},
    upgrades: { directBatches: async () => [] },
    page: {} as never,
  })
  const runtime = startRuntime([pipeline.check, pipeline.scan], {
    db,
    milestones,
    visible,
    pace: createPace(),
    now: () => Date.now(),
  })
  stops.push(
    () => runtime.stop(),
    () => milestones.stop(),
  )
  /** The task's failed runs in a row, as its saved backoff holds them. */
  const failures = (name: string) =>
    Number(backend.entries.get(`runtime/backoff/${name}`)?.split(" ")[0] ?? 0)
  return { pipeline, milestones, custody, failures }
}

describe("sipaPipeline tasks", () => {
  it("backs off a failing full pass after the first balance, and no run between clears it", async () => {
    const h = start()
    await advance(60_000)
    expect(h.failures("sipaScan")).toBe(0)
    h.milestones.mark("firstBalance")
    await advance(0)
    expect(h.failures("sipaScan")).toBe(1)
    await advance(BACKOFF_MS - 1)
    expect(h.failures("sipaScan")).toBe(1)
    await advance(1)
    expect(h.failures("sipaScan")).toBe(2)
    await advance(2 * BACKOFF_MS - 1)
    expect(h.failures("sipaScan")).toBe(2)
    await advance(1)
    expect(h.failures("sipaScan")).toBe(3)
  })

  it("reads L1 only while a screen subscribes to an address or signup holds funds", async () => {
    const h = start()
    await advance(60_000)
    expect(h.failures("sipaCheck")).toBe(0)
    const release = h.pipeline.observedAt.subscribe(() => {})
    await advance(0)
    expect(h.failures("sipaCheck")).toBe(1)
    release()
    await advance(10 * BACKOFF_MS)
    expect(h.failures("sipaCheck")).toBe(1)
    h.custody.set(true)
    await advance(0)
    expect(h.failures("sipaCheck")).toBe(2)
    h.custody.set(false)
    await advance(10 * BACKOFF_MS)
    expect(h.failures("sipaCheck")).toBe(2)
  })

  it("reads within 30 s for a subscriber that arrives during a long run of failed reads", async () => {
    const h = start()
    const release = h.pipeline.observedAt.subscribe(() => {})
    await advance(0)
    // Backoffs of 12, 24 and then 30 s: uncapped, the next would be 96 s.
    for (const ms of [12_000, 24_000, 30_000]) await advance(ms)
    expect(h.failures("sipaCheck")).toBe(4)
    release()
    await advance(1_000)
    h.pipeline.observedAt.subscribe(() => {})
    await advance(29_000 - 1)
    expect(h.failures("sipaCheck")).toBe(4)
    await advance(1)
    expect(h.failures("sipaCheck")).toBe(5)
  })
})
