/** A resolver payment recorded while a sync pass runs gets a pass of its own once that one ends. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  passes: [] as ((result: unknown) => void)[],
  onFunded: undefined as (() => void) | undefined,
  booted: Promise.resolve() as Promise<void>,
  watching: Promise.resolve() as Promise<void>,
}))

vi.mock("@obsidion/front-core", () => ({
  SIPADepositStore: { get: () => ({}) },
  RequestStorage: { get: () => ({}) },
  bootPriority: {
    whenReady: (reader: string) => (reader === "deposits" ? h.booted : h.watching),
    depositProgress: () => undefined,
    depositsReplayed: () => undefined,
  },
  reconcileSipaRequestFulfillments: async () => undefined,
  useAztecContext: () => ({ obsidionWallet: {} }),
  useAssetContext: () => ({ tokenService: {} }),
  useCachedRecords: () => ({ records: [] }),
}))
vi.mock("../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
vi.mock("../src/platform/visibilityScheduler", () => ({ whenVisibilityChanges: () => () => {} }))
vi.mock("../src/lib/analytics", () => ({ fireEvent: () => undefined }))
const gateway = {
  warm: async () => undefined,
  sync: vi.fn(() => new Promise((resolve) => h.passes.push(resolve))),
  resolverPayments: vi.fn((onFunded: () => void) => {
    h.onFunded = onFunded
    return { tick: async () => 12_000 }
  }),
}
vi.mock("../src/features/deposit/sipaGateway", () => ({ getSipaDepositGateway: () => gateway }))

const { useSipaDeposits } = await import("../src/features/deposit/useSipaDeposits")

const IDLE = { active: 0, failed: 0 }

function Probe() {
  useSipaDeposits()
  return null
}

describe("useSipaDeposits wake", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    h.passes.length = 0
    h.booted = Promise.resolve()
    h.watching = Promise.resolve()
    h.onFunded = undefined
    gateway.sync.mockClear()
    gateway.resolverPayments.mockClear()
    vi.useFakeTimers()
    container = document.createElement("div")
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
  })

  it("runs another pass at once when a payment lands mid-pass", async () => {
    await act(async () => root.render(<Probe />))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(gateway.sync).toHaveBeenCalledTimes(1)

    h.onFunded!()
    await act(async () => h.passes[0]!(IDLE))
    await act(() => vi.advanceTimersByTimeAsync(0))

    expect(gateway.sync).toHaveBeenCalledTimes(2)
  })

  it("starts the resolver watcher at its boot stage", async () => {
    let reached!: () => void
    h.watching = new Promise((resolve) => (reached = resolve))
    await act(async () => root.render(<Probe />))
    expect(gateway.resolverPayments).not.toHaveBeenCalled()
    await act(async () => reached())
    expect(gateway.resolverPayments).toHaveBeenCalledTimes(1)
  })

  it("runs no extra pass for a payment recorded while the first pass waits on boot", async () => {
    let boot!: () => void
    h.booted = new Promise((resolve) => (boot = resolve))
    await act(async () => root.render(<Probe />))
    h.onFunded!()
    await act(async () => boot())
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(gateway.sync).toHaveBeenCalledTimes(1)
    await act(async () => h.passes[0]!(IDLE))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(gateway.sync).toHaveBeenCalledTimes(1)
  })
})
