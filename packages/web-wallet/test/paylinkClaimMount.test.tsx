import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  networkId: undefined as string | undefined,
  rebuildPaylinks: vi.fn(),
  reconcile: vi.fn(),
  fetchTokenInformation: vi.fn(),
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => ({ obsidionWallet: {} }),
  useAccountContext: () => ({
    obsidionAccount: { getAddress: () => ({ toString: () => "0xaccount" }) },
    getSecretKey: async () => "0xsecret",
  }),
  useAssetContext: () => ({ tokenService: { fetchTokenInformation: h.fetchTokenInformation } }),
  useContractServiceContext: () => ({ contractService: {} }),
  getActiveNetworkId: () => h.networkId,
  rebuildPaylinks: h.rebuildPaylinks,
  createTransferEventSource: () => ({}),
  bootPriority: { whenBalanceSettled: async () => {} },
  checkSpentViaPaylinkService: () => async () => new Map(),
  PaylinkClaimReconciler: class {
    reconcile = h.reconcile
    reconcileTxHash = async () => {}
  },
  TransactionStorage: { get: () => ({}) },
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  PaylinkService: class {},
}))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ nodeEndpointDigest: "digest" }) }))
vi.mock("../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))

const { PaylinkClaimMount } = await import("../src/features/notifications/PaylinkClaimMount")

const NETWORK_ID = `0x${"a".repeat(40)}`

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  h.networkId = undefined
  h.fetchTokenInformation.mockResolvedValue({ address: "0xtoken", symbol: "DAI", decimals: 18 })
  h.rebuildPaylinks.mockResolvedValue([])
  h.reconcile.mockResolvedValue(undefined)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Mount and wait for the first pass: the sweep runs once the rescan has settled. */
async function mount() {
  await act(async () => {
    root.render(<PaylinkClaimMount />)
  })
  await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalled())
}

describe("PaylinkClaimMount", () => {
  it("rebuilds sent paylinks under the active network id", async () => {
    h.networkId = NETWORK_ID
    await mount()

    expect(h.rebuildPaylinks).toHaveBeenCalledTimes(1)
    expect(h.rebuildPaylinks.mock.calls[0][0]).toMatchObject({
      networkId: NETWORK_ID,
      endpointScope: "digest",
    })
  })

  it("skips the rebuild, and says so, while no network id is pinned", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await mount()

    expect(h.rebuildPaylinks).not.toHaveBeenCalled()
    expect(h.fetchTokenInformation).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no active network id"))
    warn.mockRestore()
  })
})
