import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { provingProgress } from "@obsidion/proving-progress"

const DEFAULT = { source: "default", isDefault: true }
const CUSTOM = { source: "settings", isDefault: false }
const state = vi.hoisted(() => ({
  phone: true,
  frozen: false,
  exitFunds: undefined as
    | { main: { refundable: bigint; links: bigint; waiting: bigint } }
    | undefined,
  fresh: false as boolean | undefined,
  navigate: vi.fn(),
  claimFragment: null as string | null,
  inviteCode: "k7q2m9x" as string | undefined,
  clearClaimStash: vi.fn(),
  endpoints: {} as Record<"node" | "l1Rpc" | "enclave", { source: string; isDefault: boolean }>,
  savings: { available: false, position: null as unknown, hydrated: false, moves: [] as unknown[] },
  activityReads: 0,
  savingsEntries: [] as { id: string; ts: number; node: ReactNode }[],
  growing: false,
  arriving: { main: 0n, savings: 0n },
  walletBalance: 0n,
  oldHoldings: { total: 0n, pending: false },
  lock: { state: "pending", checked: true } as { state: string; main?: bigint; checked: boolean },
  /** Actions that must wait for the upgrade, and every action a press asked for. */
  upgrade: new Set<string>(),
  asked: [] as string[],
  savingsLedger: undefined as
    | {
        basis: bigint
        counted: number
        shares: bigint
        excluded: { withdrawalLocalId: string; reason: string; backfilling: boolean }[]
      }
    | undefined,
}))
vi.mock("../src/features/operations/operations", async () =>
  (await import("./support/fakeOperations")).fakeOperationsModule(),
)
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useNavigate: () => state.navigate,
}))
vi.mock("../src/ui/usePhoneLayout", () => ({ usePhoneLayout: () => state.phone }))
vi.mock("../src/features/actionGate", () => ({
  useActionGuard: () => (action: string, run: () => void) => {
    state.asked.push(action)
    if (!state.upgrade.has(action)) run()
  },
  useActionVerdict: (action: string) => (state.upgrade.has(action) ? "upgrade" : "open"),
  useWalletFrozen: () => state.frozen,
}))
vi.mock("@obsidion/front-core", () => ({
  useBalance: () => ({ walletAsset: { balanceAtomic: state.walletBalance }, balanceKnown: true }),
  useSavings: () => state.savings,
  useSavingsPosition: () => ({
    position: state.savings.position,
    hydrated: state.savings.hydrated,
  }),
  isPaylinkWindowRevert: () => false,
  INTERRUPTED_ERRORS: {},
  // Flat between reads: the estimate is the last read value.
  // A micro-dollar a millisecond while a test asks the value to grow.
  projectValueAtomic: (value: bigint, readAt: number, now: number) =>
    state.growing ? value + BigInt(now - readAt) * 10n ** 12n : value,
  // As the real one: nothing once no shares are held; unknown while a counted move lacks its
  // figure or the moves do not account for the shares held beyond dust.
  savingsEarned: (
    ledger: { basis: bigint; shares: bigint; excluded: unknown[] },
    valueNow: bigint,
    held: bigint,
  ) =>
    ledger.excluded.length
      ? undefined
      : held === 0n
      ? 0n
      : (ledger.shares > held ? ledger.shares - held : held - ledger.shares) > 10n ** 12n
      ? undefined
      : valueNow - ledger.basis,
  savingsEarningsPending: (ledger: { excluded: { backfilling: boolean }[] }) =>
    ledger.excluded.length > 0 && ledger.excluded.every((e) => e.backfilling),
  useAztecContext: () => ({}),
  useContractServiceContext: () => ({}),
  formatDateLabel: () => "Today",
  formatTimeLabel: () => "14:32",
}))
vi.mock("@obsidion/web-ds", () => ({
  Shimmer: ({ children }: { children?: React.ReactNode }) => (
    <span data-testid="shimmer">{children}</span>
  ),
  Icon: () => null,
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: ReactNode }) => (
    <div>
      {label}
      {value}
    </div>
  ),
  GradientSpinner: () => <i data-icon="spinner" />,
  LiquidGlassPill: ({ label }: { label: string }) => <span>{label}</span>,
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  HomeQuickActionsRow: ({
    actions,
  }: {
    actions: { title: string; disabled?: boolean; onClick: () => void }[]
  }) => (
    <div>
      {actions.map((a) => (
        <button
          key={a.title}
          className="zkm-quick-action"
          disabled={a.disabled}
          onClick={a.onClick}
        >
          {a.title}
        </button>
      ))}
    </div>
  ),
}))
vi.mock("../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ handle: "alice", address: "0xabc" }),
}))
vi.mock("../src/features/onboarding/LostRegistrationNoticeCard", () => ({
  LostRegistrationNoticeCard: () => <div>Recover registration</div>,
}))
vi.mock("../src/features/onboarding/openRegistration", () => ({
  useNameClaimPending: () => false,
  useRegistrationDepositOwed: () => false,
}))
vi.mock("../src/features/onboarding/SecureNameNoticeCard", () => ({
  RegisterNameCard: () => <div>Register name</div>,
}))
vi.mock("../src/features/onboarding/ActivationHome", () => ({
  ActivationHome: () => <div>Activation home</div>,
}))
vi.mock("../src/features/invite/useInvite", () => ({
  inviteLink: (code: string) => `invite.zk.money/${code}`,
  useInvite: () => ({ code: state.inviteCode, credited: false }),
}))
// The Move sheet has its own suite; its import graph reads front-core constants this mock lacks.
vi.mock("../src/features/savings/MoveFundsSheet", () => ({
  MoveFundsSheet: () => <div data-testid="move-sheet" />,
}))
// The calculator has its own suite; here only that Home opens it.
vi.mock("../src/features/savings/EarningsCalculator", async (original) => ({
  ...(await original<typeof import("../src/features/savings/EarningsCalculator")>()),
  EarningsCalculatorSheet: () => <div data-testid="calculator-sheet" />,
}))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ network: "sandbox", nodeUrl: "http://node", endpoints: state.endpoints }),
}))
vi.mock("../src/features/onboarding/registrationDepositSeed", () => ({
  healRegistrationDeposits: vi.fn(),
}))
vi.mock("../src/features/onboarding/registrationRederive", () => ({
  discoverRegistrationDeposits: vi.fn(async () => 0),
}))
vi.mock("../src/features/paylink/claimStash", () => ({
  peekClaimStash: () => state.claimFragment,
  peekTicketSignup: () => null,
  clearClaimStash: (fragment?: string) => state.clearClaimStash(fragment),
}))
const claimSponsoredLink = vi.fn(
  async (_deps: unknown, _fragment: string, _onStage: (stage: string) => void) => "0xclaimtx",
)
vi.mock("../src/features/paylink/sponsoredPaylink", () => ({
  decodeLink: (fragment: string) => ({
    fragment,
    amount: "100",
    status: "unclaimed",
    flavor: "direct",
    claimableFrom: 0,
  }),
  claimSponsoredLink: (...args: Parameters<typeof claimSponsoredLink>) =>
    asOperation(claimSponsoredLink, "paylink-claim")(...args),
  VoucherReadError: class VoucherReadError extends Error {},
}))
vi.mock("../src/features/paylink/usePaylinkDeps", () => ({
  usePaylinkDeps: () => ({ account: { getAddress: () => "0xme" } }),
  useLinkVoucher: () => ({ uses: 0 }),
}))
vi.mock("../src/features/paylink/chainTime", () => ({ usePolledChainSeconds: () => 1_000 }))
// The ticket signup's review continuation is out of scope here: Home's phone layout is the subject.
vi.mock("../src/features/paylink/ticketContinuation", () => ({
  ticketSignupContinuation: () => null,
  ticketSignupCommitted: () => false,
  pendingTicketRegistration: () => false,
  onTicketRegistrationsChanged: () => () => {},
  ticketHoldNotice: () => undefined,
  unfundedRegistration: () => null,
  loadRegistrations: async () => {},
  releaseLinkDeposit: () => {},
}))
vi.mock("../src/features/withdraw/freshAddressAvailability", () => ({
  useFreshAddressAvailable: () => state.fresh,
}))
vi.mock("../src/features/withdraw/withdrawGateway", () => ({
  getWithdrawalStore: () => ({ list: () => [], onListChanged: () => () => {} }),
}))
vi.mock("../src/features/onboarding/registrationTerms", () => ({
  PAYLINK_TICKET_REFUSED_MESSAGE: "this payment's ticket did not waive the tag price",
  useDepositSkim: () => undefined,
  useSweepDeductions: () => undefined,
  commitRegistrationProverTip: () => {},
  useRegistrationTerms: () => null,
  committedProverTip: () => 0n,
}))
vi.mock("../src/features/withdraw/speedChoice", () => ({ SpeedRow: () => null }))
vi.mock("../src/features/paylink/registrationProverTip", () => ({
  useRegistrationSpeed: () => ({
    choice: { loading: false, speed: "faster", setSpeed: () => {}, settled: false, pricedTip: 0n },
    outcome: { proverTip: 0n },
  }),
}))
vi.mock("../src/features/onboarding/steps/ClaimReviewStep", () => ({ ClaimReviewStep: () => null }))
vi.mock("../src/features/onboarding/webRegistration", () => ({
  useRegistrationPublishStalled: () => false,
}))
vi.mock("../src/features/broadcasts/BroadcastStatusRow", () => ({ BroadcastStatusRow: () => null }))
vi.mock("../src/features/broadcasts/useOweRegistrationBroadcast", () => ({
  useOweRegistrationBroadcast: () => {},
}))
// Ethereum withdrawals and email verification have separate flow tests.
vi.mock("../src/features/paylink/ClaimToL1Modal", () => ({ ClaimToL1Modal: () => null }))
vi.mock("../src/features/paylink/emailClaim", () => ({ obtainEmailClaimProof: vi.fn() }))
vi.mock("@obsidion/sdk", () => ({
  decodePaylinkInline: vi.fn(),
  EmailMismatchError: class EmailMismatchError extends Error {},
}))
vi.mock("../src/lib/explorer", () => ({ l2TxUrl: vi.fn() }))
vi.mock("../src/errors/errorModal", () => ({
  showErrorModal: vi.fn(),
  showReportableError: vi.fn(),
}))
vi.mock("../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: () => "x" }))
vi.mock("../src/features/withdraw/frozenFunds", () => ({
  useFrozenFunds: () => ({ funds: state.exitFunds, failed: false, rescan: vi.fn() }),
  useLastFrozenFunds: () => state.exitFunds,
  fundsLeft: (f: { refundable: bigint; waiting: bigint }) => f.refundable + f.waiting,
}))
vi.mock("../src/ui/prefs", () => ({ useHideBalances: () => [false, vi.fn()] }))
vi.mock("../src/ui/hooks", async (original) => ({
  ...(await original<typeof import("../src/ui/hooks")>()),
  writeClipboard: vi.fn(),
}))
vi.mock("../src/features/migration/oldVersionBalance", () => ({
  useOldVersionHoldings: () => state.oldHoldings,
}))
vi.mock("../src/features/migration/upgradeLock", () => ({
  useUpgradeLock: () => state.lock,
}))
vi.mock("../src/ui/screens/useActivityEntries", () => ({
  useActivityEntries: () => {
    state.activityReads++
    return {
      entries: [
        { id: "request", incomingRequest: true, node: (<div>Incoming request</div>) as ReactNode },
      ],
      savingsEntries: state.savingsEntries,
      savingsHydrated: true,
      savingsLedger: state.savingsLedger,
      arriving: state.arriving,
      upgradesLoaded: true,
      hydrated: true,
    }
  },
}))
import { HomeScreen } from "../src/ui/screens/HomeScreen"
import { resetRunningClaimsForTests } from "../src/features/paylink/useClaimLinkFlow"
import { asOperation, endSigningAndHandOff } from "./support/handOff"
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  vi.clearAllMocks()
  state.claimFragment = null
  state.frozen = false
  state.exitFunds = undefined
  state.inviteCode = "k7q2m9x"
  state.fresh = false
  state.endpoints = { node: DEFAULT, l1Rpc: DEFAULT, enclave: DEFAULT }
  state.savings = { available: false, position: null, hydrated: false, moves: [] }
  state.savingsLedger = undefined
  state.savingsEntries = []
  state.arriving = { main: 0n, savings: 0n }
  state.walletBalance = 0n
  state.oldHoldings = { total: 0n, pending: false }
  state.lock = { state: "pending", checked: true }
  state.upgrade = new Set()
  state.asked = []
  claimSponsoredLink.mockImplementation(async () => "0xclaimtx")
  resetRunningClaimsForTests()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
const click = (label: string) =>
  act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!.click())
