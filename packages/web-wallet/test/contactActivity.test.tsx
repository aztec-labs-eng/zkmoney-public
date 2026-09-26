import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  transactions: vi.fn(),
  requests: vi.fn(),
  deposits: vi.fn(),
  withdrawals: vi.fn(),
  listeners: new Map<string, () => void>(),
  off: vi.fn(),
}))
const subscribe = (name: string, listener: () => void) => {
  mocks.listeners.set(name, listener)
  return () => {
    mocks.listeners.delete(name)
    mocks.off(name)
  }
}
vi.mock("@obsidion/front-core", () => ({
  TransactionStorage: { get: () => ({ getTransactions: mocks.transactions }) },
  RequestStorage: {
    get: () => ({ list: mocks.requests, subscribe: (fn: () => void) => subscribe("requests", fn) }),
  },
  globalEventEmitter: {
    onTransactionsUpdated: (fn: () => void) => mocks.listeners.set("transactions", fn),
    offTransactionsUpdated: () => {
      mocks.listeners.delete("transactions")
      mocks.off("transactions")
    },
  },
}))
vi.mock("../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
vi.mock("../src/features/deposit/sipaGateway", () => ({
  getSipaDepositGateway: () => ({
    records: mocks.deposits,
    subscribe: (fn: () => void) => subscribe("deposits", fn),
  }),
}))
vi.mock("../src/features/withdraw/withdrawGateway", () => ({
  getWithdrawalStore: () => ({
    load: async () => {},
    list: mocks.withdrawals,
    onListChanged: (fn: () => void) => subscribe("withdrawals", fn),
  }),
}))
import { useContactActivity } from "../src/features/contacts/useContactActivity"

let current: ReturnType<typeof useContactActivity>
function Probe({ enabled = true }: { enabled?: boolean }) {
  current = useContactActivity(enabled)
  return null
}
let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.clearAllMocks()
  mocks.listeners.clear()
  mocks.transactions.mockResolvedValue([])
  mocks.requests.mockResolvedValue([])
  mocks.deposits.mockReturnValue([])
  mocks.withdrawals.mockReturnValue([])
  host = document.createElement("div")
  root = createRoot(host)
})
afterEach(() => act(() => root.unmount()))

describe("Contacts activity subscription", () => {
  it("hydrates all sources, responds to each source, and unsubscribes on unmount", async () => {
    await act(async () => root.render(<Probe />))
    expect(mocks.listeners.size).toBe(4)
    for (const name of ["transactions", "requests", "deposits", "withdrawals"]) {
      const before = mocks.transactions.mock.calls.length
      await act(async () => mocks.listeners.get(name)!())
      expect(mocks.transactions.mock.calls.length).toBe(before + 1)
    }
    expect(current).toEqual({ transactions: [], requests: [], sipaDeposits: [], withdrawals: [] })
    await act(async () => root.render(null))
    expect(mocks.listeners.size).toBe(0)
    expect(mocks.off).toHaveBeenCalledTimes(4)
  })
  it("ignores an older hydration that finishes after a newer activity update", async () => {
    let resolve!: (value: unknown[]) => void
    mocks.transactions.mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes
      }),
    )
    await act(async () => root.render(<Probe />))
    mocks.transactions.mockResolvedValue([{ timestamp: 20 }])
    await act(async () => mocks.listeners.get("transactions")!())
    await act(async () => resolve([{ timestamp: 10 }]))
    expect(current.transactions).toEqual([{ timestamp: 20 }])
  })
  it("does not subscribe or hydrate for the unchanged desktop directory", async () => {
    await act(async () => root.render(<Probe enabled={false} />))
    expect(mocks.listeners.size).toBe(0)
    expect(mocks.transactions).not.toHaveBeenCalled()
  })
})
