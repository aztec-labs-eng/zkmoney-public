/**
 * The "no funds" guards: paylink / contact-send for more than the balance can't be
 * started, and none takes an amount until a read from this session confirms the balance: a cached
 * one can be stale. The unpaid-deposit-address guard the feed applies is `isUnfundedSipaDeposit`,
 * covered in front-core alongside the store it reads.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { seedOnboarded } from "../support/identity"
import { liveBalances } from "../support/balances"
import { memoryStore } from "@obsidion/front-core"
import { openTestSession } from "../support/session"
import { testContacts } from "../support/contacts"

const balance = { walletAsset: null as { balanceAtomic: bigint } | null }
let assetsLoaded = true
let pendingDeposits = false

// The executor's withdrawal fee is priced in its own suites; here it costs nothing.
vi.mock("../../src/features/withdraw/withdrawalFee", () => ({
  withdrawalExecutorFee: async () => 0n,
  activeWithdrawalFee: async () => 0n,
  activeWithdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutor: async () => ({ fee: 0n }),
  useActiveWithdrawalFee: () => 0n,
}))
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}))
vi.mock("../../src/features/paylink/sponsoredPaylink", () => ({
  DEFAULT_CLAIM_WINDOW_DAYS: 30,
  createSponsoredLink: vi.fn(),
  hasPendingDeposits: () => pendingDeposits,
}))
vi.mock("../../src/features/withdraw/withdrawGateway", () => ({
  submitSponsoredWithdrawal: vi.fn(),
}))
vi.mock("../../src/features/withdraw/useWithdrawals", () => ({
  useWithdrawals: () => ({ records: [], hydrated: true, checkAgain: vi.fn() }),
}))
vi.mock("../../src/features/contacts/contactPay", () => ({
  runContactPay: vi.fn(),
  recipientUpgraded: async () => true,
  RecipientNotUpgradedError: class RecipientNotUpgradedError extends Error {},
}))
vi.mock("../../src/features/contacts/SendScreen/SendScreen", () => ({ SendScreen: () => null }))
vi.mock("../../src/features/actionGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/actionGate")>()),
  useActionVerdict: () => "open",
}))
// An offline L1 client, whose portal cap is above every amount here.
vi.mock("../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/oxideTuple")>()),
  l1PublicClient: () => ({ readContract: async () => 10n ** 30n }),
}))
vi.mock("../../src/lib/analytics", () => ({
  fireEvent: vi.fn(),
  failureCode: () => "x",
  lapTimer: () => () => 0,
  amountBucket: () => "under_50",
  requestAmountBucket: () => "under_50",
}))
vi.mock("../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// The DS drags in liquid-glass optics jsdom can't render; this test is about the CTA gate.
vi.mock("../../src/features/allowance/SponsoredActionNotice", () => ({
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

const { NewLinkScreen } = await import("../../src/features/paylink/NewLinkScreen/NewLinkScreen")
const { ContactPayScreen } = await import(
  "../../src/features/contacts/ContactPayScreen/ContactPayScreen"
)

/** React's value tracker swallows a plain `input.value = x`; go through the native setter. */
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

/** Each amount step ends on its CTA, whose label changes while the balance is checked. */
const lastButton = (c: HTMLDivElement) => Array.from(c.querySelectorAll("button")).at(-1)!
const max = (c: HTMLDivElement) =>
  c.querySelector<HTMLButtonElement>(".ww-pay__max, .ww-withdraw__paste")!

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
    prep: async (_c: HTMLDivElement) => {},
    upTo: "10",
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
    // The contact book's read resolves on the next microtask before the amount field mounts.
    prep: async (c: HTMLDivElement) => {
      await act(async () => {
        await Promise.resolve()
      })
      expect(c.querySelector("input")).toBeTruthy()
    },
    upTo: "10",
  },
])("$name — overspend gate", ({ render, amountInput, prep, upTo }) => {
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
    expect(lastButton(container).disabled).toBe(true)
    expect(container.textContent).toMatch(/Not enough funds|Balance not enough/)
  })

  it("blocks more than the balance, allows up to it", async () => {
    balance.walletAsset = { balanceAtomic: 10n * 10n ** 18n }
    await type("25")
    expect(lastButton(container).disabled).toBe(true)
    await type(upTo)
    expect(lastButton(container).disabled).toBe(false)
    expect(container.textContent).not.toMatch(/Not enough funds|Balance not enough/)
  })

  it("holds a cached balance until this session's read lands", async () => {
    balance.walletAsset = { balanceAtomic: 10n * 10n ** 18n }
    assetsLoaded = false
    await type(upTo)
    expect(lastButton(container).disabled).toBe(true)
    expect(max(container).disabled).toBe(true)
    assetsLoaded = true
    await act(async () => root.render(render()))
    expect(lastButton(container).disabled).toBe(false)
    expect(max(container).disabled).toBe(false)
  })
})

beforeEach(async () => {
  const contacts = testContacts()
  await contacts.addEntry({ tag: "alice", name: "Alice", address: `0x${"11".repeat(32)}` })
  await contacts.all()
  openTestSession({
    primed: { tuple: { portal: `0x${"70".repeat(20)}` } as never },
    contacts,
    wallet: {},
    contractService: {},
    account: {},
    token: { metadata: { decimals: 18 } },
    mainToken: memoryStore({ address: "0xd4", name: "DAI", symbol: "DAI", decimals: 18 }).readonly,
    teeSigner: {},
    balances: liveBalances(() => ({
      main: balance.walletAsset?.balanceAtomic,
      readThisSession: assetsLoaded,
    })),
  })
})

beforeEach(() => seedOnboarded({ handle: "me", address: "0xme" }, "localhost"))

describe("ContactPayScreen — paying a request", () => {
  let container: HTMLDivElement
  let root: Root
  const request = { id: "request", tag: "alice", amount: 5 }
  const render = () => (
    <MemoryRouter initialEntries={[{ pathname: "/contacts/alice/send", state: { request } }]}>
      <Routes>
        <Route path="/contacts/:idOrTag/send" element={<ContactPayScreen mode="send" />} />
      </Routes>
    </MemoryRouter>
  )

  beforeEach(async () => {
    balance.walletAsset = { balanceAtomic: 10n * 10n ** 18n }
    ;({ container, root } = mountHarness(<div />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("holds a cached balance until this session's read lands", async () => {
    assetsLoaded = false
    await act(async () => root.render(render()))
    expect(lastButton(container).disabled).toBe(true)
    assetsLoaded = true
    await act(async () => root.render(render()))
    expect(lastButton(container).disabled).toBe(false)
  })
})
