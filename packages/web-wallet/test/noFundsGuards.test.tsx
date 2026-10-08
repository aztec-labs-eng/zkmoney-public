/**
 * The "no funds" guards: paylink / withdraw / contact-send for more than the balance can't be
 * started (all fail-open while the balance is still unknown — the balance loads after mount, and a
 * false block is worse than a late one). The unpaid-deposit-address guard the feed applies is
 * `isUnfundedSipaDeposit`, covered in front-core alongside the store it reads.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"

const balance = {
  walletAsset: null as { balance: number; balanceAtomic: bigint; decimals: number } | null,
  walletBalance: "0.00",
}
let assetsLoaded = true
let pendingDeposits = false

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAccountContext: () => ({ obsidionAccount: {} }),
  useAssetContext: () => ({ tokenService: {}, teeSigner: {} }),
  useAztecContext: () => ({ obsidionWallet: {} }),
  useContractServiceContext: () => ({ contractService: {} }),
  useBalance: () => ({ ...balance, assetsLoaded }),
  ContactStorage: {
    get: () => ({
      getEntries: async () => [{ tag: "alice", name: "Alice", address: `0x${"11".repeat(32)}` }],
    }),
  },
}))
vi.mock("../src/features/paylink/sponsoredPaylink", () => ({
  DEFAULT_CLAIM_WINDOW_DAYS: 30,
  createSponsoredLink: vi.fn(),
  hasPendingDeposits: () => pendingDeposits,
}))
vi.mock("../src/features/withdraw/withdrawGateway", () => ({ submitSponsoredWithdrawal: vi.fn() }))
vi.mock("../src/features/withdraw/useWithdrawals", () => ({
  useWithdrawals: () => ({ records: [], hydrated: true, checkAgain: vi.fn() }),
}))
vi.mock("../src/features/contacts/contactPay", () => ({
  runContactPay: vi.fn(),
}))
vi.mock("../src/features/contacts/SendScreen", () => ({ SendScreen: () => null }))
vi.mock("../src/features/identity/walletIdentity", () => ({
  loadOnboardedIdentity: () => ({ handle: "me" }),
}))
// The direct route prices its fee off the portal's FPC cut.
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ portal: `0x${"70".repeat(20)}` }),
  l1PublicClient: () => ({ readContract: async () => 0n }),
}))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ l1ChainId: 11155111, l1RpcUrl: "http://localhost:8545", network: "sandbox" }),
}))
vi.mock("../src/lib/analytics", () => ({
  fireEvent: vi.fn(),
  failureCode: () => "x",
  lapTimer: () => () => 0,
  amountBucket: () => "under_50",
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// The DS drags in liquid-glass optics jsdom can't render; this test is about the CTA gate.
vi.mock("../src/features/allowance/SponsoredActionNotice", () => ({
  useSponsoredActionBlock: () => undefined,
  SponsoredActionNotice: () => null,
}))
vi.mock("@obsidion/web-ds", () => ({
  AmountChipRow: () => null,
  GradientToggle: () => null,
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ConfirmationSheetDetailRow: () => null,
  CopyableLinkRow: () => null,
  DoubleCheckIcon: () => null,
  GradientInitialAvatar: () => null,
  GradientSpinner: () => null,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Toast: ({ message }: { message: string }) => <span>{message}</span>,
  TopNavIconButton: () => null,
  avatarColors: () => ["#000", "#fff"],
  GlassRowCard: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Icon: () => null,
  PrimaryGradientButton: ({
    title,
    isDisabled,
    onClick,
  }: {
    title: string
    isDisabled?: boolean
    onClick?: () => void
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
  ScreenNavBar: () => null,
  TextField: ({
    error,
    onChange,
    value,
    trailing,
  }: {
    error?: string
    onChange: (v: string) => void
    value?: string
    trailing?: React.ReactNode
  }) => (
    <>
      <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
      {trailing}
      {error && <span>{error}</span>}
    </>
  ),
}))

const { NewLinkScreen } = await import("../src/features/paylink/NewLinkScreen")
const { WithdrawToWalletModal } = await import("../src/features/withdraw/WithdrawToWalletModal")
const { ContactPayScreen } = await import("../src/features/contacts/ContactPayScreen")

/** React's value tracker swallows a plain `input.value = x`; go through the native setter. */
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

function mountHarness(ui: React.ReactElement) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  return { container, root, ui }
}