const labeled = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const renderHome = async (phone: boolean, path = "/") => {
  state.phone = phone
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <HomeScreen />
      </MemoryRouter>,
    ),
  )
}
const expectNoLegacyClaim = () => {
  expect(host.querySelector(".ww-claim-toast, .zkm-toast")).toBeNull()
  expect(host.querySelector(".ww-home-txns")).toBeNull()
  expect(host.textContent).toContain("Deposit funds")
}
describe("phone Home rail alternatives", () => {
  it.each([true, false])(
    "preserves payment routes and real notices with phone=%s",
    async (phone) => {
      await renderHome(phone)
      const actions = [...host.querySelectorAll("button")]
        .map((b) => b.textContent)
        .filter((t) => ["Deposit", "Receive", "Send", "Withdraw"].includes(t!))
      expect(actions).toEqual(
        phone
          ? ["Deposit", "Receive", "Send", "Withdraw"]
          : ["Deposit", "Send", "Receive", "Withdraw"],
      )
      for (const action of ["Deposit", "Receive", "Send", "Withdraw"]) {
        click(action)
        expect(state.navigate).toHaveBeenLastCalledWith(`/${action.toLowerCase()}`)
      }
      expect(host.textContent).toContain("Recover registration")
      expect(host.textContent).toContain("Activation home")
      expect(host.textContent).toContain("Register name")
      expect(host.textContent!.indexOf("Incoming request")).toBeLessThan(
        host.textContent!.indexOf("Deposit funds"),
      )
      expectNoLegacyClaim()
      for (const text of [
        "Invite friends",
        "iOS app release",
        "Quick actions",
        "Send money to anyone via paylink",
        "Share your @tag",
      ]) {
        expect(host.textContent!.includes(text)).toBe(!phone)
      }
      expect(host.querySelector(".ww-home__rail") !== null).toBe(!phone)
    },
  )

  it("the invite card confirms a copied link, and Share falls back to the clipboard", async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    const press = (label: string) =>
      act(async () => {
        ;[...host.querySelectorAll("button")].find((b) => b.textContent === label)!.click()
      })
    await renderHome(false)
    expect(host.textContent).toContain("invite.zk.money/k7q2m9x")
    await press("Copy link")
    expect(writeText).toHaveBeenCalledWith("https://invite.zk.money/k7q2m9x")
    expect(host.textContent).toContain("Copied!")

    await press("Share")
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain("Link copied!")
  })

  it("hides the invite card until the invite code arrives", async () => {
    state.inviteCode = undefined
    await renderHome(false)
    expect(host.textContent).not.toContain("Invite friends")
  })

  it.each([true, false])(
    "dismisses the real claim modal without a rail reminder with phone=%s",
    async (phone) => {
      state.claimFragment = "claim"
      await renderHome(phone)
      expect(host.querySelector('[role="dialog"][aria-label="Claim your payment"]')).not.toBeNull()
      expect(host.querySelector(".ww-home__rail")?.querySelector('[role="dialog"]')).toBeFalsy()
      expectNoLegacyClaim()

      click("Decline")
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      expect(state.clearClaimStash).toHaveBeenCalledTimes(1)
      expect(state.clearClaimStash).toHaveBeenCalledWith("claim")
      expect(claimSponsoredLink).not.toHaveBeenCalled()
      expectNoLegacyClaim()
    },
  )

  it.each([true, false])(
    "hands the claim from Home to the bell only after successful signing with phone=%s",
    async (phone) => {
      state.claimFragment = "claim"
      let finish!: (hash: string) => void
      claimSponsoredLink.mockImplementation((_deps, _fragment, onStage) => {
        onStage("building")
        onStage("proving")
        return new Promise<string>((resolve) => {
          finish = resolve
        })
      })
      await renderHome(phone)
      click("Accept")
      expect(host.querySelector('[role="dialog"][aria-label="Claiming payment"]')).not.toBeNull()
      expectNoLegacyClaim()

      act(() => provingProgress.emitSigningStart())
      expect(host.textContent).toContain("Confirm with passkey")
      act(() => provingProgress.emitSigningEnd(undefined, true))
      expect(host.querySelector('[role="dialog"][aria-label="Claiming payment"]')).not.toBeNull()

      act(() => provingProgress.emitSigningStart())
      await endSigningAndHandOff()
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      expectNoLegacyClaim()

      await act(async () => finish("0xclaimtx"))
      expect(state.clearClaimStash).toHaveBeenCalledTimes(1)
      expect(state.clearClaimStash).toHaveBeenCalledWith("claim")
      expect(host.querySelector('[role="dialog"]')).toBeNull()
    },
  )

  it.each([true, false])(
    "closes Home's claim modal on a no-sign settlement with phone=%s",
    async (phone) => {
      state.claimFragment = "claim"
      await renderHome(phone)
      await act(async () => click("Accept"))
      expect(state.clearClaimStash).toHaveBeenCalledTimes(1)
      expect(state.clearClaimStash).toHaveBeenCalledWith("claim")
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      expectNoLegacyClaim()
    },
  )
})

