import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, afterEach, describe, expect, it, vi, beforeAll } from "vitest"
import {
  PendingRegistrationStore,
  ScreeningProvider,
  passThroughScreener,
} from "@obsidion/front-core"
import type { Hex } from "viem"

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex

const depositAddress = vi.fn(async () => ({ address: "0xdeadbeef", name: "alice.oxide.eth" }))
const MANIFEST_TOKEN = "0x00000000000000000000000000000000000000bb"

// Stable identities so `resolveAddress` keeps one identity across renders.
const aztec = { obsidionWallet: {} }
const contracts = { contractService: {} }

const navigate = vi.hoisted(() => vi.fn())
const readL1TokenBalance = vi.hoisted(() => vi.fn(async () => 0n))
const fireEvent = vi.hoisted(() => vi.fn())
vi.mock("../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/analytics")>()),
  fireEvent,
}))
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))
vi.mock("../src/features/deposit/l1DepositTokenBalance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/deposit/l1DepositTokenBalance")>()),
  readL1TokenBalance,
  // The funding sheet reads the wallet's balance on mount; jsdom has no L1 to answer.
  readL1DepositTokenBalance: async () => ({
    raw: 10n ** 21n,
    value: 1000,
    display: "1000 TEST",
    symbol: "TEST",
    decimals: 18,
  }),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => aztec,
  useContractServiceContext: () => contracts,
}))
// One instance, like the real singleton — the screen keys effects off the gateway identity.
// Auto-show only fires on a pool hit; null keeps these tests on the click path.
const pooledDepositAddress = vi.fn<() => Promise<{ address: string; name: string } | null>>(
  async () => null,
)
const gateway = { depositAddress, pooledDepositAddress }
vi.mock("../src/features/deposit/sipaGateway", () => ({ getSipaDepositGateway: () => gateway }))
vi.mock("../src/features/deposit/loadDepositFacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/deposit/loadDepositFacts")>()),
  loadDepositDisplayFacts: async () => ({
    fee: "0.25",
    token: MANIFEST_TOKEN,
    sweepFeeAtomic: 150_000_000_000_000_000n,
    fpcFundingCutAtomic: 100_000_000_000_000_000n,
  }),
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// No WagmiProvider in the test tree; the gate under test never touches the L1 wallet. `connect`
// raises the picker the way RainbowKit's does, in the same render as the click.
const l1 = vi.hoisted(() => ({
  account: null as string | null,
  accounts: [] as string[],
  chainId: null as number | null,
  connecting: false,
  wrongChain: false,
  pickerOpen: false,
  connect: vi.fn(() => {
    l1.pickerOpen = true
  }),
  disconnect: vi.fn(),
}))
vi.mock("../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => l1,
}))
vi.mock("uqr", () => ({
  renderSVG: (value: string) => `<svg data-uri="${value}"></svg>`,
}))
// The DS drags in liquid-glass optics jsdom can't render; this test is about which surface shows.
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
const { applyIdentityOutcome, getPendingStore, runBootDetection } = await import(
  "../src/features/onboarding/webRegistration"
)
const { getConfig } = await import("../src/config/env")
import { seedBootConfig } from "./seedBootConfig"

/**
 * The deposit gates are effectful, not cosmetic: no address may be derived or published while the
 * tag is unconfirmed, and even a settled one derives nothing until the user hits the primary CTA —
 * every derivation costs a proof and a sponsored-broadcast slot.
 */
