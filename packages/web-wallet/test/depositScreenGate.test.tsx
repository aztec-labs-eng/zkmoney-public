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
import type { DepositAddress } from "../src/features/deposit/sipaGateway"

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex

/** The pool reads empty (the open's limit-0 read refuses), and the coin row derives. */
const resolveDefault = async (...args: unknown[]): Promise<DepositAddress> => {
  if ((args[3] as { publishingLimit?: number } | undefined)?.publishingLimit === 0) {
    throw new AddressesPublishingError()
  }
  return { address: "0xdeadbeef", name: "alice.oxide.eth" }
}
const depositAddress = vi.fn<(...args: unknown[]) => Promise<DepositAddress>>(resolveDefault)
const MANIFEST_TOKEN = "0x00000000000000000000000000000000000000bb"
const CREATING = "Creating your address..."

// Stable identities so `resolveAddress` keeps one identity across renders.
const aztec = { obsidionWallet: {} }
const contracts = { contractService: {} }

const navigate = vi.hoisted(() => vi.fn())
const readL1TokenBalance = vi.hoisted(() => vi.fn(async () => 0n))
const fireEvent = vi.hoisted(() => vi.fn())
// Plenty of shared capacity, read from a fake bucket instead of the network.
const capacity = vi.hoisted(() => ({ availableAtomic: 40_000n * 10n ** 18n }))
vi.mock("../src/features/deposit/capacityStore", async () =>
  (await import("./fakeCapacity")).fakeCapacityStore(capacity),
)
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
const gateway = { depositAddress, wakeDeposit: vi.fn(async () => {}) }
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
  encode: () => ({ size: 21, data: Array.from({ length: 21 }, () => Array(21).fill(false)) }),
}))
// The DS drags in liquid-glass optics jsdom can't render; this test is about which surface shows.
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
  }) => (
    <button type="button" disabled={isDisabled} onClick={onClick}>
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
const { RegistrationPendingError } = await import("../src/features/onboarding/registrationRail")
const { showReportableError } = await import("../src/errors/errorModal")
const { AddressesPublishingError } = await import("../src/features/deposit/addressesPublishing")
const { getBroadcastLedger, resetBroadcastsForTests } = await import(
  "../src/features/broadcasts/broadcasts"
)
const { getConfig } = await import("../src/config/env")
import { seedBootConfig } from "./seedBootConfig"

/**
 * The deposit gates are effectful, not cosmetic: no address may be derived or published while the
 * tag is unconfirmed. A settled tag reads the pool on open and derives one on the coin row, which
 * opens the address sheet.
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

  const coinRow = () =>
    container.querySelector<HTMLButtonElement>("[data-testid='deposit-coin-TEST']")
  const fundSheet = () => document.querySelector("dialog[aria-label='Deposit from wallet']")

  /** First visit opens the privacy disclaimer in front of the coin list. */
  const dismissDisclaimer = () =>
    act(async () => {
      const gotIt = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Got it!",
      )
      gotIt?.click()
    })

  beforeEach(() => {
    vi.clearAllMocks()
    resetBroadcastsForTests()
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

  it("derives nothing while the tag is unconfirmed, then shows an address on its own once it settles", async () => {
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

    expect(container.textContent).not.toContain("still being claimed")
    // Settling reads the pool, which is empty, and derives nothing: generation waits for the coin row.
    expect(depositAddress).toHaveBeenCalledTimes(1)
    expect(depositAddress).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "alice", {
      onStage: expect.any(Function),
      publishingLimit: 0,
    })
    expect(container.innerHTML).not.toContain("0xdeadbeef")

    const generate = coinRow()
    expect(generate).not.toBeNull()
    await act(async () => generate!.click())
    expect(depositAddress).toHaveBeenCalledTimes(2)
    expect(depositAddress).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "alice", {
      onStage: expect.any(Function),
      publishingLimit: 2,
    })
    expect(container.textContent).toContain("0xdeadbeef")
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Generate",
    )
  })

  it("resolves one address per open, even when its effects run twice", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    await act(async () => {
      root.render(
        <React.StrictMode>
          <MemoryRouter>
            <ScreeningProvider screener={passThroughScreener}>
              <DepositScreen />
            </ScreeningProvider>
          </MemoryRouter>
        </React.StrictMode>,
      )
    })
    // One pool read on open, and one derive on the coin row.
    expect(depositAddress).toHaveBeenCalledTimes(1)
    await act(async () => coinRow()!.click())
    expect(container.textContent).toContain("0xdeadbeef")
    expect(depositAddress).toHaveBeenCalledTimes(2)
  })

  it("takes a pooled address on open, and the coin row shows it with no derivation", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    depositAddress.mockResolvedValueOnce({ address: "0xp001ed", name: "alice.oxide.eth" })
    await render()
    expect(depositAddress).toHaveBeenCalledWith(expect.anything(), expect.anything(), "alice", {
      onStage: expect.any(Function),
      publishingLimit: 0,
    })
    expect(fireEvent).toHaveBeenCalledWith("deposit_address_shown", { pooled: true })
    await act(async () => coinRow()!.click())
    expect(container.textContent).toContain("0xp001ed")
    expect(depositAddress).toHaveBeenCalledTimes(1)
  })

  it("reports a resolve that fails on the coin row, and resolves again on the next press", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    depositAddress.mockImplementation(async () => {
      throw new Error("node unreachable")
    })
    await render()
    // The pool read on open fails quietly; the coin row surfaces it, and the sheet closes.
    expect(showReportableError).not.toHaveBeenCalled()
    await act(async () => coinRow()!.click())
    expect(showReportableError).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain(CREATING)
    depositAddress.mockImplementation(resolveDefault)
    await act(async () => coinRow()!.click())
    expect(container.textContent).toContain("0xdeadbeef")
  })

  it("waits while too many shown addresses are still publishing, and resolves once one lands", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    const ledger = getBroadcastLedger()
    const owed = (n: number, kind: "deposit" | "pool") =>
      ledger.enqueue({
        address: `0x${n.toString(16).padStart(40, "0")}`,
        kind,
        scope: null,
        source: { type: "slot", cacheKey: "k", day: 1, nonce: n },
      })
    await owed(1, "deposit")
    await owed(2, "deposit")
    await render()
    depositAddress.mockImplementationOnce(async () => {
      throw new AddressesPublishingError()
    })
    await act(async () => coinRow()!.click())
    expect(depositAddress).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "alice", {
      onStage: expect.any(Function),
      publishingLimit: 2,
    })
    expect(container.textContent).toContain(CREATING)
    expect(container.textContent).toContain(new AddressesPublishingError().message)
    expect(showReportableError).not.toHaveBeenCalled()
    const calls = depositAddress.mock.calls.length

    // Ledger activity that frees nothing does not try again.
    await act(async () => void (await owed(3, "pool")))
    expect(depositAddress).toHaveBeenCalledTimes(calls)

    await act(async () => void (await ledger.markLanded(`0x${"1".padStart(40, "0")}`)))
    expect(depositAddress).toHaveBeenCalledTimes(calls + 1)
    expect(container.textContent).toContain("0xdeadbeef")
  })

  it("holds the connect-wallet rail while the tag is unconfirmed", async () => {
    await seedPendingClaim()
    await render()

    // The claim hold covers the connected-wallet rail too: the button opens no picker and resolves
    // no address while the name is still landing.
    expect(container.textContent).toContain("still being claimed")
    const connect = container.querySelector<HTMLButtonElement>(
      "[data-testid='deposit-connect-link']",
    )
    expect(connect).not.toBeNull()
    expect(connect!.disabled).toBe(true)

    await act(async () => connect!.click())
    expect(l1.connect).not.toHaveBeenCalled()
    expect(depositAddress).not.toHaveBeenCalled()
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

  it("shows a confirmed tag's address at once while its broadcast waits on the registration, and lets the wallet fund it", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    const publish = vi.fn(async () => {
      throw new RegistrationPendingError({ pending: "import", messageHash: {} as never })
    })
    depositAddress.mockResolvedValueOnce({
      address: "0xdeadbeef",
      name: "alice.oxide.eth",
      publish,
    })
    l1.account = ACCOUNT
    await render()

    const generate = coinRow()
    await act(async () => generate!.click())
    expect(publish).toHaveBeenCalledOnce()
    // The ledger publishes it; the sheet shows the address at once, with where the broadcast stands.
    expect(container.innerHTML).toContain("0xdeadbeef")
    expect(container.textContent).not.toContain(CREATING)
    expect(container.querySelector("[data-testid='broadcast-status']")).not.toBeNull()
    expect(showReportableError).not.toHaveBeenCalled()
    expect(fireEvent).toHaveBeenCalledWith("address_publish_deferred", { reason: "import" })
    expect(fireEvent).not.toHaveBeenCalledWith("address_publish_failed", expect.anything())
    expect(fireEvent.mock.calls.filter(([e]) => e === "deposit_address_shown")).toEqual([
      ["deposit_address_shown", { pooled: false }],
    ])

    const fund = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Deposit from"),
    )
    expect(fund!.disabled).toBe(false)
  })

  it("keeps the address on screen when an attempt fails, reporting it without an error modal", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    depositAddress.mockResolvedValueOnce({
      address: "0xdeadbeef",
      name: "alice.oxide.eth",
      publish: async () => {
        throw new Error("broadcast refused")
      },
    })
    await render()

    const generate = coinRow()
    await act(async () => generate!.click())
    expect(container.textContent).toContain("0xdeadbeef")
    expect(showReportableError).not.toHaveBeenCalled()
    expect(fireEvent).toHaveBeenCalledWith(
      "address_publish_failed",
      expect.objectContaining({ code: expect.any(String) }),
    )
  })

  it("encodes an EIP-681 transfer URI so a wallet scan pre-fills send", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    await render()
    await dismissDisclaimer()

    const generate = coinRow()
    await act(async () => generate!.click())

    // Desktop layout: the code sits in the sheet.
    const qr = container.querySelector("[aria-label='Deposit address QR code']")
    expect(qr?.innerHTML).toContain(
      `ethereum:${MANIFEST_TOKEN}@${getConfig().l1ChainId}/transfer?address=0xdeadbeef`,
    )
  })

  it("reports the funds once the address it handed out is funded, and Close goes Home", async () => {
    ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    vi.useFakeTimers()
    try {
      await render()
      const generate = coinRow()
      await act(async () => generate!.click())

      // An unfunded address is the steady state — the screen stays put.
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(readL1TokenBalance).toHaveBeenCalledWith(MANIFEST_TOKEN, "0xdeadbeef")
      expect(navigate).not.toHaveBeenCalled()

      readL1TokenBalance.mockResolvedValue(5n)
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)))
      expect(container.textContent).toContain("spotted")
      expect(navigate).not.toHaveBeenCalled()
      // The external transfer is the funnel's funded step — bucketed, never the exact amount.
      expect(fireEvent).toHaveBeenCalledWith("deposit_funded", {
        funding: "external",
        amount_bucket: "<5",
      })
      const close = [...container.querySelectorAll("button")].find((b) => b.textContent === "Close")
      await act(async () => close!.click())
      expect(navigate).toHaveBeenCalledWith("/")
      expect(container.textContent).not.toContain("spotted")
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
      const generate = coinRow()
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
      expect(container.textContent).toContain("spotted")
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
    // A pool hit gives the sheet an address to fund without a derivation.
    depositAddress.mockResolvedValueOnce({ address: "0xp001ed", name: "alice.oxide.eth" })
    await render()

    const connect = container.querySelector<HTMLButtonElement>(
      "[data-testid='deposit-connect-link']",
    )
    expect(connect?.textContent).toBe("Or connect a wallet to fund")
    await act(async () => connect!.click())

    // The wallet picker is open and there is still nothing to fund from.
    expect(l1.connect).toHaveBeenCalledOnce()
    expect(fundSheet()).toBeNull()

    // The account arrives a render later; the held intent opens the sheet with no second click.
    l1.account = ACCOUNT
    await render()
    expect(fundSheet()).not.toBeNull()
  })
})