describe("Savings Home", () => {
  const empty = {
    available: true,
    position: { shares: 0n, value: 0n, sharePrice: 10n ** 18n, readAt: 1 },
    hydrated: true,
    moves: [],
  }
  it("shows its own empty state, one coin and no deposit trio, when there are no moves", async () => {
    state.savings = empty
    await renderHome(true, "/savings")
    const cta = host.querySelector(".ww-home__cta")!
    expect(cta).not.toBeNull()
    expect(cta.querySelector(".ww-home__deposit-art .ww-savings-art__coin img")).not.toBeNull()
    expect(cta.querySelector(".ww-home__deposit-coins")).toBeNull()
    expect(cta.querySelector(".ww-home__deposit-token")).toBeNull()
    // The art carries no label: the button under it is the one "Add to Savings".
    expect(cta.querySelector(".ww-home__deposit-art")?.textContent).toBe("")
    expect(cta.textContent).toBe("Add to Savings")
    expect(cta.textContent).not.toContain("From Main")
    expect(host.textContent).not.toContain("Deposit funds")
    expect(host.querySelector(".ww-home-txns")).toBeNull()
  })

  it("tells Main's rail to watch the balance, not the cents, tick up", async () => {
    state.savings = { ...empty, position: { ...empty.position, apy: 0.045 } }
    await renderHome(false)
    const slide = host.querySelector(".ww-quick__slide--savings")!
    expect(slide.querySelector(".ww-banner__title")?.textContent).toBe(
      "Earn 4.5% APY on your savings",
    )
    expect(slide.querySelector(".ww-banner__body")?.textContent).toBe(
      "Watch your balance tick up in real time.",
    )
    expect(slide.textContent).not.toContain("cents")
  })

  it.each([true, false])("has two tiles, in and out, with phone=%s", async (phone) => {
    state.savings = empty
    await renderHome(phone, "/savings")
    const tiles = phone
      ? [...host.querySelectorAll(".ww-home__phone-actions .zkm-quick-action__caption")]
      : [...host.querySelectorAll(".ww-home__balance + div > button")]
    expect(tiles.map((t) => t.textContent)).toEqual(["Add to Savings", "Move to Main Account"])
    expect(host.textContent).not.toContain("Calculator")
    expect(host.textContent).toContain("Earnings calculator")
  })

  it("opens the calculator from its own card", async () => {
    state.savings = empty
    await renderHome(true, "/savings")
    const link = host.querySelector<HTMLButtonElement>(".ww-savings__calc")!
    expect(link.textContent).toContain("Earnings calculator")
    expect(host.querySelector('[data-testid="calculator-sheet"]')).toBeNull()
    act(() => link.click())
    expect(host.querySelector('[data-testid="calculator-sheet"]')).not.toBeNull()
  })
})

