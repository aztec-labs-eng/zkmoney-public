/**
 * Where the signup wizard renders, and what it may read there. Ordinary onboarding (/claim and the
 * /request pane) runs outside the wallet's asset layer, so the wizard itself must never read that
 * context; the paylink services a ticket-funded signup claims with reach it from a host mounted
 * inside the layer. The paylink hooks and front-core's asset provider are real here — the wizard's
 * own context read only ever passed with them mocked. Only the provider's PXE work is stubbed.
 */
import { act, Component, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AssetProvider, PendingRegistrationStore } from "@obsidion/front-core"
import type { PendingRegistrationRecord } from "@obsidion/front-core"

const h = vi.hoisted(() => ({
  /** What the asset layer holds once its PXE work is done. */
  asset: { tokenService: { token: true }, teeSigner: { tee: true } } as Record<string, unknown>,
  useAsset: vi.fn(),
  fireEvent: vi.fn(),
}))

// The provider's own hook does the PXE work (token registration, balance sync, enclave connect);
// the provider and the context read around it stay real.
vi.mock("../../front-core/dist/hooks/useAsset", () => ({
  useAsset: (...args: unknown[]) => {
    h.useAsset(...args)
    return h.asset
  },
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAccountContext: () => ({
    createAccount: vi.fn(),
    setObsidionAccount: vi.fn(),
    obsidionAccount: undefined,
  }),
  useAztecContext: () => ({ obsidionWallet: { wallet: true }, rollupAddress: "0xrollup" }),
  useContractServiceContext: () => ({ contractService: { service: true } }),
  useConfigValue: () => ({ value: true, setValue: vi.fn() }),
  useScreener: () => ({ screen: async () => ({ compliant: true }) }),
}))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({
    network: "testnet",
    l1ChainId: 11155111,
    l1RpcUrl: "http://127.0.0.1:8545",
    accountServiceUrl: "http://127.0.0.1:5060",
    accountServiceTestMode: false,
    admissionGate: false,
    campaignUrl: "",
    rpId: "localhost",
    rpName: "zk.money",
    l1Chain: { name: "Sepolia" },
  }),
}))
vi.mock("../src/features/onboarding/registrationTerms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/registrationTerms")>()),
  useDepositSkim: () => 0n,
  useSweepDeductions: () => ({ skim: 0n, fpcCut: 0n }),
}))
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: vi.fn(async () => ({ registry: "0x00000000000000000000000000000000000000e4" })),
  l1PublicClient: () => ({ readContract: async () => 0n }),
}))
vi.mock("../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => ({ account: null, walletName: null, connect: vi.fn() }),
  getL1Clients: vi.fn(),
}))
vi.mock("../src/ui/screening", () => ({
  ScreeningNotice: () => null,
  useScreenedAddress: () => ({ verdict: null, cleared: true, rescreen: vi.fn() }),
}))
vi.mock("../src/lib/analytics", () => ({
  fireEvent: h.fireEvent,
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

const { OnboardingScreen } = await import("../src/features/onboarding/OnboardingScreen")
const { ClaimRoute, PaylinkOnboardingScreen } = await import(
  "../src/features/paylink/PaylinkOnboardingScreen"
)
const { getPendingStore } = await import("../src/features/onboarding/webRegistration")
const { saveRegistrationTerms } = await import("../src/features/onboarding/registrationTerms")

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const L2_ADDRESS = `0x${"cd".repeat(32)}`

/** An open reservation at its pending step, funded by a payment link or by an external deposit. */
async function seedPending(funding: "paylink" | "external") {
  await getPendingStore().upsert(ACCOUNT, {}, {
    tag: "taga",
    nameHash: `0x${"77".repeat(32)}`,
    l2Address: L2_ADDRESS,
    l1ChainId: 11155111,
    sipaAddress: "0x00000000000000000000000000000000000000c3",
    depositToken: "0x00000000000000000000000000000000000000d4",
    broadcast: true,
    phase: "awaiting_deposit",
    retries: 0,
    startTime: Date.now(),
  } as Omit<PendingRegistrationRecord, "account">)
  saveRegistrationTerms({
    account: ACCOUNT,
    tag: "taga",
    deadline: Math.floor(Date.now() / 1000) + 7200,
    fee: "500000000000000000",
    minDeposit: "0",
    feeWaived: true,
    ...(funding === "paylink" ? { paylinkFunded: true, paylinkId: "id:paylink-frag" } : {}),
  })
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

beforeEach(async () => {
  vi.clearAllMocks()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
  localStorage.clear()
  sessionStorage.clear()
  await getPendingStore().load()
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

const wizardShown = () => container.querySelector("input[placeholder]") !== null
const crash = () => container.querySelector('[data-testid="crash"]')?.textContent ?? null

describe("the signup wizard outside the asset layer", () => {
  it("/claim renders the ordinary wizard with no asset context", async () => {
    await render(
      "/claim",
      <Boundary>
        <ClaimRoute assetOptions={undefined} />
      </Boundary>,
    )
    expect(crash()).toBeNull()
    expect(wizardShown()).toBe(true)
    expect(h.useAsset).not.toHaveBeenCalled()
  })

  it("the /request pane's embedded wizard renders with no asset context", async () => {
    await render(
      "/request",
      <Boundary>
        <OnboardingScreen embedded />
      </Boundary>,
    )
    expect(crash()).toBeNull()
    expect(wizardShown()).toBe(true)
    expect(h.useAsset).not.toHaveBeenCalled()
  })

  it("the paylink host is what reads the asset context, so it cannot mount outside the layer", async () => {
    await render(
      "/link",
      <Boundary>
        <PaylinkOnboardingScreen embedded ticketSignup />
      </Boundary>,
    )
    expect(crash()).toContain("useAssetContext must be used within an AssetProvider")
  })
})

describe("the signup wizard inside the asset layer", () => {
  it("the paylink host renders the wizard under the real provider", async () => {
    await render(
      "/link",
      <Boundary>
        <AssetProvider>
          <PaylinkOnboardingScreen embedded ticketSignup />
        </AssetProvider>
      </Boundary>,
    )
    expect(crash()).toBeNull()
    expect(wizardShown()).toBe(true)
    expect(h.useAsset).toHaveBeenCalled()
  })

  it("/claim mounts the layer only to resume a registration a payment link funds", async () => {
    await seedPending("paylink")
    await render(
      "/claim/taga",
      <Boundary>
        <ClaimRoute assetOptions={undefined} />
      </Boundary>,
    )
    expect(crash()).toBeNull()
    expect(container.textContent).toContain("@taga")
    expect(h.useAsset).toHaveBeenCalled()
  })

  it("/claim resumes an externally funded registration without the layer", async () => {
    await seedPending("external")
    await render(
      "/claim/taga",
      <Boundary>
        <ClaimRoute assetOptions={undefined} />
      </Boundary>,
    )
    expect(crash()).toBeNull()
    expect(container.textContent).toContain("@taga")
    expect(h.useAsset).not.toHaveBeenCalled()
  })
})
