/**
 * The address sheet's "Limits and fees" row names the limit that fits right now, and its drawer
 * holds the fee, the capacity reading and the route's details. Copy and the code are held while the
 * fee is unread. Capacity that holds a deposit is said above Copy; copying never asks.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import type { Hex } from "viem"

const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const MANIFEST_TOKEN = "0x00000000000000000000000000000000000000bb"

const loadDepositDisplayFacts = vi.hoisted(() => vi.fn())
const demo = vi.hoisted(() => ({ on: false }))

// Plenty of shared capacity, read from a fake bucket instead of the network.
const capacity = vi.hoisted(() => ({
  availableAtomic: 40_000n * 10n ** 18n,
  readFails: false,
  epoch: 0,
}))
vi.mock("../src/features/deposit/capacityStore", async () =>
  (await import("./fakeCapacity")).fakeCapacityStore(capacity),
)
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}))
vi.mock("../src/dev/demoFlag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dev/demoFlag")>()),
  isDemoMode: () => demo.on,
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
const gateway = {
  wakeDeposit: vi.fn(async () => {}),
  depositAddress: vi.fn(async () => ({ address: "0xp001ed", name: "alice.oxide.eth" })),
}
vi.mock("../src/features/deposit/sipaGateway", () => ({ getSipaDepositGateway: () => gateway }))
vi.mock("../src/features/deposit/loadDepositFacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/deposit/loadDepositFacts")>()),
  loadDepositDisplayFacts,
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("../src/lib/analytics", () => ({
  fireEvent: vi.fn(),
  failureCode: () => "x",
  lapTimer: () => () => 0,
  amountBucket: () => "b",
}))
vi.mock("../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => ({
    account: null,
    accounts: [],
    chainId: null,
    connecting: false,
    wrongChain: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}))
vi.mock("../src/features/allowance/useSponsoredAllowance", () => ({
  useSponsoredAllowance: () => ({ snapshot: { status: "signed-out" }, refresh: () => {} }),
}))
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ token: MANIFEST_TOKEN }),
}))
vi.mock("uqr", () => ({
  renderSVG: (value: string) => `<svg data-uri="${value}"></svg>`,
  encode: () => ({ size: 21, data: Array.from({ length: 21 }, () => Array(21).fill(false)) }),
}))
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
    testId,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
    testId?: string
  }) => (
    <button type="button" disabled={isDisabled} data-testid={testId} onClick={onClick}>
      {title}
    </button>
  ),
  Spinner: () => null,
  TopNavIconButton: () => null,
}))

const { DepositScreen, QUOTE_PENDING } = await import("../src/features/deposit/DepositScreen")
const { saveWalletIdentity } = await import("../src/features/identity/walletIdentity")
const { MAX_SEND_UNAVAILABLE } = await import("../src/features/deposit/AddressLimits")
const { depositCapacityStore } = await import("../src/features/deposit/capacityStore")
const { FAKE_ACTIVE_KEY } = await import("./fakeCapacity")
import { seedBootConfig } from "./seedBootConfig"

const FACTS = {
  fee: "0.35",
  token: MANIFEST_TOKEN,
  sweepFeeAtomic: 250_000_000_000_000_000n,
  fpcFundingCutAtomic: 100_000_000_000_000_000n,
}

describe("DepositScreen limits in the address sheet", () => {
  beforeAll(seedBootConfig)

  let container: HTMLDivElement
  let root: Root

  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`)
  const limits = () => byTestId("address-limits")
  const copyButton = () => byTestId("deposit-copy") as HTMLButtonElement | null
  const aboutLimits = () => document.querySelector("dialog[aria-label='About limits']")
  const warningDialog = () =>
    document.querySelector("dialog[aria-label='One-time deposit address']")
  /** Opens the sheet for the one coin the sandbox lists, or the named one in the demo. */
  const openSheet = (symbol = "TEST") =>
    act(async () => byTestId(`deposit-coin-${symbol}`)!.click())
  const openDrawer = () =>
    act(async () =>
      document.querySelector<HTMLButtonElement>(".ww-deposit-sheet__limits-head")!.click(),
    )
  /** Opens the limit's details from the drawer and returns them. */
  const openLimit = async () => {
    await act(async () =>
      limits()!.querySelector<HTMLButtonElement>("[data-testid='about-limits-link']")!.click(),
    )
    for (let i = 0; i < 3; i++) await act(async () => {})
    return aboutLimits()!
  }
  const closeLimit = () =>
    act(async () => {
      aboutLimits()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
  const maxSend = (scope: ParentNode) =>
    scope.querySelector("[data-testid='address-limits-max-send']")?.textContent
  const maxCredit = (scope: ParentNode) =>
    scope.querySelector("[data-testid='address-limits-max-credit']")?.textContent
  const limitNow = () => byTestId("deposit-limit-now")?.textContent
  const capacityNote = () => byTestId("deposit-capacity-note")

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

  beforeEach(() => {
    vi.clearAllMocks()
    capacity.availableAtomic = 40_000n * 10n ** 18n
    capacity.readFails = false
    capacity.epoch += 1
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    demo.on = false
    localStorage.clear()
    localStorage.setItem("webwallet.hide-deposit-privacy-disclaimer", "true")
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const loadDepositFacts = () => loadDepositDisplayFacts.mockResolvedValue(FACTS)

  it("names the limit under the address, with the route's details in the drawer", async () => {
    loadDepositFacts()
    await render()
    await openSheet()

    expect(limits()?.textContent).toBe("Limits and feesUp to $2,500 right now")
    // The address comes first, then its limit.
    const address = byTestId("deposit-address")!
    expect(
      address.compareDocumentPosition(limits()!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    await openDrawer()
    expect(limitNow()).toBe("$2,500 incl. fees")
    const details = await openLimit()
    expect(details.textContent).toContain("counts 1 TEST as $1")
    expect(maxSend(details)).toBe("2,500 TEST")
    // Net of the current fee: 0.25 sweep fee + 0.1 funding cut.
    expect(maxCredit(details)).toBe("2,499.65 TEST")
  })

  it("puts the limits right under the QR code, and hands focus back to the drawer", async () => {
    loadDepositFacts()
    await render()
    await openSheet()

    // The code comes first; the limit sits right under it.
    const code = document.querySelector("[aria-label='Deposit address QR code']")!
    expect(code).not.toBeNull()
    expect(code.compareDocumentPosition(limits()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The details open over the sheet and hand focus back to it.
    await openDrawer()
    const info = limits()!.querySelector<HTMLButtonElement>("[data-testid='about-limits-link']")!
    info.focus()
    const details = await openLimit()
    expect(maxSend(details)).toBe("2,500 TEST")
    await closeLimit()
    expect(aboutLimits()).toBeNull()
    expect(document.activeElement).toBe(info)
  })

  it("reads as checking while the fee is out", async () => {
    loadDepositDisplayFacts.mockReturnValue(new Promise(() => {}))
    await render()
    await openSheet()
    await openDrawer()

    expect(byTestId("deposit-fee")?.textContent).toBe(QUOTE_PENDING)
    expect(maxSend(await openLimit())).toBe(QUOTE_PENDING)
  })

  it("names no maximum and holds copy and scan while the fee is unavailable", async () => {
    loadDepositDisplayFacts.mockRejectedValue(new Error("rpc down"))
    await render()
    await openSheet()

    expect(limits()?.textContent).toContain("$2,500")
    expect(copyButton()?.disabled).toBe(true)
    expect(document.querySelector("[aria-label='Deposit address QR code']")).toBeNull()
    await openDrawer()
    const details = await openLimit()
    expect(maxSend(details)).toBe(MAX_SEND_UNAVAILABLE)
    expect(maxCredit(details)).toBe(MAX_SEND_UNAVAILABLE)
  })

  it("names the swap for a token the portal does not settle in", async () => {
    demo.on = true
    loadDepositFacts()
    await render()
    await openSheet("USDC")
    await openDrawer()

    expect(byTestId("deposit-swap-note")?.textContent).toContain("Your balance is stored in DAI.")
    const details = await openLimit()
    expect(maxSend(details)).toBe("2,500 USDC")
    // The swap sets the DAI credited, so no credit is stated.
    expect(maxCredit(details)).toBe(MAX_SEND_UNAVAILABLE)
    expect(details.textContent).toContain("USDC is swapped to DAI at the market rate")
  })

  describe("shared capacity", () => {
    it("keeps healthy capacity quiet, with its details one tap away in the drawer", async () => {
      loadDepositFacts()
      await render()
      await openSheet()
      await openDrawer()
      expect(capacityNote()).toBeNull()
      expect(limitNow()).toBe("$2,500 incl. fees")
      await act(async () => byTestId("about-capacity-link")!.click())
      for (let i = 0; i < 3; i++) await act(async () => {})
      const capacitySection = aboutLimits()!.querySelector<HTMLElement>(
        "[data-testid='about-limits-capacity']",
      )!
      expect(capacitySection.textContent).toContain("40,000 TEST")
      expect(capacitySection.textContent).toContain("A saved address or QR code doesn't keep this")
    })

    it("says zero capacity above Copy, with Check again and its details in the drawer", async () => {
      capacity.availableAtomic = 0n
      loadDepositFacts()
      await render()
      await openSheet()
      expect(capacityNote()?.textContent).toContain("No network capacity is available right now.")
      expect(capacityNote()?.getAttribute("role")).toBe("alert")
      await openDrawer()
      expect(limitNow()).toBe("$0 incl. fees")
      expect(byTestId("funding-capacity-retry")).not.toBeNull()
      const info = byTestId("about-capacity-link")!
      expect(info.getAttribute("aria-label")).toBe("About network capacity")
      await act(async () => info.click())
      for (let i = 0; i < 3; i++) await act(async () => {})
      const toggle = aboutLimits()!.querySelector("[data-testid='about-limits-capacity-toggle']")!
      expect(toggle.getAttribute("aria-expanded")).toBe("true")
    })

    it("names the most that fits current capacity as the limit right now", async () => {
      capacity.availableAtomic = 500n * 10n ** 18n
      loadDepositFacts()
      await render()
      await openSheet()
      expect(limits()?.textContent).toBe("Limits and feesUp to $500.35 right now")
      await openDrawer()
      expect(limitNow()).toBe("$500.35 incl. fees")
    })

    it("copies at once while capacity is zero; the note states the reason", async () => {
      capacity.availableAtomic = 0n
      loadDepositFacts()
      await render()
      await openSheet()
      expect(capacityNote()?.textContent).toContain("No network capacity is available right now")
      await act(async () => copyButton()!.click())
      expect(warningDialog()).toBeNull()
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
      expect(copyButton()?.textContent).toBe("Address copied!")
    })

    it("says capacity could not be checked, and still copies at once", async () => {
      capacity.readFails = true
      loadDepositFacts()
      await render()
      await openSheet()
      await openDrawer()
      expect(limitNow()).toBe("Could not check")
      expect(capacityNote()?.textContent).toContain("Capacity could not be checked.")
      await act(async () => copyButton()!.click())
      expect(warningDialog()).toBeNull()
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    })

    it("keeps the note and the drawer current when capacity drops while the code is shown", async () => {
      loadDepositFacts()
      await render()
      await openSheet()
      await openDrawer()
      expect(capacityNote()).toBeNull()
      capacity.availableAtomic = 0n
      await act(async () => {
        await depositCapacityStore(FAKE_ACTIVE_KEY).retry()
      })
      expect(capacityNote()?.textContent).toContain("No network capacity is available right now")
      expect(limitNow()).toBe("$0 incl. fees")
      await act(async () => copyButton()!.click())
      expect(warningDialog()).toBeNull()
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    })

    it("does not match a swapped token to capacity", async () => {
      demo.on = true
      capacity.availableAtomic = 500n * 10n ** 18n
      loadDepositFacts()
      await render()
      await openSheet("USDC")
      await openDrawer()
      // No figure fits a swap; the reason is in the capacity details, not on the sheet.
      expect(limitNow()).toBe("$2,500 incl. fees")
      await act(async () => byTestId("about-capacity-link")!.click())
      for (let i = 0; i < 3; i++) await act(async () => {})
      expect(
        aboutLimits()!.querySelector("[data-testid='address-capacity-swap']")?.textContent,
      ).toBe(
        "Maximum send amount for current capacity unavailable: the DAI credited from USDC is set by the swap.",
      )
    })
  })
})