describe("Savings earnings", () => {
  const WAD = 10n ** 18n
  const funded = {
    available: true,
    position: { shares: 100n * WAD, value: 1000n * WAD, sharePrice: 10n * WAD, readAt: 1 },
    hydrated: true,
    moves: [],
  }
  const ledger = (basis: bigint, counted = 1) => ({
    basis,
    counted,
    shares: 100n * WAD,
    excluded: [] as { withdrawalLocalId: string; reason: string; backfilling: boolean }[],
  })
  it("ticks the balance and the earnings without rebuilding the activity feed", async () => {
    vi.useFakeTimers()
    try {
      state.growing = true
      state.savings = { ...funded, position: { ...funded.position, apy: 0.05, readAt: Date.now() } }
      state.savingsLedger = ledger(980n * WAD)
      await renderHome(true, "/savings")
      const digits = () => host.querySelector('[data-testid="savings-balance"] small')?.textContent
      const earned = () => host.querySelector(".ww-home__earned small")?.textContent
      const before = { reads: state.activityReads, digits: digits(), earned: earned() }
      expect(before.digits).toBeTruthy()
      await act(async () => void (await vi.advanceTimersByTimeAsync(600)))
      expect(digits()).not.toBe(before.digits)
      expect(earned()).not.toBe(before.earned)
      expect(state.activityReads).toBe(before.reads)
    } finally {
      state.growing = false
      vi.useRealTimers()
    }
  })

  it("opens the Savings account's full history from its View all", async () => {
    state.savings = funded
    state.savingsEntries = [{ id: "m1", ts: 1, node: <div key="m1">Moved</div> }]
    await renderHome(true, "/savings")
    click("View all")
    expect(state.navigate).toHaveBeenCalledWith("/activity?account=savings")
  })

  it("shows no earnings while the moves do not account for every share held", async () => {
    state.savings = funded
    // A restored device before its moves are rebuilt: the whole balance would read as earned.
    state.savingsLedger = { ...ledger(0n, 0), shares: 0n }
    await renderHome(true, "/savings")
    expect(host.querySelector(".ww-home__earned")).toBeNull()
    state.savingsLedger = { ...ledger(980n * WAD), shares: 60n * WAD }
    await renderHome(true, "/savings")
    expect(host.querySelector(".ww-home__earned")).toBeNull()
    // Rounding dust between the moves and the shares held does not hide it.
    state.savingsLedger = { ...ledger(980n * WAD), shares: 100n * WAD + 3n }
    await renderHome(true, "/savings")
    expect(host.querySelector(".ww-home__earned b")?.textContent).toBe("+$20.00 earned")
  })

  it("says what the shares held earned: their value less what they cost", async () => {
    state.savings = funded
    state.savingsLedger = ledger(950n * WAD, 2)
    await renderHome(true, "/savings")
    expect(host.querySelector(".ww-home__earned b")?.textContent).toBe("+$50.00 earned")
    expect(host.querySelector(".ww-home__earned b")?.hasAttribute("data-positive")).toBe(true)
  })

  it("counts funds on their way where they land, and keeps them out of the earnings", async () => {
    state.savings = funded
    state.savingsLedger = ledger(950n * WAD, 2)
    state.arriving = { main: 25n * WAD, savings: (79_937n * WAD) / 100n }
    try {
      await renderHome(true, "/savings")
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="Select account"]')!.click())
      const figures = [...host.querySelectorAll(".ww-account-switcher__menu strong")]
      expect(figures.map((f) => f.textContent)).toEqual(["$25.00", "$1,799.37"])
      expect(host.querySelector(".ww-account-switcher__total b")?.textContent).toBe("$1,824.37")
      expect(host.querySelector(".ww-home__earned b")?.textContent).toBe("+$50.00 earned")
    } finally {
      state.arriving = { main: 0n, savings: 0n }
    }
  })

  it("shows a tiny gain as +$0.00, and zero once everything has moved out", async () => {
    state.savings = funded
    state.savingsLedger = ledger(1000n * WAD - 1n)
    await renderHome(true, "/savings")
    expect(host.querySelector(".ww-home__earned b")?.textContent).toBe("+$0.00 earned")
    state.savings = { ...funded, position: { ...funded.position, shares: 0n, value: 0n } }
    state.savingsLedger = { ...ledger(0n, 2), shares: 0n }
    await renderHome(true, "/savings")
    expect(host.querySelector(".ww-home__earned b")?.textContent).toBe("$0.00 earned")
  })

  it("shows no figure before the moves are read, while the position loads, with a move missing its figures, or with nothing to count", async () => {
    state.savings = funded
    await renderHome(true, "/savings")
    expect(host.querySelector(".ww-home__earned")).toBeNull()
    // The position's value is not known yet: nothing to subtract from, so nothing shows.
    state.savings = { ...funded, position: null, hydrated: false }
    state.savingsLedger = ledger(752n * WAD, 1)
    await renderHome(true, "/savings")
    expect(host.querySelector(".ww-home__earned")).toBeNull()
    // A counted move whose figures are gone for good: the total is unknown, never the full value.
    state.savings = funded
    state.savingsLedger = {
      ...ledger(0n, 1),
      excluded: [{ withdrawalLocalId: "w1", reason: "no vault event", backfilling: false }],
    }
    await renderHome(true, "/savings")
    expect(host.querySelector(".ww-home__earned")).toBeNull()
    state.savings = { ...funded, position: { ...funded.position, shares: 0n, value: 0n } }
    state.savingsLedger = ledger(0n, 0)
    await renderHome(true, "/savings")
    expect(host.querySelector(".ww-home__earned")).toBeNull()
    expect(host.textContent).not.toContain("earned")
  })

  it("says it is calculating while a move's figures are still being read from its escrow run", async () => {
    state.savings = funded
    state.savingsLedger = {
      ...ledger(0n, 1),
      excluded: [{ withdrawalLocalId: "w1", reason: "no net or burn figures", backfilling: true }],
    }
    await renderHome(true, "/savings")
    expect(host.querySelector(".ww-home__earned b")?.textContent).toBe("Calculating earnings…")
    expect(host.querySelector(".ww-home__earned b")?.hasAttribute("data-positive")).toBe(false)
  })

  it("ticks a gain's small digits like the balance, so a tiny gain visibly moves", async () => {
    state.savings = {
      ...funded,
      position: {
        ...funded.position,
        value: 1000n * WAD + 58n * 10n ** 14n,
        apy: 0.055,
        readAt: Date.now(),
      },
    }
    state.savingsLedger = ledger(1000n * WAD)
    await renderHome(true, "/savings")
    const figure = host.querySelector(".ww-home__earned b")!
    expect(figure.textContent).toBe("+$0.005800000 earned")
    expect(figure.querySelector("small")?.textContent).toBe("5800000")
    expect(figure.hasAttribute("data-positive")).toBe(true)
  })

  it("names the token only: no figure, no link, no rate", async () => {
    state.savings = { ...funded, position: { ...funded.position, apy: 0.055, readAt: Date.now() } }
    await renderHome(true, "/savings")
    const card = host.querySelector("section.ww-savings__card")!
    expect(card.querySelector("h3")?.textContent).toBe("You're earning on")
    expect(card.querySelector(".ww-savings__token b")?.textContent).toBe("USDS · Sky Savings Rate")
    expect(card.querySelector(".ww-savings__token small")?.textContent).toBe(
      "Dollar stablecoin issued by Sky",
    )
    expect(card.querySelector(".ww-savings__earning")).toBeNull()
    expect(card.querySelector("button")).toBeNull()
    expect(card.textContent).not.toContain("How it works")
    expect(card.textContent).not.toContain("About")
    expect(card.textContent).not.toContain("Rate is variable")
    expect(card.textContent).not.toContain("APY")
  })

  it("says in the console why nothing shows, with every input, once per change", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      state.savings = { ...funded, position: null, hydrated: false }
      state.savingsLedger = ledger(752n * WAD, 1)
      await renderHome(true, "/savings")
      expect(host.querySelector(".ww-home__earned")).toBeNull()
      const lines = info.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith("[savings] earnings hidden:"))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("hydrated=false")
      expect(lines[0]).toContain("position=none")
      expect(lines[0]).toContain("estimate=none")
      expect(lines[0]).toContain("counted 1")
    } finally {
      info.mockRestore()
    }
  })

  it("puts the APY pill and the earned figure on one row under the balance", async () => {
    state.savings = { ...funded, position: { ...funded.position, apy: 0.055, readAt: Date.now() } }
    state.savingsLedger = ledger(980n * WAD)
    await renderHome(true, "/savings")
    const row = host.querySelector(".ww-home__balance > .ww-home__balance-meta")
    expect(row?.querySelector(".ww-pill")?.textContent).toBe("5.5% APY")
    expect(row?.querySelector(".ww-home__earned b")?.textContent).toContain("+$20.00")
  })
})

