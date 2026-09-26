/**
 * The one-time-address warning: copy / QR open it until the user checks "Don't show this again"
 * and confirms. Closing without confirming does not persist.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, afterEach, describe, expect, it, vi, beforeAll } from "vitest"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import type { Hex } from "viem"

const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const MANIFEST_TOKEN = "0x00000000000000000000000000000000000000bb"

const aztec = { obsidionWallet: {} }
const contracts = { contractService: {} }
const depositAddress = vi.fn(async () => ({ address: "0xdeadbeef", name: "alice.oxide.eth" }))
// Auto-show only fires on a pool hit; null keeps these tests on the click path.
const pooledDepositAddress = vi.fn(async () => null)
const gateway = { depositAddress, pooledDepositAddress }

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => aztec,
  useContractServiceContext: () => contracts,
}))
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
vi.mock("uqr", () => ({
  renderSVG: (value: string) => `<svg data-uri="${value}"></svg>`,
}))
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {title}
    </button>
  ),
  Spinner: () => null,
  TopNavIconButton: ({ onClick, ariaLabel }: { onClick?: () => void; ariaLabel?: string }) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick} />
  ),
}))

const { DepositScreen } = await import("../src/features/deposit/DepositScreen")
const { saveWalletIdentity } = await import("../src/features/identity/walletIdentity")
const { hideOneTimeAddressWarning, isOneTimeAddressWarningHidden } = await import(
  "../src/features/deposit/OneTimeAddressWarning"
)
const { seedBootConfig } = await import("./seedBootConfig")

function button(container: HTMLElement, text: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text))
}

function copyButton(container: HTMLElement) {
  return [...container.querySelectorAll(".ww-deposit__btn")].find((b) =>
    /Copy|Copied/.test(b.textContent ?? ""),
  ) as HTMLButtonElement | undefined
}

function checkbox(container: HTMLElement) {
  return container.querySelector(".ww-deposit-warning input[type='checkbox']") as HTMLInputElement
}

function warningGotIt(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>(".ww-deposit-warning button")].find(
    (b) => b.textContent?.includes("Got it!"),
  )
}

describe("DepositScreen — one-time address warning", () => {
  beforeAll(seedBootConfig)

  let container: HTMLDivElement
  let root: Root

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

  async function generate() {
    await render()
    // Privacy disclaimer fronts first visit.
    const disclaimer = button(container, "Got it!")
    if (disclaimer) await act(async () => disclaimer.click())
    await act(async () => button(container, "Generate")!.click())
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("shows the warning on copy, and persists hide only after checkbox + Got it", async () => {
    await generate()

    await act(async () => copyButton(container)!.click())
    expect(container.textContent).toContain("This is a unique")
    expect(container.textContent).toContain("Don't show this again")
    expect(isOneTimeAddressWarningHidden()).toBe(false)

    await act(async () => checkbox(container).click())
    await act(async () => warningGotIt(container)!.click())
    expect(container.textContent).not.toContain("This is a unique")
    expect(isOneTimeAddressWarningHidden()).toBe(true)

    await act(async () => copyButton(container)!.click())
    expect(container.textContent).not.toContain("This is a unique")
  })

  it("does not persist hide when the checkbox is checked but the modal is closed", async () => {
    await generate()
    await act(async () => copyButton(container)!.click())
    await act(async () => checkbox(container).click())
    await act(async () =>
      (
        container.querySelector(".ww-deposit-warning [aria-label='Close']") as HTMLButtonElement
      ).click(),
    )
    expect(isOneTimeAddressWarningHidden()).toBe(false)

    await act(async () => copyButton(container)!.click())
    expect(container.textContent).toContain("This is a unique")
  })

  it("skips the warning on Show QR once hide is persisted", async () => {
    hideOneTimeAddressWarning()
    await generate()

    await act(async () => button(container, "Show")!.click())
    expect(container.textContent).not.toContain("This is a unique")
    expect(container.querySelector("[aria-label='Deposit address QR code']")).toBeTruthy()
  })
})
