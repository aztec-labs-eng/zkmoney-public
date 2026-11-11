/** Guards: /claim resumes a funded registration, starting the token only for a link-funded one. */
import { act, Component, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PendingRegistrationRecord } from "@obsidion/front-core"

const h = vi.hoisted(() => ({
  fireEvent: vi.fn(),
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useScreener: () => ({ screen: async () => ({ compliant: true }) }),
}))
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  l1PublicClient: () => ({ readContract: async () => 0n }),
}))
vi.mock("../../../src/session/useL1Wallet", () => ({
  useL1Wallet: () => ({ account: null, walletName: null, connect: vi.fn() }),
}))
vi.mock("../../../src/session/l1Wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/session/l1Wallet")>()),
  getL1Clients: vi.fn(),
}))
vi.mock("../../../src/ui/screening", () => ({
  ScreeningNotice: () => null,
  useScreenedAddress: () => ({ verdict: null, cleared: true, rescreen: vi.fn() }),
}))
vi.mock("../../../src/lib/analytics", () => ({
  fireEvent: h.fireEvent,
  fireOnboardingEvent: h.fireEvent,
  reportLanding: vi.fn(),
  lapTimer: () => () => 0,
  failureCode: () => "err",
}))
// The DS drags in liquid-glass optics jsdom can't render; these tests are about what mounts.
vi.mock("@obsidion/web-ds", () => ({
  DoubleCheckIcon: () => null,
  Icon: () => null,
  Spinner: () => null,
  Card: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  TextField: ({ value, placeholder }: { value: string; placeholder?: string }) => (
    <input placeholder={placeholder} value={value} readOnly />
  ),
  GradientHeroCard: ({ title, subtitle }: { title?: ReactNode; subtitle?: ReactNode }) => (
    <div>
      {title}
      {subtitle}
    </div>
  ),
  GradientInitialAvatar: () => null,
  GradientText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  GradientSpinner: () => null,
  ConfirmationSheetDetailRow: ({ label, value }: { label: ReactNode; value: ReactNode }) => (
    <div>
      {label}
      {value}
    </div>
  ),
  IconCircle: () => null,
  AuroraBackground: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TopNavIconButton: ({ onClick, ariaLabel }: { onClick?: () => void; ariaLabel?: string }) => (
    <button aria-label={ariaLabel} onClick={onClick}>
      x
    </button>
  ),
  NumberedStepRow: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))

const { ClaimRoute } = await import("../../../src/features/paylink/PaylinkOnboardingScreen")
const { seedRegistration } = await import("../../support/registrationFixtures")

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const L2_ADDRESS = `0x${"cd".repeat(32)}`

/** An open reservation at its pending step, funded by a payment link or by an external deposit. */
async function seedPending(funding: "paylink" | "external") {
  await seedRegistration({
    account: ACCOUNT,
    tag: "taga",
    nameHash: `0x${"77".repeat(32)}`,
    l2Address: L2_ADDRESS,
    l1ChainId: 11155111,
    sipaAddress: "0x00000000000000000000000000000000000000c3",
    fee: "500000000000000000",
    beneficiary: ACCOUNT,
    depositToken: "0x00000000000000000000000000000000000000d4",
    broadcast: true,
    phase: "awaiting_deposit",
    retries: 0,
    startTime: Date.now(),
    terms: {
      deadline: Math.floor(Date.now() / 1000) + 7200,
      fee: "500000000000000000",
      minDeposit: "0",
      feeWaived: true,
      ...(funding === "paylink" ? { paylinkFunded: true, paylinkId: "id:paylink-frag" } : {}),
    },
  } as PendingRegistrationRecord)
}

/** Catches what a subtree throws; the app's root boundary would show "failed to start". */
class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    return this.state.error ? (
      <div data-testid="crash">{this.state.error.message}</div>
    ) : (
      this.props.children
    )
  }
}

let container: HTMLDivElement
let root: Root

const { closeSession } = await import("../../../src/session/session")
const { openTestSession } = await import("../../support/session")
/** Whether a host asked for the session's token and co-signer. */
let started: () => boolean
beforeEach(async () => {
  // The page's wallet is up; the token and co-signer build only when a host asks.
  const session = openTestSession({ wallet: { wallet: true, networkId: "0xrollup" }, sweepFee: 0n })
  started = () => session.assetsWanted.get()
  await session.registrations.ready
})
afterEach(closeSession)

beforeEach(async () => {
  vi.clearAllMocks()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  sessionStorage.clear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const render = (path: string, element: ReactNode) =>
  act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={path.startsWith("/claim") ? "/claim/:handle?" : path} element={element} />
        </Routes>
      </MemoryRouter>,
    )
  })

const crash = () => container.querySelector('[data-testid="crash"]')?.textContent ?? null

describe("the signup wizard with the token started", () => {
  it("/claim starts the token only to resume a registration a payment link funds", async () => {
    await seedPending("paylink")
    await render(
      "/claim/taga",
      <Boundary>
        <ClaimRoute />
      </Boundary>,
    )
    expect(crash()).toBeNull()
    expect(container.textContent).toContain("@taga")
    expect(started()).toBe(true)
  })

  it("/claim resumes an externally funded registration without the token", async () => {
    await seedPending("external")
    await render(
      "/claim/taga",
      <Boundary>
        <ClaimRoute />
      </Boundary>,
    )
    expect(crash()).toBeNull()
    expect(container.textContent).toContain("@taga")
    expect(started()).toBe(false)
  })
})