describe("Home's actions wait for the upgrade", () => {
  it.each([true, false])("asks to upgrade before each action, with phone=%s", async (phone) => {
    state.upgrade = new Set(["deposit", "receive", "send", "withdraw", "link"])
    state.fresh = true
    await renderHome(phone)
    for (const action of ["Deposit", "Receive", "Send", "Withdraw", "Deposit funds"]) click(action)
    const asked = ["deposit", "receive", "send", "withdraw", "deposit"]
    if (!phone) {
      act(() => labeled("Withdraw to a fresh address")!.click())
      act(() => labeled("Create payment link")!.click())
      act(() =>
        [...host.querySelectorAll<HTMLButtonElement>(".ww-banner--row")]
          .find((b) => b.textContent?.includes("Share your @tag"))!
          .click(),
      )
      asked.push("withdraw", "link", "receive")
    }
    expect(state.asked).toEqual(asked)
    expect(state.navigate).not.toHaveBeenCalled()
  })

  it("asks to upgrade before a Savings move, never opening its sheet", async () => {
    state.upgrade = new Set(["savings"])
    state.savings = {
      available: true,
      position: { shares: 0n, value: 0n, sharePrice: 10n ** 18n, readAt: 1 },
      hydrated: true,
      moves: [],
    }
    await renderHome(true, "/savings")
    for (const label of ["Add to Savings", "Move to Main Account"])
      for (const button of [...host.querySelectorAll("button")].filter(
        (b) => b.textContent === label,
      ))
        act(() => button.click())
    expect(state.asked.length).toBeGreaterThanOrEqual(3)
    expect(new Set(state.asked)).toEqual(new Set(["savings"]))
    expect(host.querySelector('[data-testid="move-sheet"]')).toBeNull()
    state.upgrade = new Set()
    click("Move to Main Account")
    expect(host.querySelector('[data-testid="move-sheet"]')).not.toBeNull()
  })
})

