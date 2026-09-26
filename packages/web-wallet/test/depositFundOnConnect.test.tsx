/**
 * A funding click made while disconnected is held until the wallet picker answers. The picker only
 * reports through the account it produces, so the hold has to end with the picker: a dismissed or
 * failed attempt must not turn a wallet that connects later, on its own, into an open funding sheet.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import type { Hex } from "viem"

const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const ACCOUNT = `0x${"a1".repeat(20)}` as Hex
const MANIFEST_TOKEN = "0x00000000000000000000000000000000000000bb"

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}))
vi.mock("../src/features/deposit/l1DepositTokenBalance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/deposit/l1DepositTokenBalance")>()),
  readL1TokenBalance: vi.fn(async () => 0n),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => ({ obsidionWallet: {} }),
  useContractServiceContext: () => ({ contractService: {} }),
}))
// A pool hit gives the sheet an address to fund without the Generate click.
const gateway = {
  depositAddress: vi.fn(async () => ({ address: "0xdeadbeef", name: "alice.oxide.eth" })),
  pooledDepositAddress: vi.fn(async () => ({ address: "0xp001ed", name: "alice.oxide.eth" })),
}
vi.mock("../src/features/deposit/sipaGateway", () => ({ getSipaDepositGateway: () => gateway }))
vi.mock("../src/features/deposit/loadDepositFacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/deposit/loadDepositFacts")>()),
  loadDepositDisplayFacts: vi.fn(async () => ({
    fee: "0.35",
    token: MANIFEST_TOKEN,
    sweepFeeAtomic: 250_000_000_000_000_000n,
    fpcFundingCutAtomic: 100_000_000_000_000_000n,
  })),
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("../src/lib/analytics", () => ({
  fireEvent: vi.fn(),
  failureCode: () => "x",
  lapTimer: () => () => 0,
  amountBucket: () => "b",
}))
const bridge = vi.hoisted(() => ({ active: false }))
vi.mock("../src/platform/desktopBridge", () => ({ isDesktopL1SubmitActive: () => bridge.active }))
// Which surface shows is the question; the sheet's own behaviour has its own suite.
vi.mock("../src/features/deposit/DepositFromWalletModal", () => ({
  DepositFromWalletModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="fund-sheet">
      <button type="button" onClick={onClose}>
        close-sheet
      </button>
    </div>
  ),
}))
// No WagmiProvider in the test tree. `connect` raises the picker in the same render as the click,
// as RainbowKit's `openConnectModal` does; the tests move the rest of the lifecycle by hand.
const l1 = vi.hoisted(() => ({
  account: null as Hex | null,
  accounts: [] as Hex[],
  chainId: null as number | null,
  connecting: false,
  wrongChain: false,
  pickerOpen: false,
  connect: vi.fn(async () => {
    l1.pickerOpen = true
  }),
  disconnect: vi.fn(),
}))
vi.mock("../src/features/deposit/l1Wallet", () => ({ useL1Wallet: () => l1 }))
vi.mock("uqr", () => ({ renderSVG: (value: string) => `<svg data-uri="${value}"></svg>` }))
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {title}
    </button>
  ),
  Spinner: () => null,
  TopNavIconButton: () => null,
}))

const { DepositScreen } = await import("../src/features/deposit/DepositScreen")
const { saveWalletIdentity } = await import("../src/features/identity/walletIdentity")
import { seedBootConfig } from "./seedBootConfig"

describe("DepositScreen — funding click held across the wallet picker", () => {
  beforeAll(seedBootConfig)

  let container: HTMLDivElement
  let root: Root

  const sheets = () => container.querySelectorAll("[data-testid='fund-sheet']").length
  const buttonContaining = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text))

  /** First call mounts; later calls re-render the screen against the mutated `l1`. */
  const render = () =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <ScreeningProvider screener={passThroughScreener}>
            <DepositScreen />
          </ScreeningProvider>
        </MemoryRouter>,
      )
    })

  const clickConnect = async () => {
    const connect = buttonContaining("Connect your wallet")
    expect(connect?.disabled).toBe(false)
    await act(async () => connect!.click())
  }

  /** The wallet connects: wagmi's account lands first, RainbowKit closes its picker off that. */
  const walletLands = () => {
    l1.account = ACCOUNT
    l1.accounts = [ACCOUNT]
  }
  const pickerCloses = () => {
    l1.pickerOpen = false
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    l1.account = null
    l1.accounts = []
    l1.pickerOpen = false
    bridge.active = false
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("drops the click when the picker is dismissed, so a later connection opens nothing", async () => {
    await render()
    await clickConnect()
    expect(l1.connect).toHaveBeenCalledOnce()
    expect(l1.pickerOpen).toBe(true)
    expect(sheets()).toBe(0)

    pickerCloses()
    await render()
    expect(sheets()).toBe(0)

    // Restored from storage, or connected from another screen: not this click's wallet.
    walletLands()
    await render()
    expect(sheets()).toBe(0)
    expect(container.textContent).toContain("Wallet connected")
  })

  it("drops the click when the attempt fails and the picker is then closed", async () => {
    await render()
    await clickConnect()

    // The wallet refused: wagmi is back to disconnected, the picker still up with its error.
    l1.connecting = true
    await render()
    l1.connecting = false
    await render()
    expect(sheets()).toBe(0)

    pickerCloses()
    await render()
    walletLands()
    await render()
    expect(sheets()).toBe(0)
  })

  it("opens the sheet once when the wallet lands before the picker closes", async () => {
    await render()
    await clickConnect()

    walletLands()
    await render()
    expect(sheets()).toBe(1)

    pickerCloses()
    await render()
    expect(sheets()).toBe(1)
    expect(l1.connect).toHaveBeenCalledOnce()

    // Closing the sheet is final: nothing held is left to reopen it.
    await act(async () => buttonContaining("close-sheet")!.click())
    expect(sheets()).toBe(0)
    await render()
    expect(sheets()).toBe(0)
  })

  it("opens the sheet once when the wallet lands and the picker closes in one render", async () => {
    await render()
    await clickConnect()

    walletLands()
    pickerCloses()
    await render()
    expect(sheets()).toBe(1)
    expect(l1.connect).toHaveBeenCalledOnce()
  })

  it("honours a fresh click after a dismissed one", async () => {
    await render()
    await clickConnect()
    pickerCloses()
    await render()

    await clickConnect()
    expect(l1.connect).toHaveBeenCalledTimes(2)
    expect(l1.pickerOpen).toBe(true)

    walletLands()
    await render()
    expect(sheets()).toBe(1)
  })

  it("funds straight away from a connected wallet, and on the desktop bridge", async () => {
    walletLands()
    await render()
    await act(async () => buttonContaining("Wallet connected")!.click())
    expect(sheets()).toBe(1)
    expect(l1.connect).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    root = createRoot(container)
    l1.account = null
    l1.accounts = []
    bridge.active = true
    await render()
    await act(async () => buttonContaining("Deposit from your browser")!.click())
    expect(sheets()).toBe(1)
    expect(l1.connect).not.toHaveBeenCalled()
  })
})
