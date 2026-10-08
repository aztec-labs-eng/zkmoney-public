import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const NETWORK_ID = `0x${"a".repeat(40)}`

const h = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  fetchTokenInformation: vi.fn(),
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => ({ obsidionWallet: {}, currentNetwork: { type: "testnet" } }),
  useAssetContext: () => ({
    tokenService: {
      fetchTokenInformation: h.fetchTokenInformation,
      readBalanceAssumingSynced: async () => 0n,
      account: { getCompleteAddress: () => ({ toString: () => "0xcomplete" }) },
    },
  }),
  useContractServiceContext: () => ({ contractService: {} }),
  getActiveNetworkId: () => NETWORK_ID,
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
vi.mock("../src/features/withdraw/withdrawGateway", () => ({ rescanWithdrawals: async () => {} }))
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
})