describe("frozen Home", () => {
  it.each([true, false])("leaves only Withdraw open, phone=%s", async (phone) => {
    state.frozen = true
    await renderHome(phone)
    const tile = (title: string) =>
      [...host.querySelectorAll<HTMLButtonElement>(".zkm-quick-action")].find((b) =>
        b.textContent?.includes(title),
      )!
    for (const title of ["Deposit", "Receive", "Send"]) expect(tile(title).disabled).toBe(true)
    expect(tile("Withdraw").disabled).toBe(false)
  })
})

describe("Home quick actions", () => {
  const FRESH = "Withdraw to a fresh address"
  const PAYLINK = "Create payment link"

  it.each([false, undefined])(
    "shows the paylink slide alone, unpaged, with fresh=%s",
    async (fresh) => {
      state.fresh = fresh
      await renderHome(false)
      expect(labeled(FRESH)).toBeNull()
      expect(labeled("Scroll back")).toBeNull()
      expect(labeled("Scroll forward")).toBeNull()
      expect(labeled(PAYLINK)!.textContent).not.toContain("1/1")
      act(() => labeled(PAYLINK)!.click())
      expect(state.navigate).toHaveBeenLastCalledWith("/links/new")
    },
  )

  it("leads with the fresh-address slide when the deployment offers it", async () => {
    state.fresh = true
    await renderHome(false)
    const labels = [...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))
    expect(labels.filter((l) => l === FRESH || l === PAYLINK)).toEqual([FRESH, PAYLINK])
    expect(labeled("Scroll back")).not.toBeNull()
    expect(labeled("Scroll forward")).not.toBeNull()
    expect(labeled(FRESH)!.textContent).toContain("1/2")
    expect(labeled(PAYLINK)!.textContent).toContain("2/2")

    act(() => labeled(FRESH)!.click())
    expect(state.navigate).toHaveBeenLastCalledWith("/withdraw/fresh")
    act(() => labeled(PAYLINK)!.click())
    expect(state.navigate).toHaveBeenLastCalledWith("/links/new")
  })

  it("returns to the first slide when Savings and the fresh-address slide arrive later", async () => {
    // Only the paylink slide exists at first paint; the row snaps to it. Once the other two are
    // prepended, Chromium re-snaps to that same slide, now the last. jsdom keeps no scroll
    // position, so the reset is observed through the setter.
    const proto = HTMLElement.prototype as { scrollLeft?: number }
    const scrollLeft = vi.fn()
    Object.defineProperty(proto, "scrollLeft", {
      configurable: true,
      get: () => 724,
      set: scrollLeft,
    })
    try {
      await renderHome(false)
      expect(labeled(FRESH)).toBeNull()
      scrollLeft.mockClear()
      state.fresh = true
      state.savings = { ...state.savings, available: true }
      await renderHome(false)
      expect(labeled("Open Savings")!.textContent).toContain("1/3")
      expect(labeled(PAYLINK)!.textContent).toContain("3/3")
      const row = host.querySelector(".ww-quick__slides")!
      expect(scrollLeft).toHaveBeenCalledWith(0)
      expect(scrollLeft.mock.instances).toContain(row)
    } finally {
      delete proto.scrollLeft
    }
  })

  it("moves the row one slide per arrow click", async () => {
    // jsdom has no scrollBy and no layout.
    const proto = HTMLElement.prototype as { scrollBy?: unknown; clientWidth?: number }
    const scrollBy = vi.fn()
    proto.scrollBy = scrollBy
    Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 346 })
    try {
      state.fresh = true
      await renderHome(false)
      act(() => labeled("Scroll forward")!.click())
      act(() => labeled("Scroll back")!.click())
      expect(scrollBy.mock.calls.map(([to]) => to.left)).toEqual([346, -346])
    } finally {
      delete proto.scrollBy
      delete proto.clientWidth
    }
  })
})