describe("DepositScreen — claiming gate", () => {
  beforeAll(seedBootConfig)

  let container: HTMLDivElement
  let root: Root

  async function seedPendingClaim() {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    const store = getPendingStore()
    await store.upsert(
      ACCOUNT,
      {},
      {
        tag: "alice",
        nameHash: `0x${"77".repeat(32)}` as Hex,
        l2Address: L2_ADDRESS,
        l1ChainId: 11155111,
        sipaAddress: `0x${"5a".repeat(20)}`,
        depositToken: `0x${"bb".repeat(20)}` as Hex,
        broadcast: true,
        phase: "awaiting_deposit",
        retries: 0,
        startTime: Date.now(),
      },
    )
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1, pending: true })
    return store
  }

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

  /** First visit opens the privacy disclaimer in front of generate / copy / QR. */
  const dismissDisclaimer = () =>
    act(async () => {
      const gotIt = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Got it!",
      )
      gotIt?.click()
    })

  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks keeps implementations; pin the default so a per-test pool hit cannot leak.
    pooledDepositAddress.mockImplementation(async () => null)
    l1.account = null
    l1.pickerOpen = false
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("derives nothing while the tag is unconfirmed, then only on the explicit generate click", async () => {
    const store = await seedPendingClaim()
    await render()

    expect(container.textContent).toContain("still being claimed")
    expect(depositAddress).not.toHaveBeenCalled()

    // Confirmation as detection applies it: the identity write, then the record close whose
    // listener is what re-renders this screen.
    await act(async () => {
      applyIdentityOutcome("confirmed")
      await store.close(ACCOUNT, "confirmed")
    })

    // Settling opens the form but derives nothing — generation waits for the primary CTA click.
    expect(container.textContent).not.toContain("still being claimed")
    expect(depositAddress).not.toHaveBeenCalled()

    const generate = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Generate",
    )
    expect(generate).toBeDefined()
    await act(async () => generate!.click())
    expect(depositAddress).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("0xdeadbeef")
    expect(fireEvent).toHaveBeenCalledWith("deposit_address_shown", { pooled: false })
  })

  it("auto-shows a pooled address on open — no click — but never while the tag is unconfirmed", async () => {
    const store = await seedPendingClaim()
    pooledDepositAddress.mockImplementation(async () => ({
      address: "0xp001ed",
      name: "alice.oxide.eth",
    }))
    await render()

    // The claiming gate holds for the free path too: an unconfirmed name gets no address at all.
    expect(container.textContent).toContain("still being claimed")
    expect(pooledDepositAddress).not.toHaveBeenCalled()

    await act(async () => {
      applyIdentityOutcome("confirmed")
      await store.close(ACCOUNT, "confirmed")
    })

    // A pool hit costs nothing, so the address appears without the Generate click — and the
    // expensive path was never touched.
    expect(container.textContent).toContain("0xp001ed")
    expect(depositAddress).not.toHaveBeenCalled()
    expect(fireEvent).toHaveBeenCalledWith("deposit_address_shown", { pooled: true })
  })

  it("stays shut after a boot that found no record to settle the pending identity", async () => {
    // Fail closed: a missing record is not evidence the name was won, and this screen is where
    // that difference costs a derivation and a broadcast.
    const store = await seedPendingClaim()
    await store.remove(ACCOUNT)
    expect(await runBootDetection({} as never)).toBe("idle")

    await render()
    expect(container.textContent).toContain("still being claimed")
    expect(depositAddress).not.toHaveBeenCalled()
  })

  it("encodes an EIP-681 transfer URI so a wallet scan pre-fills send", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    await render()
    await dismissDisclaimer()

    const generate = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Generate",
    )
    await act(async () => generate!.click())

    const show = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Show"),
    )
    await act(async () => show!.click())
    const gotIt = [...container.querySelectorAll("button")].find((b) => b.textContent === "Got it!")
    await act(async () => gotIt!.click())

    const qr = container.querySelector("[aria-label='Deposit address QR code']")
    expect(qr?.innerHTML).toContain(
      `ethereum:${MANIFEST_TOKEN}@${getConfig().l1ChainId}/transfer?address=0xdeadbeef`,
    )
  })

  it("leaves the deposit screen once the address it handed out is funded", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    vi.useFakeTimers()
    try {
      await render()
      const generate = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Generate",
      )
      await act(async () => generate!.click())

      // An unfunded address is the steady state — the screen stays put.
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(readL1TokenBalance).toHaveBeenCalledWith(MANIFEST_TOKEN, "0xdeadbeef")
      expect(navigate).not.toHaveBeenCalled()

      readL1TokenBalance.mockResolvedValue(5n)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(navigate).toHaveBeenCalledWith("/")
      // The external transfer is the funnel's funded step — bucketed, never the exact amount.
      expect(fireEvent).toHaveBeenCalledWith("deposit_funded", {
        funding: "external",
        amount_bucket: "<5",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("emits deposit_funded once even when two slow polls settle together", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    vi.useFakeTimers()
    try {
      await render()
      const generate = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Generate",
      )
      await act(async () => generate!.click())

      // Two ticks elapse while both reads hang, then both settle funded at once.
      const settlers: Array<(b: bigint) => void> = []
      const hang = () => new Promise<bigint>((resolve) => settlers.push(resolve))
      readL1TokenBalance.mockImplementationOnce(hang).mockImplementationOnce(hang)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(settlers).toHaveLength(2)
      await act(async () => settlers.forEach((s) => s(5n)))

      expect(fireEvent.mock.calls.filter(([e]) => e === "deposit_funded")).toHaveLength(1)
      expect(navigate).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("offers disconnect only while a wallet is connected", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    await render()
    expect(container.textContent).not.toContain("Disconnect")

    l1.account = ACCOUNT
    await render()
    const disconnect = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Disconnect",
    )
    expect(disconnect).toBeDefined()
    await act(async () => disconnect!.click())
    expect(l1.disconnect).toHaveBeenCalledOnce()
  })

  it("carries one connect click through to the funding sheet when the wallet lands", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    // A pool hit gives the sheet an address to fund without the Generate click.
    pooledDepositAddress.mockImplementation(async () => ({
      address: "0xp001ed",
      name: "alice.oxide.eth",
    }))
    await render()

    const connect = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Connect your wallet"),
    )
    expect(connect).toBeDefined()
    await act(async () => connect!.click())

    // The wallet picker is open and there is still nothing to fund from.
    expect(l1.connect).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain("Deposit funds")

    // The account arrives a render later; the held intent opens the sheet with no second click.
    l1.account = ACCOUNT
    await render()
    expect(container.textContent).toContain("Deposit funds")
  })
})
