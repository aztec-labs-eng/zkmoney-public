import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { provingProgress } from "@obsidion/proving-progress"

const state = vi.hoisted(() => ({
  phone: true,
  navigate: vi.fn(),
  claimFragment: null as string | null,
  clearClaimStash: vi.fn(),
}))
vi.mock("../src/features/operations/operations", async () =>
  (await import("./support/fakeOperations")).fakeOperationsModule(),
)
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useNavigate: () => state.navigate,
}))
vi.mock("../src/ui/usePhoneLayout", () => ({ usePhoneLayout: () => state.phone }))
vi.mock("@obsidion/front-core", () => ({
  useBalance: () => ({ walletBalance: 0, balanceKnown: true }),
  isPaylinkWindowRevert: () => false,
  useAztecContext: () => ({}),
  useContractServiceContext: () => ({}),
  formatDateLabel: () => "Today",
  formatTimeLabel: () => "14:32",
}))
vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: ReactNode }) => (
    <div>
      {label}
      {value}
    </div>
  ),
  GradientSpinner: () => <i data-icon="spinner" />,
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  HomeQuickActionsRow: ({ actions }: { actions: { title: string; onClick: () => void }[] }) => (
    <div>
      {actions.map((a) => (
        <button key={a.title} onClick={a.onClick}>
          {a.title}
        </button>
      ))}
    </div>
  ),
}))
vi.mock("../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ handle: "alice" }),
}))
vi.mock("../src/features/onboarding/LostRegistrationNoticeCard", () => ({
  LostRegistrationNoticeCard: () => <div>Recover registration</div>,
}))
vi.mock("../src/features/onboarding/RegistrationDepositPrompt", () => ({
  RegistrationDepositPrompt: () => null,
  useAwaitingDepositRecord: () => null,
}))
vi.mock("../src/features/onboarding/SecureNameNoticeCard", () => ({
  SecureNameNoticeCard: () => <div>Secure name</div>,
  RegisterNameCard: () => <div>Register name</div>,
}))
vi.mock("../src/features/contacts/ShareTagModal", () => ({ ShareTagModal: () => null }))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ network: "sandbox", nodeUrl: "http://node" }),
}))
vi.mock("../src/features/onboarding/registrationDepositSeed", () => ({
  healRegistrationDeposits: vi.fn(),
}))
vi.mock("../src/features/paylink/claimStash", () => ({
  peekClaimStash: () => state.claimFragment,
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
  }),
  claimSponsoredLink: (...args: Parameters<typeof claimSponsoredLink>) =>
    asOperation(claimSponsoredLink, "paylink-claim")(...args),
}))
vi.mock("../src/features/paylink/usePaylinkDeps", () => ({
  usePaylinkDeps: () => ({ account: { getAddress: () => "0xme" } }),
}))
vi.mock("../src/features/paylink/chainTime", () => ({ usePolledChainSeconds: () => undefined }))
// The ticket signup's review continuation is out of scope here: Home's phone layout is the subject.
vi.mock("../src/features/paylink/ticketContinuation", () => ({
  ticketSignupContinuation: () => null,
  ticketHoldNotice: () => undefined,
}))
vi.mock("../src/features/withdraw/withdrawGateway", () => ({
  getWithdrawalStore: () => ({ list: () => [] }),
}))
vi.mock("../src/features/onboarding/registrationTerms", () => ({
  PAYLINK_TICKET_REFUSED_MESSAGE: "this payment's ticket did not waive the tag price",
  useDepositSkim: () => undefined,
  useSweepDeductions: () => undefined,
}))
vi.mock("../src/features/onboarding/steps/ClaimReviewStep", () => ({ ClaimReviewStep: () => null }))
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
vi.mock("../src/ui/prefs", () => ({ useHideBalances: () => [false, vi.fn()] }))
vi.mock("../src/ui/hooks", () => ({ writeClipboard: vi.fn() }))
vi.mock("../src/ui/screens/useActivityEntries", () => ({
  useActivityEntries: () => ({
    entries: [
      { id: "request", incomingRequest: true, node: (<div>Incoming request</div>) as ReactNode },
    ],
    hydrated: true,
  }),
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
  claimSponsoredLink.mockImplementation(async () => "0xclaimtx")
  resetRunningClaimsForTests()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const click = (label: string) =>
  act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!.click())
const renderHome = async (phone: boolean) => {
  state.phone = phone
  await act(async () =>
    root.render(
      <MemoryRouter>
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
      expect(host.textContent).toContain("Secure name")
      expect(host.textContent).toContain("Register name")
      expect(host.textContent!.indexOf("Incoming request")).toBeLessThan(
        host.textContent!.indexOf("Deposit funds"),
      )
      expectNoLegacyClaim()
      for (const text of [
        "Invite friends",
        "iOS app release",
        "Send funds via paylink",
        "Share your @tag",
      ]) {
        expect(host.textContent!.includes(text)).toBe(!phone)
      }
      expect(host.querySelector(".ww-home__rail") !== null).toBe(!phone)
    },
  )

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