describe("custom endpoints pill", () => {
  const pill = () =>
    host.querySelector(".ww-home__balance-label")?.textContent?.match(/Custom.*/)?.[0]

  it.each([true, false])(
    "shows nothing while every endpoint is the default, phone=%s",
    async (phone) => {
      await renderHome(phone)
      expect(pill()).toBeUndefined()
    },
  )

  it.each([
    [{ node: CUSTOM, l1Rpc: DEFAULT, enclave: DEFAULT }, "Custom node"],
    [{ node: DEFAULT, l1Rpc: CUSTOM, enclave: DEFAULT }, "Custom RPC"],
    [{ node: DEFAULT, l1Rpc: DEFAULT, enclave: CUSTOM }, "Custom enclave"],
    [{ node: CUSTOM, l1Rpc: CUSTOM, enclave: DEFAULT }, "Custom node, RPC"],
    [{ node: CUSTOM, l1Rpc: CUSTOM, enclave: CUSTOM }, "Custom node, RPC, enclave"],
  ])("names the custom endpoints %j as %s", async (endpoints, label) => {
    state.endpoints = endpoints
    await renderHome(true)
    expect(pill()).toBe(label)
  })

  it("opens Settings on tap", async () => {
    state.endpoints = { node: CUSTOM, l1Rpc: DEFAULT, enclave: DEFAULT }
    await renderHome(false)
    click("Custom node")
    expect(state.navigate).toHaveBeenLastCalledWith("/settings")
  })

  it("opens Settings under the desktop bridge too", async () => {
    vi.stubGlobal("__ZKMONEY_DESKTOP_BRIDGE__", { l1SubmitPath: "/desktop/l1-submit" })
    state.endpoints = { node: CUSTOM, l1Rpc: DEFAULT, enclave: CUSTOM }
    await renderHome(true)
    expect(host.querySelector('a[href="/desktop-settings"]')).toBeNull()
    click("Custom node, enclave")
    expect(state.navigate).toHaveBeenLastCalledWith("/settings")
  })
})

