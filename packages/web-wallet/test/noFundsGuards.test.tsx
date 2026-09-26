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
const l1Wallet = {
  account: null as string | null,
  walletName: null as string | null,
  connecting: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
}

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
      getEntries: async () => [
        { tag: "alice", name: "Alice", address: `0x${"11".repeat(32)}` },
        {
          name: "Rainbow",
          address: "0x1111111111111111111111111111111111111111",
          addressKind: "ethereum-l1",
          l1Wallet: { provider: "rainbow", lastUsedAt: 1 },
        },
      ],
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
vi.mock("../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => l1Wallet,
}))
// The picker gates the swap routes on the manifest, so the screen tests need a swap-capable tuple
// to exercise all four outputs, and a swap route only opens once its relayer tip is simulated.
const swapControl = vi.hoisted<import("./fixtures/fakeSwapSimulator").FakeSwapControl>(() => ({
  relayerTip: 3n * 10n ** 18n,
  calls: [],
}))
vi.mock("@obsidion/sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@obsidion/sdk")>()
  const { fakeSwapSimulator } = await import("./fixtures/fakeSwapSimulator")
  return { ...sdk, SwapOnWithdrawSimulator: fakeSwapSimulator(sdk, swapControl) }
})
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({
    portal: `0x${"70".repeat(20)}`,
    token: `0x${"da".repeat(20)}`,
    swapEscrowFactory: `0x${"fa".repeat(20)}`,
    operationExecutor: `0x${"e0".repeat(20)}`,
  }),
  // The ETH route probes the recipient for code; a codeless answer keeps the warning silent. The
  // simulation reads the portal's FPC cut off the same client.
  l1PublicClient: () => ({ getCode: async () => "0x", readContract: async () => 0n }),
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
const { WithdrawScreen } = await import("../src/features/withdraw/WithdrawScreen")
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
  },
  {
    name: "WithdrawScreen",
    render: () => (
      <MemoryRouter>
        <ScreeningProvider screener={passThroughScreener}>
          <WithdrawScreen />
        </ScreeningProvider>
      </MemoryRouter>
    ),
    // Wallet name, recipient, then the amount inside the modal Continue opens.
    amountInput: (c: HTMLDivElement) => c.querySelectorAll("input")[2] as HTMLInputElement,
    cta: (c: HTMLDivElement) =>
      Array.from(c.querySelectorAll("button")).find((b) => b.textContent === "Withdraw funds")!,
    prep: async (c: HTMLDivElement) => {
      await act(async () => {
        typeInto(
          c.querySelectorAll("input")[1] as HTMLInputElement,
          "0x1111111111111111111111111111111111111111",
        )
      })
      // Continue gates on recipient screening; let the debounced pass-through verdict land.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 350))
      })
      await act(async () => {
        Array.from(c.querySelectorAll("button"))
          .find((b) => b.textContent === "Continue")!
          .click()
      })
      // The modal screens the recipient again before its CTA can enable.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 350))
      })
    },
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
  },
])("$name — overspend gate", ({ render, amountInput, cta, prep }) => {
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
    await type("10")
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

describe("WithdrawScreen — saved wallets", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    ;({ container, root } = mountHarness(<div />))
    await act(async () => {
      root.render(
        <MemoryRouter>
          <ScreeningProvider screener={passThroughScreener}>
            <WithdrawScreen />
          </ScreeningProvider>
        </MemoryRouter>,
      )
      await Promise.resolve()
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    l1Wallet.account = null
    l1Wallet.walletName = null
    l1Wallet.disconnect.mockClear()
  })

  it("shows saved wallets directly beneath the address input", () => {
    const fields = container.querySelector(".ww-deposit__fields")!
    const addressField = Array.from(fields.querySelectorAll(".ww-withdraw__field")).find(
      (field) =>
        field.querySelector("input")?.getAttribute("placeholder") === "Enter or paste address",
    )!
    const savedWallets = container.querySelector(".ww-withdraw__saved")!
    const connectWallet = container.querySelector(".ww-deposit__connect")!

    expect(fields.contains(savedWallets)).toBe(true)
    expect(
      addressField.compareDocumentPosition(savedWallets) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      savedWallets.compareDocumentPosition(connectWallet) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("offers all receive assets with accessible state and carries the selection into the modal", async () => {
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!
    expect(trigger.textContent).toContain("DAI")
    expect(trigger.getAttribute("aria-expanded")).toBe("false")

    await act(async () => trigger.click())
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    const options = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
    expect(options.map((option) => option.querySelector("b")?.textContent)).toEqual([
      "DAI",
      "USDC",
      "USDT",
      "ETH",
    ])
    expect(options[0]?.getAttribute("aria-selected")).toBe("true")

    await act(async () => options[1]?.click())
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(trigger.textContent).toContain("USDC")

    await act(async () => {
      typeInto(
        container.querySelectorAll("input")[1] as HTMLInputElement,
        "0x1111111111111111111111111111111111111111",
      )
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Continue")!
        .click()
    })

    expect(container.querySelector(".ww-modal")?.textContent).toContain("Receive asUSDC")
  })

  it("offers disconnect below the connected-wallet button", async () => {
    l1Wallet.account = "0x1111111111111111111111111111111111111111"
    l1Wallet.walletName = "Rainbow"

    await act(async () => {
      root.render(
        <MemoryRouter>
          <ScreeningProvider screener={passThroughScreener}>
            <WithdrawScreen />
          </ScreeningProvider>
        </MemoryRouter>,
      )
    })

    const connectWallet = container.querySelector(".ww-deposit__connect")!
    const disconnect = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Disconnect",
    )!

    expect(disconnect).toBeDefined()
    expect(
      connectWallet.compareDocumentPosition(disconnect) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    await act(async () => disconnect.click())
    expect(l1Wallet.disconnect).toHaveBeenCalledOnce()
  })
})
