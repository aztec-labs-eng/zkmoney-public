/**
 * The fee row on the withdraw form is the first figure a user sees, and it has to be the one the
 * amount and confirm steps go on to charge. Every route pays the relayer tip and the portal's FPC
 * cut; a swap route adds the escrow's relayer tip, so the row must not keep showing the direct
 * route's figure after the receive asset changes. The relayer tip is simulated, so the form prices
 * the route as soon as it is picked. A route whose fee cannot be read closes, whichever route it is.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { formatUnits } from "viem"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { FEE_UNAVAILABLE_COPY, SWAP_UNAVAILABLE_COPY } from "../src/features/withdraw/withdrawQuote"
import type { FakeSwapControl } from "./fixtures/fakeSwapSimulator"

const RELAYER_TIP = 3n * 10n ** 18n
// What the mocked portal reads back as FPC_FUNDING_CUT.
const CUT = 250_000_000_000_000_000n
const DIRECT_FEE = WITHDRAW_RELAYER_TIP + CUT
const SWAP_FLOOR = DIRECT_FEE + RELAYER_TIP
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

const control = vi.hoisted<FakeSwapControl>(() => ({ relayerTip: 3n * 10n ** 18n, calls: [] }))
const DEFAULT_PORTAL = `0x${"70".repeat(20)}`
// The cut is cached per portal, so a case that wants a failing read names its own.
const portalControl = vi.hoisted(() => ({ address: `0x${"70".repeat(20)}`, fail: false }))

vi.mock("@obsidion/sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@obsidion/sdk")>()
  const { fakeSwapSimulator } = await import("./fixtures/fakeSwapSimulator")
  return { ...sdk, SwapOnWithdrawSimulator: fakeSwapSimulator(sdk, control) }
})
vi.mock("../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => ({ account: null, walletName: null, connect: vi.fn(), disconnect: vi.fn() }),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  ContactStorage: { get: () => ({ getEntries: async () => [] }) },
  useBalance: () => ({ walletAsset: { symbol: "DAI", decimals: 18 } }),
}))
vi.mock("../src/features/withdraw/useWithdrawals", () => ({
  useWithdrawals: () => ({ records: [] }),
}))
vi.mock("../src/features/withdraw/WithdrawToWalletModal", () => ({
  WithdrawToWalletModal: () => null,
}))
vi.mock("../src/features/withdraw/ethRecipientCheck", () => ({
  useEthRecipientHasCode: () => false,
}))
vi.mock("../src/ui/screens/WithdrawalDetailModal", () => ({ WithdrawalDetailModal: () => null }))
vi.mock("../src/features/withdraw/WithdrawPrivacyDisclaimer", () => ({
  WithdrawPrivacyDisclaimer: () => null,
  isWithdrawPrivacyDisclaimerHidden: () => true,
}))
vi.mock("../src/ui/screening", () => ({
  ScreeningNotice: () => null,
  useScreenedAddress: () => ({ verdict: "clear", cleared: true, rescreen: vi.fn() }),
}))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ l1ChainId: 11155111, l1RpcUrl: "", network: "sandbox" }),
  l1Transport: () => ({}),
}))
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({
    portal: portalControl.address,
    token: `0x${"da".repeat(20)}`,
    swapEscrowFactory: `0x${"fa".repeat(20)}`,
    operationExecutor: `0x${"e0".repeat(20)}`,
  }),
  l1PublicClient: () => ({
    readContract: async () => {
      if (portalControl.fail) throw new Error("portal read refused")
      return CUT
    },
  }),
}))
vi.mock("../src/lib/analytics", () => ({ fireEvent: vi.fn() }))
vi.mock("../src/platform/desktopBridge", () => ({ isDesktopL1SubmitActive: () => false }))
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({ title, isDisabled }: { title: string; isDisabled?: boolean }) => (
    <button disabled={isDisabled}>{title}</button>
  ),
}))

const { MemoryRouter } = await import("react-router-dom")
const { WithdrawScreen } = await import("../src/features/withdraw/WithdrawScreen")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("WithdrawScreen — fee row", () => {
  let container: HTMLDivElement
  let root: Root

  const feeValue = () =>
    Array.from(container.querySelectorAll(".ww-deposit__fact"))
      .find((fact) => fact.querySelector("span")?.textContent === "Fee")
      ?.querySelector("b")?.textContent
  const continueButton = () =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Continue")

  // The simulated floor settles asynchronously, behind the quote debounce.
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

  const click = (el: Element | undefined) =>
    act(async () => {
      expect(el).toBeDefined()
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

  const pickReceiveAsset = async (symbol: string) => {
    await click(container.querySelector(".ww-deposit__pill") ?? undefined)
    await click(
      Array.from(container.querySelectorAll('[role="option"]')).find(
        (o) => o.querySelector("b")?.textContent === symbol,
      ),
    )
    await settle()
  }

  const typeRecipient = async (value: string) => {
    await act(async () => {
      const el = container.querySelector(
        'input[placeholder="Enter or paste address"]',
      ) as HTMLInputElement
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
      el.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await settle()
  }

  beforeEach(async () => {
    control.relayerTip = RELAYER_TIP
    control.failure = undefined
    control.calls.length = 0
    portalControl.address = DEFAULT_PORTAL
    portalControl.fail = false
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter>
          <WithdrawScreen />
        </MemoryRouter>,
      )
    })
    await settle()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("charges the tip and the portal's cut on the direct DAI route, without simulating", () => {
    expect(feeValue()).toBe(`${formatUnits(DIRECT_FEE, 18)} DAI`)
    expect(control.calls).toHaveLength(0)
  })

  it("shows the simulated all-in swap floor once a swap route is picked", async () => {
    await pickReceiveAsset("USDC")

    expect(feeValue()).toBe(`${formatUnits(SWAP_FLOOR, 18)} DAI`)
    expect(feeValue()).not.toBe(`${formatUnits(DIRECT_FEE, 18)} DAI`)
    expect(container.textContent).toContain("Includes 3 DAI for L1 gas")
    // Priced before any amount exists, on a reference amount, against a placeholder recipient.
    expect(control.calls[0]!.amount).toBeGreaterThan(SWAP_FLOOR)
  })

  it("re-prices for the typed recipient, whose account state the gas depends on", async () => {
    await pickReceiveAsset("USDC")
    await typeRecipient(RECIPIENT)
    expect(control.calls.at(-1)!.recipient).toBe(RECIPIENT)
  })

  it("closes a swap route the simulation cannot price", async () => {
    control.failure = new Error("eth_estimateGas: execution reverted")
    await typeRecipient(RECIPIENT)
    expect(continueButton()?.disabled).toBe(false)

    await pickReceiveAsset("USDT")
    expect(feeValue()).toBe("--")
    expect(container.textContent).toContain(SWAP_UNAVAILABLE_COPY)
    expect(continueButton()?.disabled).toBe(true)

    // The direct route needs no simulation, so it stays open.
    await pickReceiveAsset("DAI")
    expect(container.textContent).not.toContain(SWAP_UNAVAILABLE_COPY)
    expect(continueButton()?.disabled).toBe(false)
  })

  it("closes the direct route when the portal's cut cannot be read", async () => {
    portalControl.address = `0x${"71".repeat(20)}`
    portalControl.fail = true
    await typeRecipient(RECIPIENT)
    // The read is retried twice more before it is reported.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_800))
    })

    expect(feeValue()).toBe("--")
    expect(container.textContent).toContain(FEE_UNAVAILABLE_COPY)
    expect(container.textContent).not.toContain(SWAP_UNAVAILABLE_COPY)
    expect(continueButton()?.disabled).toBe(true)
  })
})