describe("Home over an upgrade", () => {
  const WAD = 10n ** 18n
  const balance = () => host.querySelector('[data-testid="wallet-balance"]')?.textContent

  it("shows what the old version holds before the upgrade, with no invitation to deposit", async () => {
    state.oldHoldings = { total: 100n * WAD, pending: false }
    state.arriving = { main: 100n * WAD, savings: 0n }

    await renderHome(false)

    expect(balance()).toBe("$100.00")
    expect(host.textContent).not.toContain("Deposit funds")
    expect(host.querySelector(".ww-home-txns")).not.toBeNull()
  })

  it("waits for the first look at old versions while nothing is recorded", async () => {
    state.oldHoldings = { total: 0n, pending: true }

    await renderHome(false)

    expect(balance()).toBeUndefined()
    expect(host.querySelector('[data-testid="shimmer"]')).not.toBeNull()
    expect(host.textContent).not.toContain("Deposit funds")
  })

  it("holds Main as it stood when the upgrade started, whatever has arrived since", async () => {
    state.lock = { state: "held", main: 101n * WAD, checked: true }
    state.walletBalance = 40n * WAD
    state.arriving = { main: 61n * WAD, savings: 0n }

    await renderHome(false)

    expect(balance()).toBe("$101.00")
    expect(host.textContent).not.toContain("Deposit funds")
  })

  it("shows no figure for an upgrade an older build started", async () => {
    state.lock = { state: "held", checked: true }
    state.walletBalance = 40n * WAD

    await renderHome(false)

    expect(balance()).toBe("—")
  })

  it("waits until this page has read the account's upgrade runs", async () => {
    state.lock = { state: "pending", checked: false }

    await renderHome(false)

    expect(balance()).toBeUndefined()
  })

  it("invites a deposit once nothing is left to move", async () => {
    await renderHome(false)

    expect(balance()).toBe("$0.00")
    expect(host.textContent).toContain("Deposit funds")
  })
})

describe("Home's Main figure", () => {
  const CENT = 10n ** 16n
  const balance = () => host.querySelector('[data-testid="wallet-balance"]')?.textContent

  it("stays on the cent as funds on their way fold into the balance", async () => {
    state.walletBalance = 288_849n * (CENT / 100n)
    state.arriving = { main: 17_951n * (CENT / 100n), savings: 0n }
    await renderHome(false)
    expect(balance()).toBe("$30.68")

    state.walletBalance = 3_068n * CENT
    state.arriving = { main: 0n, savings: 0n }
    await renderHome(false)
    expect(balance()).toBe("$30.68")
  })

  it("shows what the frozen portal still holds, not the refunded notes", async () => {
    state.walletBalance = 11_352n * CENT
    state.exitFunds = { main: { refundable: 2_949n * CENT, links: 0n, waiting: 1_000n * CENT } }
    await renderHome(false)
    expect(balance()).toBe("$39.49")
  })
})
