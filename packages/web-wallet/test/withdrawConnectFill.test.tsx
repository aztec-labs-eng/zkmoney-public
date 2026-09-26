/**
 * Connecting an L1 wallet is a pick: the recipient row fills itself, and a recipient the user
 * already typed or arrived with survives the connect.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const l1 = vi.hoisted(() => ({
  account: null as string | null,
  walletName: null as string | null,
  connect: vi.fn(),
  disconnect: vi.fn(),
}))

vi.mock("../src/features/deposit/l1Wallet", () => ({ useL1Wallet: () => l1 }))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  ContactStorage: { get: () => ({ getEntries: async () => [] }) },
  useBalance: () => ({ walletAsset: null }),
}))
vi.mock("../src/features/withdraw/useWithdrawals", () => ({
  useWithdrawals: () => ({ records: [] }),
}))
vi.mock("../src/features/withdraw/WithdrawToWalletModal", () => ({
  WithdrawToWalletModal: () => null,
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
vi.mock("../src/config/env", () => ({ getConfig: () => ({ l1ChainId: 11155111, l1RpcUrl: "" }) }))
vi.mock("../src/lib/analytics", () => ({ fireEvent: vi.fn() }))
vi.mock("../src/platform/desktopBridge", () => ({ isDesktopL1SubmitActive: () => false }))
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: () => null,
}))

const { WithdrawScreen } = await import("../src/features/withdraw/WithdrawScreen")

const ADDRESS = "0x1111111111111111111111111111111111111111"
const TYPED = "0x2222222222222222222222222222222222222222"

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

describe("WithdrawScreen — connected wallet fills the address row", () => {
  let container: HTMLDivElement
  let root: Root

  const inputs = () => Array.from(container.querySelectorAll("input")) as HTMLInputElement[]
  const nameInput = () => inputs()[0]
  const addressInput = () => inputs()[1]
  const render = () =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <WithdrawScreen />
        </MemoryRouter>,
      )
    })

  beforeEach(async () => {
    l1.account = null
    l1.walletName = null
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await render()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("fills the address and wallet name once the wallet connects", async () => {
    expect(addressInput().value).toBe("")
    l1.account = ADDRESS
    l1.walletName = "Rainbow"
    await render()
    expect(addressInput().value).toBe(ADDRESS)
    expect(nameInput().value).toBe("Rainbow")
  })

  it("leaves an address the user typed alone", async () => {
    await act(async () => typeInto(addressInput(), TYPED))
    l1.account = ADDRESS
    l1.walletName = "Rainbow"
    await render()
    expect(addressInput().value).toBe(TYPED)
  })
})