describe.each([
  {
    name: "NewLinkScreen",
    render: () => (
      <MemoryRouter>
        <NewLinkScreen />
      </MemoryRouter>
    ),
    // Paylink has a single amount field.
    amountInput: (c: HTMLDivElement) => c.querySelector("input") as HTMLInputElement,
    cta: (c: HTMLDivElement) =>
      Array.from(c.querySelectorAll("button")).find((b) => b.textContent === "Next")!,
    prep: async (_c: HTMLDivElement) => {},
    upTo: "10",
  },
  {
    name: "WithdrawToWalletModal",
    render: () => (
      <ScreeningProvider screener={passThroughScreener}>
        <WithdrawToWalletModal
          recipient="0x1111111111111111111111111111111111111111"
          onClose={vi.fn()}
          onDone={vi.fn()}
        />
      </ScreeningProvider>
    ),
    amountInput: (c: HTMLDivElement) => c.querySelector("input") as HTMLInputElement,
    cta: (c: HTMLDivElement) =>
      Array.from(c.querySelectorAll("button")).find((b) => b.textContent === "Review")!,
    prep: async (_c: HTMLDivElement) => {
      // The sheet screens the recipient before its CTA can enable.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 350))
      })
    },
    // The fee rides on top of the typed amount: the 0.1 relayer tip, with the portal's cut at 0.
    upTo: "9.9",
  },
  {
    name: "ContactPayScreen (send)",
    render: () => (
      <MemoryRouter initialEntries={["/contacts/alice/send"]}>
        <Routes>
          <Route path="/contacts/:idOrTag/send" element={<ContactPayScreen mode="send" />} />
        </Routes>
      </MemoryRouter>
    ),
    amountInput: (c: HTMLDivElement) => c.querySelector("input") as HTMLInputElement,
    cta: (c: HTMLDivElement) =>
      Array.from(c.querySelectorAll("button")).find((b) => b.textContent !== "MAX")!,
    // ContactStorage.getEntries resolves on the next microtask before the amount field mounts.
    prep: async (c: HTMLDivElement) => {
      await act(async () => {
        await Promise.resolve()
      })
      expect(c.querySelector("input")).toBeTruthy()
    },
    upTo: "10",
  },
])("$name — overspend gate", ({ render, amountInput, cta, prep, upTo }) => {
  let container: HTMLDivElement
  let root: Root

  const type = (value: string) =>
    act(async () => {
      typeInto(amountInput(container), value)
    })

  beforeEach(async () => {
    assetsLoaded = true
    pendingDeposits = false
    balance.walletAsset = null
    balance.walletBalance = "0.00"
    ;({ container, root } = mountHarness(render()))
    await act(async () => {
      root.render(render())
    })
    await prep(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("blocks an empty account — the balance is known to be $0", async () => {
    await type("5")
    expect(cta(container).disabled).toBe(true)
    expect(container.textContent).toMatch(/Not enough funds|Balance not enough/)
  })

  it("blocks more than the balance, allows up to it", async () => {
    balance.walletAsset = { balance: 10, balanceAtomic: 10n * 10n ** 18n, decimals: 18 }
    balance.walletBalance = "10.00"
    await type("25")
    expect(cta(container).disabled).toBe(true)
    await type(upTo)
    expect(cta(container).disabled).toBe(false)
    expect(container.textContent).not.toMatch(/Not enough funds|Balance not enough/)
  })

  it("stays open while the balance is still loading", async () => {
    assetsLoaded = false
    await type("25")
    expect(cta(container).disabled).toBe(false)
  })
})

/**
 * The Number balance rounds 1.999999999999999999 to 2; the escrow is funded from the exact string,
 * so MAX must fill the base-unit-exact value and the gate must compare base units.
 */
describe("NewLinkScreen — MAX precision", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    assetsLoaded = true
    pendingDeposits = false
    balance.walletAsset = { balance: 2, balanceAtomic: 2n * 10n ** 18n - 1n, decimals: 18 }
    balance.walletBalance = "2.00"
    ;({ container, root } = mountHarness(<div />))
    await act(async () => {
      root.render(
        <MemoryRouter>
          <NewLinkScreen />
        </MemoryRouter>,
      )
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("MAX fills the balance floored to cents and it is spendable; the rounded value is not", async () => {
    const input = container.querySelector("input") as HTMLInputElement
    const buttons = () => Array.from(container.querySelectorAll("button"))
    const cta = () => buttons().find((b) => b.textContent === "Next")!
    const max = buttons().find((b) => b.textContent === "MAX")!
    await act(async () => max.click())
    expect(input.value).toBe("1.99")
    expect(cta().disabled).toBe(false)
    await act(async () => typeInto(input, "2"))
    expect(cta().disabled).toBe(true)
  })
})

/**
 * Parked funding deposits are spendable without ever reaching `assets` — create redeems them and
 * the escrow claims them in the same tx. This is how the sandbox e2e funds, so a gate that reads
 * only the displayed balance blocks a create that would have succeeded.
 */
describe("NewLinkScreen — parked deposits", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    assetsLoaded = true
    pendingDeposits = true
    balance.walletAsset = null
    balance.walletBalance = "0.00"
    ;({ container, root } = mountHarness(<div />))
    await act(async () => {
      root.render(
        <MemoryRouter>
          <NewLinkScreen />
        </MemoryRouter>,
      )
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("stays open at a zero displayed balance", async () => {
    await act(async () => {
      typeInto(container.querySelector("input") as HTMLInputElement, "5")
    })
    expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(false)
    expect(container.textContent).not.toMatch(/Not enough funds|Balance not enough/)
  })
})
