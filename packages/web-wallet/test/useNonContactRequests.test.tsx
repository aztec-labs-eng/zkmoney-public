/**
 * The inbox hook leaves out requests a send already answered, like Activity does, lists nothing
 * while it cannot check the sends, and drops a request when it expires.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ContactRow, PaymentRequest, Transaction } from "@obsidion/front-core"

const state = vi.hoisted(() => ({
  contacts: [] as ContactRow[],
  contactsHydrated: true,
  contactsFailed: false,
  requests: [] as PaymentRequest[],
  transactions: (async () => []) as () => Promise<Transaction[]>,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useConfigValue: () => ({ value: true, setValue: vi.fn() }),
  useContactsDirectory: () => ({
    contacts: state.contacts,
    hydrated: state.contactsHydrated,
    failed: state.contactsFailed,
  }),
  RequestStorage: {
    get: () => ({ list: async () => state.requests, subscribe: () => () => {} }),
  },
  TransactionStorage: { get: () => ({ getTransactions: () => state.transactions() }) },
}))
vi.mock("../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))

const { globalEventEmitter } = await import("@obsidion/front-core")
const { useNonContactRequests } = await import("../src/features/requests/useNonContactRequests")

const mina: ContactRow = {
  id: "mina",
  name: "mina",
  tag: "mina",
  address: `0x${"0a".repeat(32)}`,
  addressKind: "aztec-l2",
}
const request: PaymentRequest = {
  id: "req-mina",
  contactTag: "mina",
  amount: 12,
  asset: "DAI",
  direction: "incoming",
  status: "pending",
  createdAt: Date.now() - 60_000,
  kind: "contact",
}
const sendFor = (status: "pending" | "success" | "failed") =>
  ({ action: "send", status, requestId: request.id } as unknown as Transaction)

function Probe() {
  const { requests, unavailable } = useNonContactRequests()
  return (
    <>
      <output>{requests.map((r) => r.id).join(",")}</output>
      <data>{String(unavailable)}</data>
    </>
  )
}

let container: HTMLDivElement
let root: Root
const render = () => act(async () => root.render(<Probe />))
const listed = () => container.querySelector("output")!.textContent
const unavailable = () => container.querySelector("data")!.textContent
const refresh = () => act(async () => globalEventEmitter.emitTransactionsUpdated())
const failingRead = async (): Promise<Transaction[]> => {
  throw new Error("transaction read failed")
}

beforeEach(() => {
  state.contacts = [mina]
  state.contactsHydrated = true
  state.contactsFailed = false
  state.requests = [request]
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each(["pending", "success"] as const)(
  "keeps a request a %s send answered out after its contact is removed, until the send fails",
  async (status) => {
    let transactions = [sendFor(status)]
    state.transactions = async () => transactions
    await render()
    expect(listed()).toBe("")

    state.contacts = []
    await render()
    expect(listed()).toBe("")

    transactions = [sendFor("failed")]
    await refresh()
    expect(listed()).toBe(request.id)
  },
)

it("lists nothing before the transactions load", async () => {
  state.contacts = []
  state.transactions = () => new Promise(() => {})
  await render()
  expect(listed()).toBe("")
})

it("lists nothing and reports unavailable when the first read fails, then recovers on retry", async () => {
  vi.useFakeTimers()
  vi.spyOn(console, "warn").mockImplementation(() => {})
  state.contacts = []
  state.transactions = failingRead
  await render()
  expect([listed(), unavailable()]).toEqual(["", "true"])

  state.transactions = async () => []
  await act(() => vi.advanceTimersByTimeAsync(5_000))
  expect([listed(), unavailable()]).toEqual([request.id, "false"])
})

it.each(["pending", "success"] as const)(
  "keeps a request a %s send answered hidden through a failed refresh and after recovery",
  async (status) => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    state.contacts = []
    let read: () => Promise<Transaction[]> = async () => [sendFor(status)]
    state.transactions = () => read()
    await render()
    expect([listed(), unavailable()]).toEqual(["", "false"])

    read = failingRead
    await refresh()
    expect([listed(), unavailable()]).toEqual(["", "true"])

    read = async () => [sendFor(status)]
    await refresh()
    expect([listed(), unavailable()]).toEqual(["", "false"])
  },
)

it("stops retrying once unmounted, even when a read fails after the unmount", async () => {
  vi.useFakeTimers()
  vi.spyOn(console, "warn").mockImplementation(() => {})
  let reject!: (error: Error) => void
  const read = vi.fn(() => new Promise<Transaction[]>((_, rejectRead) => (reject = rejectRead)))
  state.transactions = read
  await render()
  await act(async () => root.unmount())
  await act(async () => reject(new Error("transaction read failed")))
  await act(() => vi.advanceTimersByTimeAsync(20_000))
  expect(read).toHaveBeenCalledOnce()
  root = createRoot(container)
})

it("does not apply a read that a later read overtook", async () => {
  state.contacts = []
  const reads: Array<(rows: Transaction[]) => void> = []
  state.transactions = () => new Promise((resolve) => reads.push(resolve))
  await render()
  await refresh()
  await act(async () => reads[1]!([sendFor("pending")]))
  await act(async () => reads[0]!([]))
  expect(listed()).toBe("")
})

it("reports unavailable while the contacts cannot be read", async () => {
  state.contacts = []
  state.contactsHydrated = false
  state.contactsFailed = true
  state.transactions = async () => []
  await render()
  expect([listed(), unavailable()]).toEqual(["", "true"])
})

it("lists nothing and reports unavailable when a contacts read fails after one succeeded, until a read lands", async () => {
  state.contacts = []
  state.transactions = async () => []
  await render()
  expect([listed(), unavailable()]).toEqual([request.id, "false"])

  state.contactsFailed = true
  await render()
  expect([listed(), unavailable()]).toEqual(["", "true"])

  state.contactsFailed = false
  await render()
  expect([listed(), unavailable()]).toEqual([request.id, "false"])
})

it("drops a request when it expires, with no other update", async () => {
  vi.useFakeTimers()
  state.contacts = []
  state.transactions = async () => []
  state.requests = [{ ...request, expiresAt: Date.now() + 1_000 }]
  await render()
  expect(listed()).toBe(request.id)

  await act(() => vi.advanceTimersByTimeAsync(1_001))
  expect(listed()).toBe("")
})
