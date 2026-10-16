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
}))

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
  bootPriority: { whenBalanceSettled: async () => {} },
  startRequestFulfillmentReconciler: () => () => {},
  createTagForwardResolver: () => ({}),
  createWalletSyncSource: () => ({}),
  WalletSyncCoordinator: class {
    start = h.start
    stop = h.stop
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

  it("rescans Main on its own, and Savings after it once Savings' deployment resolves", async () => {
    let resolveSavings!: (token: unknown) => void
    h.savingsToken.mockReturnValueOnce(new Promise((resolve) => (resolveSavings = resolve)))
    await act(async () => {
      root.render(<TransferScannerMount />)
    })
    await vi.waitFor(() => expect(h.rescan).toHaveBeenCalledTimes(1))
    expect(h.rescan.mock.calls[0][1]).toHaveLength(1)
    const savings = { label: "sUSDS" }
    await act(async () => resolveSavings(savings))
    await vi.waitFor(() => expect(h.rescan).toHaveBeenCalledTimes(2))
    expect(h.rescan.mock.calls[1][1]).toEqual([savings])
  })

  it("tries the Savings scan again after its lookup fails, without touching Main's", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      h.savingsToken.mockRejectedValueOnce(new Error("timed out after 20000ms"))
      const savings = { label: "sUSDS" }
      h.savingsToken.mockResolvedValueOnce(savings)
      await act(async () => {
        root.render(<TransferScannerMount />)
      })
      await vi.waitFor(() => expect(h.rescan).toHaveBeenCalledTimes(1))
      await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)))
      await vi.waitFor(() => expect(h.rescan).toHaveBeenCalledTimes(2))
      expect(h.rescan.mock.calls[1][1]).toEqual([savings])
      expect(h.savingsToken).toHaveBeenCalledTimes(2)
    } finally {
      vi.mocked(console.warn).mockRestore()
      vi.useRealTimers()
    }
  })
})
