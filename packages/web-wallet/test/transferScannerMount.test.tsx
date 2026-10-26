import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const NETWORK_ID = `0x${"a".repeat(40)}`

const h = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  fetchTokenInformation: vi.fn(),
  rescan: vi.fn(async (_wallet: unknown, _tokens: unknown[]) => [] as unknown[]),
  savingsToken: vi.fn(async (): Promise<unknown> => undefined),
  whenReady: vi.fn(async (_reader: string) => {}),
  refreshBalance: vi.fn(async () => {}),
  syncSource: undefined as unknown,
}))

/** The Savings token as the lookup answers it: its deployment's label and its service. */
const savingsOf = (balance: bigint) => ({
  label: "sUSDS",
  tokenService: { tokenAddress: "0xsav", readBalanceAssumingSynced: async () => balance },
})

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => ({ obsidionWallet: {}, currentNetwork: { type: "testnet" } }),
  useAccountContext: () => ({ obsidionAccount: {} }),
  useAssetContext: () => ({
    tokenService: {
      fetchTokenInformation: h.fetchTokenInformation,
      readBalanceAssumingSynced: async () => 0n,
      account: { getCompleteAddress: () => ({ toString: () => "0xcomplete" }) },
    },
  }),
  useContractServiceContext: () => ({ contractService: {} }),
  getActiveNetworkId: () => NETWORK_ID,
  bootPriority: { whenReady: h.whenReady },
  startRequestFulfillmentReconciler: () => () => {},
  createTagForwardResolver: () => ({}),
  createWalletSyncSource: (deps: unknown) => ((h.syncSource = deps), {}),
  WalletSyncCoordinator: class {
    start = h.start
    stop = h.stop
    static refreshBalance = h.refreshBalance
  },
  BalanceStorage: { get: () => ({}) },
  ContactStorage: { get: () => ({}) },
  RequestStorage: { get: () => ({}) },
  TransactionStorage: { get: () => ({}) },
  WithdrawalStorage: { get: () => ({}) },
}))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ nodeEndpointDigest: "digest" }) }))
vi.mock("../src/features/contacts/registryResolution", () => ({
  resolveTagForCommit: async () => undefined,
}))
vi.mock("../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ address: "0xaccount", handle: "alice" }),
}))
vi.mock("../src/features/withdraw/withdrawGateway", () => ({ rescanWithdrawals: h.rescan }))
vi.mock("../src/features/savings/savingsGateway", () => ({
  savingsRescanToken: () => h.savingsToken(),
}))
vi.mock("../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
vi.mock("../src/platform/xmtp/adapters", () => ({ createContactsByL2: () => ({}) }))

const { TransferScannerMount } = await import("../src/platform/transactions/TransferScannerMount")

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  h.whenReady.mockImplementation(async () => {})
  h.savingsToken.mockImplementation(async () => undefined)
  h.syncSource = undefined
  // jsdom reports a hidden document; the mount only scans while visible.
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  // The setup's Web Locks polyfill takes no options; without locks the mount scans directly.
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined })
  h.fetchTokenInformation.mockResolvedValue({ address: "0xtoken", symbol: "DAI", decimals: 18 })
  h.start.mockResolvedValue(undefined)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("TransferScannerMount", () => {
  it("scans under the active network id and the node's endpoint scope", async () => {
    await act(async () => {
      root.render(<TransferScannerMount />)
    })
    await vi.waitFor(() => expect(h.start).toHaveBeenCalled())

    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.start.mock.calls[0][0]).toMatchObject({
      accountAddress: "0xaccount",
      accountTag: "alice",
      networkId: NETWORK_ID,
      endpointScope: "digest",
    })
  })

  it("rescans Main's withdrawals only; Savings' burns are rebuilt with its moves", async () => {
    h.savingsToken.mockResolvedValue(savingsOf(0n))
    await act(async () => {
      root.render(<TransferScannerMount />)
    })
    await vi.waitFor(() => expect(h.refreshBalance).toHaveBeenCalledTimes(1))
    expect(h.rescan).toHaveBeenCalledTimes(1)
    expect(h.rescan.mock.calls[0][1]).toHaveLength(1)
    expect(h.rescan.mock.calls[0][1]).not.toContainEqual(
      expect.objectContaining({ label: "sUSDS" }),
    )
  })

  it("looks Savings up at its boot stage and reads its shares, rescanning Main at its own stage", async () => {
    const gates = new Map<string, () => void>()
    h.whenReady.mockImplementation(
      (reader: string) => new Promise<void>((resolve) => gates.set(reader, resolve)),
    )
    h.savingsToken.mockResolvedValue(savingsOf(7n))
    await act(async () => {
      root.render(<TransferScannerMount />)
    })
    expect(h.savingsToken).not.toHaveBeenCalled()
    await act(async () => gates.get("savings")!())
    await vi.waitFor(() => expect(h.refreshBalance).toHaveBeenCalledTimes(1))
    expect(h.savingsToken).toHaveBeenCalledTimes(1)
    expect(h.rescan).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(h.syncSource).toBeDefined())
    const { readBalances } = h.syncSource as { readBalances: () => Promise<unknown> }
    expect(await readBalances()).toEqual({ "0xtoken": 0n, "0xsav": 7n })
    await act(async () => gates.get("withdrawalRescan")!())
    await vi.waitFor(() => expect(h.rescan).toHaveBeenCalledTimes(1))
    expect(h.savingsToken).toHaveBeenCalledTimes(1)
  })

  it("keeps Main's balance when the Savings shares cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    h.savingsToken.mockResolvedValue({
      label: "sUSDS",
      tokenService: {
        tokenAddress: "0xsav",
        readBalanceAssumingSynced: async () => Promise.reject(new Error("not registered")),
      },
    })
    await act(async () => {
      root.render(<TransferScannerMount />)
    })
    await vi.waitFor(() => expect(h.refreshBalance).toHaveBeenCalled())
    await vi.waitFor(() => expect(h.syncSource).toBeDefined())
    const { readBalances } = h.syncSource as { readBalances: () => Promise<unknown> }
    expect(await readBalances()).toEqual({ "0xtoken": 0n })
    vi.mocked(console.warn).mockRestore()
  })

  it("tries the Savings lookup again while it fails, then reads Savings, Main's untouched", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      const savings = savingsOf(0n)
      let up = false
      h.savingsToken.mockImplementation(async () => {
        if (!up) throw new Error("timed out after 20000ms")
        return savings
      })
      await act(async () => {
        root.render(<TransferScannerMount />)
      })
      await vi.waitFor(() => expect(h.rescan).toHaveBeenCalledTimes(1))
      expect(h.refreshBalance).not.toHaveBeenCalled()
      up = true
      await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)))
      await vi.waitFor(() => expect(h.refreshBalance).toHaveBeenCalledTimes(1))
      expect(h.rescan).toHaveBeenCalledTimes(1)
      expect(h.savingsToken).toHaveBeenCalledTimes(2)
    } finally {
      vi.mocked(console.warn).mockRestore()
      vi.useRealTimers()
    }
  })
})
