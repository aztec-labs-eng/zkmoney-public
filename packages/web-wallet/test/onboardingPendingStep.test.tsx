import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { AccountStorage, PendingRegistrationStore, SIPADepositStore } from "@obsidion/front-core"
import {
  beginTicketSignupAccount,
  completeTicketSignupAccount,
  loadTicketSignupAccount,
  loadTicketSignupAttempt,
  restartTicketSignupAccount,
  saveTicketSignupAccount,
} from "../src/features/paylink/ticketSignupAccount"
import { setActiveCredentialId, setActiveStorageId } from "../src/platform/storage/activeStorage"
import { askedTotal } from "../src/features/onboarding/registrationAsk"
import {
  DEPOSIT_TERMS_PENDING,
  formatDepositAmount,
  formatDepositDue,
  formatDepositSeen,
} from "../src/features/onboarding/steps/DepositTermsRows"
import { CHAIN_READ_RETRY_MS } from "../src/features/onboarding/registrationTerms"
import { REGISTRATIONS_PAUSED_NOTICE } from "../src/features/onboarding/onboardingErrorCopy"
import type { PendingRegistrationRecord } from "@obsidion/front-core"
import type { Hex } from "viem"
import type { PasskeyRequestScope } from "@obsidion/passkey-web"
import {
  type HeldRequest,
  pageHide,
  passkeyEvents,
  passkeyTelemetryHarness,
} from "./support/passkeyTelemetryHarness"

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const NAME_HASH = `0x${"77".repeat(32)}` as Hex
const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  reloadIfSessionSwitched: vi.fn(() => false),
  prepareRefund: vi.fn(),
  recoverDeposit: vi.fn(),
  fireEvent: vi.fn(),
  showReportableError: vi.fn(),
  getClaimStatus: vi.fn(),
  claimTag: vi.fn(),
  collectOnboardingKeys: vi.fn(),
  reusePasskeyAccount: vi.fn(),
  resolveHandoff: vi.fn(),
  adoptHandoff: vi.fn(),
  buildRetrySignDeps: vi.fn(),
  runDetectionTick: vi.fn(),
  buildWebDetectionDeps: vi.fn(),
  createAccount: vi.fn(),
  setObsidionAccount: vi.fn(),
  getAuthService: vi.fn(),
  claimSponsoredLink: vi.fn(async () => "0xclaim"),
  viewLink: vi.fn(),
  obtainEmailClaimProof: vi.fn(),
  paylinkDeps: { wallet: true } as { wallet: boolean } | undefined,
  /** The signing account in the React context, as a host inside the wallet has it. */
  obsidionAccount: { getAddress: () => ({ toString: () => "0xacc" }) } as object | undefined,
  gateHook: () => ({
    gate: async () => ({ signal: new AbortController().signal, reach: "unknown" as const }),
    state: { kind: "idle" },
    cancel: () => {},
    dismiss: () => {},
  }),
  realNavigation: false,
  hasRootBreadcrumb: true,
  useRealLandingStep: false,
  asked: true,
  // Optional, so a test can render with a wallet that has not booted yet.
  aztec: { obsidionWallet: { wallet: true } } as { obsidionWallet?: { wallet: boolean } },
  config: {
    network: "testnet",
    l1ChainId: 11155111,
    l1RpcUrl: "http://127.0.0.1:8545",
    accountServiceUrl: "http://127.0.0.1:5060",
    accountServiceTestMode: false,
    admissionGate: false,
    /** Empty by default: a bare visit only leaves for a campaign a build actually names. */
    campaignUrl: "" as string | undefined,
    rpId: "localhost",
    rpName: "zk.money",
    l1Chain: { name: "Sepolia" },
  },
  /** What the fake registry answers for REGISTRATION_MIN / REGISTRATION_FEE. */
  amounts: { min: 0n, fee: 0n },
  /** Set to make the schedule read fail instead of answering `amounts`. */
  scheduleFails: false,
  /** How many times the controller's schedule was actually read. */
  scheduleReads: 0,
  skim: 0n,
  /** What the fake token answers for balanceOf(sipa). */
  balance: 0n,
  /** The oxide tuple the fake manifest serves. */
  tuple: { registry: "0x00000000000000000000000000000000000000e4" } as Record<string, string>,
  l1: { account: null as string | null, walletName: null as string | null, connect: vi.fn() },
  /** The visitor page's voucher read: the link can pay its own way out. */
  voucher: {
    uses: 1 as number | undefined,
    deps: { wallet: true },
    error: undefined,
    retry: vi.fn(),
  },
  /** The network's ticket offer the visitor page reads. */
  offer: {
    offer: {
      threshold: "2000000000000000000",
      schedule: { fee: "500000000000000000", minDeposit: "0" },
    },
    failed: false,
    retry: vi.fn(),
  },
}))

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>()
  return {
    ...actual,
    // Records every call; forwards to the real router when a test opts in.
    useNavigate: () => {
      const real = actual.useNavigate()
      return ((...args: unknown[]) => {
        ;(h.navigate as (...a: unknown[]) => void)(...args)
        if (h.realNavigation) (real as (...a: never[]) => unknown)(...(args as never[]))
      }) as ReturnType<typeof actual.useNavigate>
    },
  }
})
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAccountContext: () => ({
    createAccount: h.createAccount,
    setObsidionAccount: h.setObsidionAccount,
    obsidionAccount: h.obsidionAccount,
  }),
  useAztecContext: () => h.aztec,
  useScreener: () => ({ screen: async () => ({ compliant: true }) }),
  useContractServiceContext: () => ({ contractService: { service: true } }),
  useConfigValue: () => ({ value: h.asked, setValue: vi.fn() }),
}))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => h.config,
}))
// Availability has its own suite. Pending-registration walks start with a claimable tag, so keep
// their tag step independent of the probe's debounce and network response.
vi.mock("../src/features/onboarding/nameAvailability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/nameAvailability")>()),
  useNameAvailability: () => ({ status: "available" as const, checking: false }),
}))
vi.mock("../src/platform/auth/WebPasskeyIdentityMap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform/auth/WebPasskeyIdentityMap")>()),
  hasMskRootBreadcrumb: () => h.hasRootBreadcrumb,
}))
vi.mock("../src/features/onboarding/registrationTerms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/registrationTerms")>()),
  useDepositSkim: () => h.skim,
  useSweepDeductions: () => ({ skim: h.skim, fpcCut: 250_000_000_000_000_000n }),
}))
vi.mock("../src/lib/analytics", () => ({
  fireEvent: h.fireEvent,
  lapTimer: () => () => 0,
  failureCode: () => "err",
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
vi.mock("../src/features/onboarding/registrationQuoteRecovery", async (original) => ({
  ...(await original<object>()),
  prepareRegistrationRefund: h.prepareRefund,
}))
vi.mock("../src/features/deposit/sipaRecovery", async (original) => ({
  ...(await original<object>()),
  recoverDeposit: h.recoverDeposit,
}))
vi.mock("../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => h.l1,
  getL1Clients: vi.fn(),
}))
vi.mock("../src/ui/screening", () => ({
  ScreeningNotice: () => null,
  useScreenedAddress: () => ({ verdict: null, cleared: true, rescreen: vi.fn() }),
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: h.getAuthService,
  peekAuthService: h.getAuthService,
}))
// The ceremony gate has its own suite; here it is whatever `h.gateHook` says, a pass-through by
// default so the step walks never wait at the phone steps.
vi.mock("../src/features/identity/ceremonyGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/identity/ceremonyGate")>()),
  useCeremonyGate: () => {
    // The real hook re-renders its screen when a gate opens; the stub does the same so a test's
    // swapped state is picked up.
    const [, rerender] = React.useReducer((n: number) => n + 1, 0)
    const hook = h.gateHook()
    return {
      ...hook,
      gate: () => {
        const pending = hook.gate()
        rerender()
        return pending
      },
    }
  },
}))
// The DS drags in liquid-glass optics jsdom can't render; these tests are about surface + wiring.
// Fake fragments never decode; the binding only needs a stable name for one.
vi.mock("../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => `id:${fragment}`,
}))
vi.mock("@obsidion/web-ds", () => ({
  DoubleCheckIcon: () => null,
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PrimaryGradientButton: ({
    title,
    testId,
    onClick,
    isDisabled,
  }: {
    title: string
    testId?: string
    onClick?: () => void
    isDisabled?: boolean
  }) => (
    <button data-testid={testId} disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
  TextField: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string
    onChange?: (value: string) => void
    placeholder?: string
  }) => (
    <input placeholder={placeholder} value={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
  GradientHeroCard: ({
    title,
    subtitle,
    footer,
    avatar,
  }: {
    title?: React.ReactNode
    subtitle?: React.ReactNode
    footer?: React.ReactNode
    avatar?: React.ReactNode
  }) => (
    <div>
      {avatar}
      {title}
      {subtitle}
      {footer}
    </div>
  ),
  GradientInitialAvatar: () => null,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  GradientSpinner: () => <span>spinner</span>,
  ConfirmationSheetDetailRow: ({
    label,
    value,
  }: {
    label: React.ReactNode
    value: React.ReactNode
  }) => (
    <div>
      {label}
      {value}
    </div>
  ),
  Spinner: () => <span aria-label="Loading" />,
  IconCircle: () => null,
  AuroraBackground: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TopNavIconButton: ({ onClick, ariaLabel }: { onClick?: () => void; ariaLabel?: string }) => (
    <button aria-label={ariaLabel} onClick={onClick}>
      x
    </button>
  ),
  NumberedStepRow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("../src/features/onboarding/AnalyticsConsentModal", () => ({
  AnalyticsConsentModal: ({ onChoose }: { onChoose: (granted: boolean) => void }) => (
    <div>
      <button onClick={() => onChoose(true)}>Share anonymous data</button>
      <button onClick={() => onChoose(false)}>No thanks</button>
    </div>
  ),
}))
vi.mock("../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("../src/features/onboarding/steps/InvitationStep", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/features/onboarding/steps/InvitationStep")
  >()
  return {
    InvitationStep: (props: Parameters<typeof actual.InvitationStep>[0]) =>
      h.useRealLandingStep ? (
        <actual.InvitationStep {...props} />
      ) : (
        <div>
          <span data-testid="invite-probe">{String(props.checkAvailability)}</span>
          <button onClick={() => props.onUnlock("taga")}>landing-signin</button>
          {props.notice && (
            <span>
              {props.notice.kind === "taken"
                ? `taken:${props.notice.handle}`
                : props.notice.message}
            </span>
          )}
        </div>
      ),
  }
})
vi.mock("../src/features/onboarding/steps/ClaimTagModal", () => ({
  ClaimTagModal: ({
    busy,
    onClaim,
    onCancel,
    error,
  }: {
    busy: boolean
    onClaim: () => void
    onCancel: () => void
    error?: string
  }) => (
    <div>
      {busy ? "claim-modal-busy" : "claim-modal"}
      {error && <span>{error}</span>}
      <button onClick={onClaim}>claim-tag</button>
      <button onClick={onCancel}>cancel-op</button>
    </div>
  ),
  AllSetModal: () => <div>all-set</div>,
}))
vi.mock("../src/features/onboarding/steps/OnboardingCarousel", () => ({
  // The real carousel calls `onStart` on the first "Next →", which is the tap a hand-off's prompt
  // needs; the stub keeps both controls so a walk can make that tap.
  OnboardingCarousel: ({
    handle,
    onDone,
    onStart,
  }: {
    handle: string
    onDone: () => void
    onStart?: () => void
  }) => (
    <>
      <span>@{handle}.zk.money</span>
      {onStart && (
        <button data-testid="carousel-next" onClick={onStart}>
          Next →
        </button>
      )}
      <button onClick={onDone}>Let's go!</button>
    </>
  ),
}))
vi.mock("../src/features/onboarding/sessionReload", () => ({
  reloadIfSessionSwitched: h.reloadIfSessionSwitched,
}))
vi.mock("../src/features/onboarding/webRegistration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/webRegistration")>()),
  buildWebDetectionDeps: h.buildWebDetectionDeps,
  runDetectionTick: h.runDetectionTick,
}))
import { CeremonyRequiredError } from "../src/features/onboarding/oxideOnboarding"
vi.mock("../src/features/onboarding/oxideOnboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/oxideOnboarding")>()),
  getClaimStatus: h.getClaimStatus,
  claimTag: h.claimTag,
  collectOnboardingKeys: h.collectOnboardingKeys,
  reusePasskeyAccount: h.reusePasskeyAccount,
  resolveHandoff: h.resolveHandoff,
  adoptHandoff: h.adoptHandoff,
  buildRetrySignDeps: h.buildRetrySignDeps,
}))
vi.mock("../src/features/paylink/sponsoredPaylink", () => ({
  claimSponsoredLink: h.claimSponsoredLink,
  viewLink: h.viewLink,
}))
vi.mock("../src/features/paylink/emailClaim", () => ({
  obtainEmailClaimProof: h.obtainEmailClaimProof,
}))
// The paylink services reach the wizard through its host (`PaylinkOnboardingScreen`), so the
// /claim renders below pass them as that host would.
vi.mock("../src/features/paylink/usePaylinkDeps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/paylink/usePaylinkDeps")>()),
  usePaylinkKit: () => h.paylinkDeps,
  useLinkVoucher: () => h.voucher,
}))
vi.mock("../src/features/paylink/goldenTicketOffer", () => ({
  useGoldenTicketOffer: () => h.offer,
}))
// The real buildRetrySignDeps (below) fetches the registration env; stub it so the unit test needs
// no L1. The tuple carries portal/sipaFactory/token/accountMetadataRegistry so the SIPA deriver
// constructs offline.
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: vi.fn(async () => h.tuple),
  l1PublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "REGISTRATION_MIN"
        ? (h.scheduleReads++,
          h.scheduleFails ? Promise.reject(new Error("rpc down")) : h.amounts.min)
        : functionName === "REGISTRATION_FEE"
        ? h.amounts.fee
        : functionName === "depositFee"
        ? 0n
        : h.balance,
  }),
  oxideEnvFor: vi.fn(async () => ({
    tuple: {
      portal: "0x00000000000000000000000000000000000000e1",
      token: "0x00000000000000000000000000000000000000e3",
      registry: "0x00000000000000000000000000000000000000e4",
      accountMetadataRegistry: "0x00000000000000000000000000000000000000e8",
      sipaFactory: "0x00000000000000000000000000000000000000e7",
      rollupVersion: "3",
      ensDomain: "zk.money",
    },
    env: {
      registry: "0x00000000000000000000000000000000000000e4",
      factory: "0x00000000000000000000000000000000000000e5",
      ensDomain: "zk.money",
      resolverOperator: "0x00000000000000000000000000000000000000e6",
      rollupVersion: 3n,
      l1ChainId: 11155111,
      feeToken: "0x00000000000000000000000000000000000000e3",
      namePortalRecipient: `0x${"00".repeat(32)}`,
    },
    publicClient: {},
  })),
}))

const { OnboardingScreen } = await import("../src/features/onboarding/OnboardingScreen")
const { PaylinkVisitorScreen } = await import("../src/features/paylink/PaylinkVisitorScreen")
const { WithdrawalStorage } = await import("@obsidion/front-core")
const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")
const { LostRegistrationNoticeCard } = await import(
  "../src/features/onboarding/LostRegistrationNoticeCard"
)
const { applyIdentityOutcome, getPendingStore } = await import(
  "../src/features/onboarding/webRegistration"
)
const { NameTakenError, PasskeyMismatchError } = await import(
  "../src/features/onboarding/oxideOnboarding"
)
const realOxideOnboarding = await vi.importActual<
  typeof import("../src/features/onboarding/oxideOnboarding")
>("../src/features/onboarding/oxideOnboarding")
const { loadWalletIdentity, saveWalletIdentity } = await import(
  "../src/features/identity/walletIdentity"
)
const { loadRegistrationTerms, saveRegistrationTerms } = await import(
  "../src/features/onboarding/registrationTerms"
)
const { GateCancelledError } = await import("../src/features/identity/ceremonyGate")
const { isActivationPromptOpen, resetActivationPrompt } = await import(
  "../src/features/onboarding/activationPrompt"
)
const { CLAIM_STASH_KEY, TICKET_STASH_KEY, stashTicketSignup } = await import(
  "../src/features/paylink/claimStash"
)

const fakeAccount = {
  getAuthProvider: () => ({}),
  getAddress: () => ({ toString: () => L2_ADDRESS }),
  getCompleteAddress: () => ({ toString: () => L2_ADDRESS }),
}
const fakeKeys = {
  account: fakeAccount,
  secretKey: { toString: () => `0x${"11".repeat(32)}` },
  authProvider: {},
  pubkeyHex: `0x${"22".repeat(64)}`,
}
/** What `resolveHandoff` hands to `adoptHandoff`; nothing is read from it here. */
const fakeResolved = { recovered: {}, msk: fakeKeys.secretKey, slot: "first" }
const CLAIM = { signature: "0x", nonce: "1", deadline: "4102444800" }
const WAIVED_CLAIM = {
  ...CLAIM,
  terms: {
    fee: "500000000000000000",
    minDeposit: "0",
    nonce: "1",
    deadline: "4102444800",
    signature: "0x00",
  },
}

let container: HTMLDivElement
let root: Root

function baseRecord(
  over: Partial<PendingRegistrationRecord> = {},
): Omit<PendingRegistrationRecord, "account"> {
  return {
    tag: "taga",
    nameHash: NAME_HASH,
    l2Address: L2_ADDRESS,
    l1ChainId: 11155111,
    sipaAddress: "0x00000000000000000000000000000000000000c3",
    depositToken: "0x00000000000000000000000000000000000000d4",
    broadcast: true,
    phase: "awaiting_deposit",
    retries: 0,
    startTime: Date.now(),
    ...over,
  }
}

const seedRecord = (over: Partial<PendingRegistrationRecord> = {}) =>
  getPendingStore().upsert(ACCOUNT, {}, baseRecord(over))

/** The reduced schedule an earned tag signs: the tag price waived, the relayer's 0.5 cut kept. */
const REDUCED_FEE = String(5n * 10n ** 17n)
/** The reduced schedule a waived claim carries. */
const TERMS = {
  fee: REDUCED_FEE,
  minDeposit: "10000000000000000000",
  nonce: "1",
  deadline: "9999999999",
  signature: "0x00",
  reduced: true,
}

/** A live claim the service signed without a schedule — the one state the controller prices. */
const unsignedTerms = () =>
  saveRegistrationTerms({
    account: ACCOUNT,
    tag: "taga",
    deadline: Math.floor(Date.now() / 1000) + 7200,
    feeWaived: false,
  })

/** A live reservation whose fee the campaign waived — the only state that may log out. */
const waivedTerms = () =>
  saveRegistrationTerms({
    account: ACCOUNT,
    tag: "taga",
    deadline: Math.floor(Date.now() / 1000) + 7200,
    fee: REDUCED_FEE,
    minDeposit: String(10n * 10n ** 18n),
    feeWaived: true,
  })

/** Props the host passes; the visitor page's ticket signup sets `ticketSignup`. */
let screenProps: { ticketSignup?: boolean } = {}
afterEach(() => {
  screenProps = {}
})

const render = (path = "/claim", Screen = OnboardingScreen) =>
  act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/claim/:handle?"
            element={<Screen {...screenProps} paylinkKit={h.paylinkDeps as never} />}
          />
        </Routes>
      </MemoryRouter>,
    )
  })

const buttons = () => Array.from(container.querySelectorAll("button"))
/** The "Check again" text button under the address — the step's manual check. */
const checkControl = () => buttons().find((b) => b.textContent === "Check again") ?? null
const clickCheck = () =>
  act(async () => {
    const target = checkControl()
    if (!target) throw new Error("no check control beside the address")
    target.click()
  })
const button = (label: string) => buttons().find((b) => b.textContent === label)
/** The terms CTA carries the quote ("Deposit $11.00"), so the walks click it by its verb. */
const clickDeposit = () =>
  act(async () => {
    const target = buttons().find((b) => b.textContent?.startsWith("Deposit"))
    if (!target) throw new Error(`no Deposit button — have: ${buttons().map((b) => b.textContent)}`)
    target.click()
  })
/** The intro's first tap: the hand-off's ceremony rides on it. */
const enterHandoff = () =>
  act(async () => {
    const target = container.querySelector<HTMLButtonElement>('[data-testid="carousel-next"]')
    if (!target)
      throw new Error(`no carousel control — have: ${buttons().map((b) => b.textContent)}`)
    target.click()
  })
/** The intro's last tap, with no account yet: the terms sheet, which carries the prompt. */
const leaveIntro = () => click("Let's go!")
const click = (label: string) =>
  act(async () => {
    const target = button(label)
    if (!target) {
      throw new Error(`no button "${label}" — have: ${buttons().map((b) => b.textContent)}`)
    }
    target.click()
  })

/** A live session that claimed and went pending: keysRef holds the wizard keys. */
async function walkToPendingWithKeys(recordOver: Partial<PendingRegistrationRecord> = {}) {
  h.claimTag.mockImplementation(async (tag: string) => {
    await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag, ...recordOver }))
    return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
  })
  await render("/claim/taga")
  await click("landing-signin")
  await act(async () =>
    buttons()
      .find((b) => b.textContent?.startsWith("Deposit"))!
      .click(),
  )
  expect(container.textContent).toContain("@taga")
}

/** Lets the async registry amounts read land. */
const settleReads = () => act(async () => new Promise((r) => setTimeout(r, 0)))

/** One deposit-terms figure, by row, with no sentence around it. */
const termsValue = (id: string) =>
  container.querySelector(`[data-testid="deposit-terms-${id}"]`)?.textContent ?? undefined
const summary = () =>
  container.querySelector('[data-testid="registration-sheet-summary"]')?.textContent ?? ""
const paused = () =>
  container.querySelector('[data-testid="registrations-paused"]')?.textContent ?? ""
/** Amounts are built from the same formatters the screen prices with, never from its sentences. */
const decimals = () => tokenDecimalsForNetwork(h.config.network as never)
const usd = (amount: bigint) => formatDepositAmount(amount, decimals())
/** A deposit the screen asks for, rounded the way it asks. */
const due = (amount: bigint) => formatDepositDue(amount, decimals())
/** An amount already at the address. */
const seen = (amount: bigint) => formatDepositSeen(amount, decimals())
const ask = (kind: "standard" | "earned_tag") => due(askedTotal(kind))

beforeEach(async () => {
  vi.clearAllMocks()
  h.getAuthService.mockReset()
  h.reloadIfSessionSwitched.mockReset().mockReturnValue(false)
  // The asked total must come from the constants here, never from a developer's .env.local.
  vi.stubEnv("VITE_REGISTRATION_ASK_DEPOSIT_TOTAL", "")
  ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
  ;(SIPADepositStore as unknown as { instance: unknown }).instance = null
  h.prepareRefund.mockReset()
  h.recoverDeposit.mockReset()
  h.l1.account = null
  localStorage.clear()
  sessionStorage.clear()
  await getPendingStore().load()
  h.realNavigation = false
  h.hasRootBreadcrumb = true
  h.useRealLandingStep = false
  h.gateHook = () => ({
    gate: async () => ({ signal: new AbortController().signal, reach: "unknown" as const }),
    state: { kind: "idle" },
    cancel: () => {},
    dismiss: () => {},
  })
  h.asked = true
  h.getClaimStatus.mockResolvedValue("reserved")
  h.balance = 0n
  h.config.admissionGate = false
  h.amounts = { min: 0n, fee: 0n }
  // The sandbox relayer's cut, and what a waived schedule's whole fee is.
  h.skim = 5n * 10n ** 17n
  h.scheduleFails = false
  h.scheduleReads = 0
  h.tuple = { registry: "0x00000000000000000000000000000000000000e4" }
  h.createAccount.mockImplementation(async (...args: unknown[]) => {
    const opts = args[5] as
      | { onAccountCreated?: (created: { credentialId: string; l2Address: string }) => void }
      | undefined
    await opts?.onAccountCreated?.({ credentialId: "new-ticket-passkey", l2Address: L2_ADDRESS })
    setActiveCredentialId("new-ticket-passkey")
    return fakeAccount
  })
  h.collectOnboardingKeys.mockResolvedValue(fakeKeys)
  h.reusePasskeyAccount.mockResolvedValue(fakeKeys)
  // The default hand-off holds no bridge material: the attempt made with no tap is refused, and
  // the tap's own attempt resolves.
  h.resolveHandoff.mockImplementation((...args: unknown[]) =>
    args[6] ? Promise.reject(new CeremonyRequiredError()) : Promise.resolve(fakeResolved),
  )
  h.adoptHandoff.mockImplementation(
    async (_wallet, _resolved, beforeCommit?: () => Promise<void>) => {
      await beforeCommit?.()
      return fakeKeys
    },
  )
  h.buildRetrySignDeps.mockReturnValue({ sign: true })
  h.runDetectionTick.mockResolvedValue("pending")
  h.buildWebDetectionDeps.mockImplementation(async (_config: unknown, extras = {}) => ({
    ...extras,
  }))
  h.claimSponsoredLink.mockResolvedValue("0xclaim")
  h.viewLink.mockResolvedValue({ flavor: "direct" })
  h.obtainEmailClaimProof.mockResolvedValue({ vkey: [], proof: [], public_inputs: [] })
  h.paylinkDeps = { wallet: true }
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe("pending step — a policy refusal on retry", () => {
  it("renders the refusal in place with its own retry, never the report modal", async () => {
    const { PhoneRequiredError } = await import("@obsidion/passkey-web")
    await seedRecord({ broadcast: false, fundedAt: Date.now() })
    h.reusePasskeyAccount.mockRejectedValueOnce(new PhoneRequiredError())
    await render("/claim/taga")
    await click("Retry")
    const refused = container.querySelector<HTMLElement>('[data-testid="pending-refused"]')
    expect(refused?.dataset.reason).toBe("PhoneRequiredError")
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(h.fireEvent).toHaveBeenCalledWith("action_failed", {
      action: "pending_retry",
      code: "err",
    })

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="pending-retry"]')!.click(),
    )
    expect(h.reusePasskeyAccount).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-testid="pending-refused"]')).toBeNull()
  })
})

describe("pending step — a refusal another attempt cannot fix", () => {
  it("leaves Log out as the only way on, with no Retry anywhere", async () => {
    const { RotatedCredentialError } = await import("@obsidion/passkey-web")
    await seedRecord({ broadcast: false, fundedAt: Date.now(), startTime: Date.now() - 6 * 60_000 })
    h.reusePasskeyAccount.mockRejectedValueOnce(new RotatedCredentialError())
    await render("/claim/taga")
    await click("Retry")
    const refused = container.querySelector<HTMLElement>('[data-testid="pending-refused"]')
    expect(refused?.dataset.reason).toBe("RotatedCredentialError")
    expect(container.querySelector('[data-testid="pending-retry"]')).toBeNull()
    expect(button("Retry")).toBeUndefined()
    expect(container.querySelector('[data-testid="pending-log-out"]')).not.toBeNull()
  })

  it("a record that closes while the retry waits at the phone steps takes the sheet down, and nothing more", async () => {
    const cancel = vi.fn()
    const dismiss = vi.fn()
    h.gateHook = () => ({
      gate: () => new Promise<never>(() => {}),
      state: { kind: "awaiting-action", proceed: () => {} },
      cancel,
      dismiss,
    })
    await seedRecord({ broadcast: false, fundedAt: Date.now() })
    await render("/claim/taga")
    cancel.mockClear()
    dismiss.mockClear()
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, { phase: "confirmed" })
    })
    expect(dismiss).toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it("leaving the screen past the prompt ends the retry's attempt, and nothing ticks", async () => {
    const cancel = vi.fn()
    h.gateHook = () => ({
      gate: async () => ({ signal: new AbortController().signal, reach: "unknown" as const }),
      state: { kind: "idle" },
      cancel,
      dismiss: () => {},
    })
    await seedRecord({ broadcast: false, fundedAt: Date.now() })
    h.reusePasskeyAccount.mockImplementation(
      async (_w: unknown, _a: unknown, _h: unknown, gate: () => Promise<unknown>) => {
        await gate()
        await new Promise(() => {})
      },
    )
    await render("/claim/taga")
    await click("Retry")
    cancel.mockClear()
    await act(async () => root.unmount())
    root = createRoot(container)
    expect(cancel).toHaveBeenCalled()
    expect(h.runDetectionTick).not.toHaveBeenCalled()
  })

  it("closing the sheet while the held key is being adopted ends the retry", async () => {
    await seedRecord({ broadcast: false, fundedAt: Date.now() })
    waivedTerms()
    let scope: AbortSignal | undefined
    h.reusePasskeyAccount.mockImplementation(
      async (_w: unknown, _a: unknown, _h: unknown, _gate: unknown, signal: AbortSignal) => {
        scope = signal
        await new Promise(() => {})
      },
    )
    await render("/claim/taga")
    await click("Retry")
    expect(scope?.aborted).toBe(false)
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    expect(close).not.toBeNull()
    await act(async () => close!.click())
    expect(scope?.aborted).toBe(true)
    expect(h.runDetectionTick).not.toHaveBeenCalled()
  })
})

describe("pending step — the whole surface pins the record's tag", () => {
  it("route handle for another tag feeds nothing: heading, urgency, prefill, and the re-publish target", async () => {
    await seedRecord({
      broadcast: false,
      fundedAt: Date.now(),
      startTime: Date.now() - 6 * 60_000,
    })
    await render("/claim/tagb")

    expect(container.textContent).toContain("@taga")
    expect(container.textContent).toContain("@taga is taking longer than usual")
    expect(container.textContent).not.toContain("tagb")

    await click("Retry")
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      L2_ADDRESS,
      { credentialId: undefined, pubkeyHex: undefined },
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
  })
})

describe("pending step — an escalated unpublished claim keeps its retry", () => {
  it("the route Home leads to still offers Retry, and one click runs a forced tick", async () => {
    await seedRecord({ broadcast: false, retries: 3, startTime: Date.now() - 3_600_000 })
    await render("/claim/taga")
    expect(button("Retry")).toBeTruthy()
    await click("Retry")
    expect(h.reusePasskeyAccount).toHaveBeenCalledTimes(1)
    expect(h.runDetectionTick).toHaveBeenCalledTimes(1)
    expect(h.runDetectionTick.mock.calls[0][1]).toMatchObject({ force: true })
  })
})

describe("pending step — an unbroadcast claim re-publishes beside the check", () => {
  it("one click reuses the pinned passkey and ticks", async () => {
    await seedRecord({ broadcast: false })
    await render()
    expect(checkControl()).toBeTruthy()
    expect(button("Retry")).toBeTruthy()

    h.runDetectionTick.mockImplementation(async () => {
      await getPendingStore().close(ACCOUNT, "confirmed")
      return "confirmed"
    })
    await click("Retry")
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      L2_ADDRESS,
      { credentialId: undefined, pubkeyHex: undefined },
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(h.setObsidionAccount).toHaveBeenCalledWith(fakeAccount)
    expect(h.runDetectionTick).toHaveBeenCalledTimes(1)
    // Confirmed on this leg ends at the identity write + home — finishOnboarding never runs.
    expect(loadWalletIdentity()).toMatchObject({ handle: "taga", address: L2_ADDRESS })
    expect(loadWalletIdentity()?.pending).toBeUndefined()
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(container.textContent).not.toContain("all-set")
    expect(h.fireEvent).not.toHaveBeenCalledWith("onboarding_completed", expect.anything())
    expect(h.createAccount).not.toHaveBeenCalled()
  })

  it("a missing passkey renders inline copy, never the error modal", async () => {
    await seedRecord({ broadcast: false })
    await render()
    const err = new Error("no credential")
    err.name = "NotAllowedError"
    h.reusePasskeyAccount.mockRejectedValue(err)

    await click("Retry")
    expect(container.textContent).toContain("Couldn't find your passkey")
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(h.runDetectionTick).not.toHaveBeenCalled()
  })

  it("a mismatched passkey stops inline with nothing staged and no tick", async () => {
    await seedRecord({ broadcast: false })
    await render()
    h.reusePasskeyAccount.mockRejectedValue(new PasskeyMismatchError())

    await click("Retry")
    expect(container.textContent).toContain("isn't the passkey this claim was started with")
    expect(h.setObsidionAccount).not.toHaveBeenCalled()
    expect(h.runDetectionTick).not.toHaveBeenCalled()
    expect(h.showReportableError).not.toHaveBeenCalled()
  })
})

describe("pending step — escape, custody, and background closes", () => {
  it("a paid tag has no exit at all: mid-purchase, leaving strands it", async () => {
    await seedRecord()
    await render()
    expect(button("Start over")).toBeUndefined()
    expect(button("Log out")).toBeUndefined()
    expect(container.querySelector('button[aria-label="Close"]')).toBeNull()
  })

  it("a waived tag can log out: there is nothing to strand", async () => {
    await seedRecord()
    waivedTerms()
    await render()
    expect(button("Start over")).toBeUndefined()
    expect(button("Log out")).toBeTruthy()
  })

  it("a lost race closed by a background tick steers to the landing with the full outcome", async () => {
    await seedRecord()
    await render()
    await act(async () => {
      await getPendingStore().close(ACCOUNT, "failed_taken")
    })

    expect(h.navigate).toHaveBeenCalledWith("/claim", { replace: true })
    expect(container.textContent).toContain("landing-signin")
    expect(container.textContent).toContain("Tag not available")
  })

  it("a lost race drops the terms the closed record was priced by", async () => {
    await seedRecord()
    waivedTerms()
    await render()
    await act(async () => {
      await getPendingStore().close(ACCOUNT, "failed_taken")
    })

    expect(loadRegistrationTerms(ACCOUNT, "taga")).toBeNull()
  })

  it("a lost race keeps terms another open record is priced by", async () => {
    // One key holds one registration's terms; the restart must not take a live one's floor with it.
    const OTHER_ACCOUNT = "0x00000000000000000000000000000000000000ab"
    await getPendingStore().upsert(
      OTHER_ACCOUNT,
      {},
      baseRecord({ tag: "otherta", startTime: Date.now() - 60_000 }),
    )
    await seedRecord()
    saveRegistrationTerms({
      account: OTHER_ACCOUNT,
      tag: "otherta",
      deadline: Math.floor(Date.now() / 1000) + 7200,
      fee: REDUCED_FEE,
      minDeposit: String(10n * 10n ** 18n),
      feeWaived: true,
    })
    await render()
    await act(async () => {
      await getPendingStore().close(ACCOUNT, "failed_taken")
    })

    expect(loadRegistrationTerms(OTHER_ACCOUNT, "otherta")?.feeWaived).toBe(true)
  })

  it("a background confirm without a wallet identity steers to enter, never fabricating one", async () => {
    vi.useFakeTimers()
    await seedRecord()
    await render()
    await act(async () => {
      await getPendingStore().close(ACCOUNT, "confirmed")
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600)
    })
    expect(h.navigate).toHaveBeenCalledWith("/enter", { replace: true })
    expect(loadWalletIdentity()).toBeNull()
  })

  it("a background confirm with the tag's identity settles home", async () => {
    vi.useFakeTimers()
    await seedRecord()
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1 })
    await render()
    await act(async () => {
      await getPendingStore().close(ACCOUNT, "confirmed")
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600)
    })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a held tick that loses to a needs_recovery close never fabricates the identity", async () => {
    await seedRecord({ broadcast: false })
    await render()
    let release!: (outcome: "pending") => void
    h.runDetectionTick.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    await click("Retry")
    expect(h.runDetectionTick).toHaveBeenCalledTimes(1)

    // A background tick settles needs_recovery while ours is held: identity retracted, record
    // closed confirmed — the ambiguous phase must never be read as a win.
    await act(async () => {
      saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
      applyIdentityOutcome("needs_recovery")
      await getPendingStore().close(ACCOUNT, "confirmed")
    })
    await act(async () => release("pending"))

    expect(loadWalletIdentity()).toBeNull()
    expect(h.navigate).toHaveBeenCalledWith("/enter", { replace: true })
    expect(h.navigate).not.toHaveBeenCalledWith("/", { replace: true })
  })

  it("terminal steering lands on a claim landing whose tag input is editable", async () => {
    h.realNavigation = true
    h.useRealLandingStep = true
    await seedRecord()
    await render("/claim/taga")
    h.runDetectionTick.mockImplementation(async () => {
      await getPendingStore().close(ACCOUNT, "failed_terminal")
      return "failed"
    })
    await clickCheck()

    const input = container.querySelector("input")
    expect(input).toBeTruthy()
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!
      .set!
    await act(async () => {
      setValue.call(input!, "freshtag")
      input!.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("freshtag")
  })
})

describe("pending step — deferred broadcast behind the revealed address", () => {
  const walkDeferred = async (done: Promise<boolean>) => {
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag, broadcast: false }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT, broadcastDone: done }
    })
    await render("/claim/taga")
    await click("landing-signin")
    await act(async () =>
      buttons()
        .find((b) => b.textContent?.startsWith("Deposit"))!
        .click(),
    )
  }

  it("reveals the address while publishing, holds the retry, then relaxes when it lands", async () => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    let release!: (ok: boolean) => void
    await walkDeferred(new Promise<boolean>((r) => (release = r)))
    // Address on screen, broadcast still in flight: publishing note, no retry pill.
    expect(container.textContent).toContain("0x000000...0000c3")
    expect(container.textContent).toContain("Publishing your deposit address…")
    expect(button("Retry")).toBeUndefined()
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, { broadcast: true })
      release(true)
    })
    expect(container.textContent).not.toContain("Publishing your deposit address…")
    expect(h.buildRetrySignDeps).not.toHaveBeenCalled()
  })

  it("a signup that chose the deposit starts its proof on the pending step, not before", async () => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    const start = vi.fn(async () => true)
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag, broadcast: false }))
      return {
        kind: "pending",
        claim: CLAIM,
        oxideAccount: ACCOUNT,
        broadcastDone: new Promise<boolean>(() => {}),
        startBroadcast: start,
      }
    })
    await render("/claim/taga")
    await click("landing-signin")
    await act(async () =>
      buttons()
        .find((b) => b.textContent?.startsWith("Deposit"))!
        .click(),
    )
    // The address is on screen and the proof behind it has begun: the step reports the publishing.
    expect(container.textContent).toContain("0x000000...0000c3")
    expect(start).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("Publishing your deposit address…")
  })

  it("a free name entering first lands on the wallet with the activation sheet before its proof starts", async () => {
    resetActivationPrompt()
    const start = vi.fn(async () => true)
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag, broadcast: false }))
      return {
        kind: "pending",
        claim: {
          ...CLAIM,
          deadline: "4102444800",
          terms: { ...TERMS, minDeposit: "4500000000000000000" },
        },
        oxideAccount: ACCOUNT,
        broadcastDone: new Promise<boolean>(() => {}),
        startBroadcast: start,
      }
    })
    try {
      await render("/claim/taga?fee=waived")
      await click("landing-signin")
      await click("I'll do this later")
      expect(container.textContent).toContain("all-set")
      // Nothing proves while the intro plays: the page is the user's.
      expect(start).not.toHaveBeenCalled()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_600))
      })
      await click("Let's go!")
      expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
      // Home is up with the activation sheet raised; only now does the proof start behind them.
      expect(isActivationPromptOpen()).toBe(true)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      expect(start).toHaveBeenCalledTimes(1)
    } finally {
      resetActivationPrompt()
    }
  })

  it("a failed deferred broadcast retries once in-session without a prompt", async () => {
    h.buildRetrySignDeps.mockResolvedValue({ sign: true })
    h.runDetectionTick.mockResolvedValue("pending")
    let release!: (ok: boolean) => void
    await walkDeferred(new Promise<boolean>((r) => (release = r)))
    const ticksBefore = h.runDetectionTick.mock.calls.length
    await act(async () => {
      release(false)
    })
    // The silent retry ran a forced tick armed with sign deps — no passkey ceremony involved.
    expect(h.runDetectionTick.mock.calls.length).toBe(ticksBefore + 1)
    const [, opts] = h.runDetectionTick.mock.calls.at(-1)!
    expect(opts).toMatchObject({ force: true })
    const [, extras] = h.buildWebDetectionDeps.mock.calls.at(-1)!
    await (extras as { getSignDeps: () => Promise<unknown> }).getSignDeps()
    expect(h.buildRetrySignDeps).toHaveBeenCalledTimes(1)
    expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
  })
})

describe("pending step — the status check runs itself", () => {
  it("re-checks the claim every interval without a click", async () => {
    vi.useFakeTimers()
    await seedRecord()
    await render()
    const calls = h.runDetectionTick.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24_050)
    })
    expect(h.runDetectionTick.mock.calls.length).toBe(calls + 1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24_000)
    })
    expect(h.runDetectionTick.mock.calls.length).toBe(calls + 2)
  })

  it("the note under the address carries the manual check as text, with no spinner", async () => {
    await walkToPendingWithKeys({ broadcast: false })
    let release!: (outcome: "pending") => void
    h.runDetectionTick.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    await clickCheck()
    expect(button("Checking…")!.disabled).toBe(true)
    await act(async () => release("pending"))
    expect(container.textContent).toContain("Checked just now · Check again")
    expect(checkControl()!.disabled).toBe(false)
    expect(container.querySelector('.ww-deposit-address-block [aria-label="Loading"]')).toBeNull()
  })
})

describe("pending step — the check control is the only affordance", () => {
  const states: [string, Partial<PendingRegistrationRecord>][] = [
    ["custody held", { fundedAt: Date.now() }],
    ["awaiting its deposit", {}],
    ["never broadcast", { broadcast: false }],
    ["escalated", { fundedAt: Date.now(), retries: 3 }],
  ]
  for (const [name, over] of states) {
    it(`a record ${name} offers the check and no register button`, async () => {
      await seedRecord(over)
      await render()
      expect(checkControl()).toBeTruthy()
      expect(buttons().some((b) => b.textContent?.startsWith("Register @"))).toBe(false)
    })
  }

  it("a custody-held record says the deposit is in", async () => {
    await seedRecord({ fundedAt: Date.now() })
    await render()
    expect(container.textContent).toContain("Your deposit is in")
  })
})

describe("pending step — urgency and wrong-chain states", () => {
  it("a record awaiting its deposit says what to do, and never ages into urgency", async () => {
    await seedRecord({ startTime: Date.now() - 60 * 60_000 })
    await render()
    expect(container.textContent).toContain("@taga is reserved for you")
    expect(container.textContent).toContain("@taga is reserved for you")
    expect(container.textContent).not.toContain("taking longer than usual")
  })

  it("the urgency copy flips in place once a funded record ages past the threshold", async () => {
    vi.useFakeTimers()
    await seedRecord({ fundedAt: Date.now(), startTime: Date.now() - 4.5 * 60_000 })
    await render()
    expect(container.textContent).not.toContain("taking longer than usual")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(container.textContent).toContain("@taga is taking longer than usual")
  })

  it("a wrong-chain record explains itself instead of offering the retry", async () => {
    await seedRecord({ l1ChainId: 1 })
    await render()
    expect(container.textContent).toContain("different network")
    expect(button("Register @taga")).toBeUndefined()
    expect(checkControl()).toBeNull()
  })
})

describe("check status — ordering fix and custody heuristic", () => {
  it("consults the terminal phase before the stored-hash success heuristic", async () => {
    // A promoted hash on a record a background tick closed failed must not read as success.
    await seedRecord({ fundedAt: Date.now() })
    await render()
    h.runDetectionTick.mockImplementation(async () => {
      await getPendingStore().close(ACCOUNT, "failed_taken")
      return "pending"
    })
    await clickCheck()

    expect(h.navigate).toHaveBeenCalledWith("/claim", { replace: true })
    expect(loadWalletIdentity()).toBeNull()
    expect(container.textContent).toContain("landing-signin")
  })

  it("custody on a reloaded tab enters on the record's identity, marked pending", async () => {
    await seedRecord({ fundedAt: Date.now() })
    await render()
    await clickCheck()

    expect(h.runDetectionTick.mock.calls[0][1]).toEqual({
      force: true,
      expectedRecord: { account: ACCOUNT, nameHash: NAME_HASH },
    })
    expect(loadWalletIdentity()).toMatchObject({
      handle: "taga",
      address: L2_ADDRESS,
      pending: true,
    })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })
})

describe("signup modals — chained create-then-claim (ULT-667)", () => {
  it("custody completes the signup: identity first, then All set! and the carousel", async () => {
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga")
    await click("landing-signin")
    expect(container.textContent).toContain("@taga.zk.money")
    // Deposit runs the passkey ceremony itself: no explainer click in between.
    await clickDeposit()
    expect(h.createAccount).toHaveBeenCalledTimes(1)

    // Identity saved BEFORE the carousel: closing the tab mid-carousel loses nothing.
    expect(loadWalletIdentity()).toMatchObject({ handle: "taga", address: L2_ADDRESS })
    // `named` mirrors the identity write: a handle was saved, so this is a named completion.
    expect(h.fireEvent).toHaveBeenCalledWith(
      "onboarding_completed",
      expect.objectContaining({ named: true }),
    )
    expect(container.textContent).toContain("all-set")

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600))
    })
    expect(container.querySelectorAll(".ww-modal-overlay")).toHaveLength(0)
    await click("Let's go!")
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("Let's go! asks for analytics consent before entering the wallet", async () => {
    h.asked = false
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600))
    })
    await click("Let's go!")
    expect(h.navigate).not.toHaveBeenCalled()
    await click("Share anonymous data")
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(h.fireEvent).toHaveBeenCalledWith("onboarding_started", {
      has_claim_link: true,
      entry: "link",
    })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("an already-claimed handle stays on the invitation page with a log-in lead", async () => {
    h.getClaimStatus.mockResolvedValue("claimed")
    await render("/claim/taga")
    await click("landing-signin")
    expect(container.textContent).toContain("taken:taga")
    expect(h.createAccount).not.toHaveBeenCalled()
  })

  it("a failed passkey ceremony shows an inline error and keeps the modal for retry", async () => {
    const err = new Error("nope")
    err.name = "NotAllowedError"
    h.createAccount.mockRejectedValueOnce(err)
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(container.textContent).toContain("passkey prompt was closed")
    expect(buttons().some((b) => b.textContent?.startsWith("Deposit"))).toBe(true)
    expect(h.showReportableError).not.toHaveBeenCalled()

    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await clickDeposit()
    expect(container.textContent).toContain("all-set")
  })

  it("resuming continues the session's own account, even with a previous account's name stored", async () => {
    // The device entered account A and still holds its named identity; the session pointers and
    // the proved cache belong to the unfinished account B whose signup is being picked back up.
    saveWalletIdentity({ handle: "alice", address: `0x${"aa".repeat(32)}`, claimedAt: 1 })
    const recoverFromCache = vi.fn(async () => ({
      credentialId: "cred-B",
      expectedAddress: L2_ADDRESS,
    }))
    h.getAuthService.mockReturnValue({ recoverFromCache, clear: vi.fn(), lockOut: vi.fn() })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga?resume=1")
    await click("landing-signin")
    await clickDeposit()

    expect(recoverFromCache).toHaveBeenCalled()
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      L2_ADDRESS,
      { credentialId: "cred-B" },
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(h.createAccount).not.toHaveBeenCalled()
    // No bounce back to sign-in: that is the loop this closes.
    expect(h.navigate).not.toHaveBeenCalledWith("/enter?handle=taga", { replace: true })
  })

  it("resuming continues the session's own account over a nameless identity another account left", async () => {
    // A signup found again on /enter: the session now holds account B, while account A's nameless
    // identity is still stored. Pinning the passkey to A's address would stop the signup.
    saveWalletIdentity({ address: `0x${"aa".repeat(32)}`, claimedAt: 1 })
    const recoverFromCache = vi.fn(async () => ({
      credentialId: "cred-B",
      expectedAddress: L2_ADDRESS,
    }))
    h.getAuthService.mockReturnValue({ recoverFromCache, clear: vi.fn(), lockOut: vi.fn() })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga?resume=1")
    await click("landing-signin")
    await clickDeposit()

    expect(h.reusePasskeyAccount).toHaveBeenCalledTimes(1)
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      L2_ADDRESS,
      { credentialId: "cred-B" },
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(h.navigate).not.toHaveBeenCalledWith("/enter?handle=taga", { replace: true })
  })

  it("resuming with no session key still continues a stored nameless identity", async () => {
    saveWalletIdentity({ address: L2_ADDRESS, claimedAt: 1 })
    h.getAuthService.mockReturnValue({
      rootCredentialId: async () => "cred-root",
      recoverFromCache: async () => undefined,
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga?resume=1")
    await click("landing-signin")
    await clickDeposit()
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      L2_ADDRESS,
      expect.anything(),
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(h.createAccount).not.toHaveBeenCalled()
  })

  it("outside resume a nameless identity still goes before the session key", async () => {
    saveWalletIdentity({ address: `0x${"aa".repeat(32)}`, claimedAt: 1 })
    const recoverFromCache = vi.fn(async () => ({
      credentialId: "cred-B",
      expectedAddress: L2_ADDRESS,
    }))
    h.getAuthService.mockReturnValue({
      rootCredentialId: async () => "cred-root",
      recoverFromCache,
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(recoverFromCache).not.toHaveBeenCalled()
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      `0x${"aa".repeat(32)}`,
      expect.anything(),
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
  })

  it("resuming with no key to recover from goes to the sign-in screen rather than minting a second one", async () => {
    h.getAuthService.mockReturnValue({
      recoverFromCache: async () => undefined,
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    await render("/claim/taga?resume=1")
    await click("landing-signin")
    await clickDeposit()
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
    expect(h.navigate).toHaveBeenCalledWith("/enter?handle=taga", { replace: true })
  })

  it("a name the server refuses returns to the field with the reason, keeping the resume path", async () => {
    h.getAuthService.mockReturnValue({
      recoverFromCache: async () => ({ credentialId: "cred-held", expectedAddress: L2_ADDRESS }),
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.claimTag.mockRejectedValue(new NameTakenError("reserved", "taga"))
    await render("/claim/taga?resume=1")
    await click("landing-signin")
    await clickDeposit()

    expect(container.textContent).toContain("another account's signup")
    // Not the retry modal: resubmitting the same name reaches the same refusal.
    expect(container.textContent).not.toContain("Try again")
    expect(h.navigate).toHaveBeenCalledWith("/claim?resume=1", { replace: true })
  })

  it("a session still holding a key for a recorded passkey reuses that account instead of minting", async () => {
    h.getAuthService.mockReturnValue({
      recoverFromCache: async () => ({ credentialId: "cred-held", expectedAddress: L2_ADDRESS }),
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      L2_ADDRESS,
      { credentialId: "cred-held" },
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(container.textContent).toContain("all-set")
  })

  it("a nameless identity reuses the session's passkey, not the newest root on the browser", async () => {
    const { setActiveCredentialId, setActiveStorageId } = await import(
      "../src/platform/storage/activeStorage"
    )
    saveWalletIdentity({ address: L2_ADDRESS, claimedAt: 1 })
    setActiveStorageId("s")
    setActiveCredentialId("cred-bound")
    h.getAuthService.mockReturnValue({
      rootCredentialId: async () => "cred-newer",
      recoverFromCache: async () => undefined,
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      L2_ADDRESS,
      { credentialId: "cred-bound" },
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
  })

  it("a nameless identity under a session with no passkey opens the chooser", async () => {
    const { clearActiveCredentialId, setActiveStorageId } = await import(
      "../src/platform/storage/activeStorage"
    )
    saveWalletIdentity({ address: L2_ADDRESS, claimedAt: 1 })
    setActiveStorageId("s")
    clearActiveCredentialId()
    h.getAuthService.mockReturnValue({
      rootCredentialId: async () => "cred-newer",
      recoverFromCache: async () => undefined,
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      L2_ADDRESS,
      { discover: true, chooser: true },
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
  })

  it("a policy refusal on create shows the refusal in the modal with a retry", async () => {
    const { PhoneRequiredError } = await import("@obsidion/passkey-web")
    h.createAccount.mockRejectedValueOnce(new PhoneRequiredError())
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    const refused = container.querySelector<HTMLElement>('[data-testid="create-refused"]')
    expect(refused?.dataset.reason).toBe("PhoneRequiredError")
    expect(container.textContent).toContain("Use your phone")
    expect(container.textContent).not.toContain("passkey prompt was closed")
    expect(h.showReportableError).not.toHaveBeenCalled()

    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await click("Try again")
    expect(h.createAccount).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("all-set")
  })

  it("a refusal another attempt cannot fix hides Deposit and offers Start over", async () => {
    const { RotatedCredentialError } = await import("@obsidion/passkey-web")
    h.createAccount.mockRejectedValueOnce(new RotatedCredentialError())
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    const refused = container.querySelector<HTMLElement>('[data-testid="create-refused"]')
    expect(refused?.dataset.reason).toBe("RotatedCredentialError")
    expect(container.querySelector('[data-testid="create-retry"]')).toBeNull()
    expect(buttons().some((b) => b.textContent?.startsWith("Deposit"))).toBe(false)
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="create-start-over"]')!.click(),
    )
    expect(container.textContent).toContain("landing-signin")
    expect(container.querySelector('[data-testid="create-refused"]')).toBeNull()
    // The next attempt starts clean: the refusal that ended the last one hides nothing now.
    await click("landing-signin")
    expect(buttons().some((b) => b.textContent?.startsWith("Deposit"))).toBe(true)
  })

  it("on a laptop the create step shows the phone steps until Continue, and Cancel releases the gate", async () => {
    const cancel = vi.fn()
    let opened = false
    h.gateHook = () => ({
      gate: () => {
        opened = true
        return new Promise<never>(() => {})
      },
      state: opened ? { kind: "awaiting-action", proceed: () => {} } : { kind: "idle" },
      cancel,
      dismiss: () => {},
    })
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    // The source stage answers first (no held key here), then the gate opens.
    await settleReads()
    expect(container.querySelector('[data-testid="phone-steps"]')).not.toBeNull()
    expect(container.textContent).toContain("Your new passkey will be saved")
    expect(container.textContent).not.toContain("signed up with")
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(container.querySelector('button[aria-label="Close"]')).toBeNull()

    await click("Cancel")
    expect(cancel).toHaveBeenCalled()
    expect(buttons().some((b) => b.textContent?.startsWith("Deposit"))).toBe(true)
    const dialog = container.querySelector("dialog")!
    await act(async () => {
      dialog.click()
    })
    expect(container.querySelector("dialog")).toBe(dialog)
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    expect(close).not.toBeNull()
    await act(async () => {
      close!.click()
    })
    expect(container.querySelector("dialog")).toBeNull()
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(getPendingStore().current()).toBeNull()
  })

  it("a failed claim after passkey lands on the claim retry modal", async () => {
    h.claimTag.mockRejectedValueOnce(new Error("down"))
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(container.textContent).toContain("claim-modal")
    expect(container.textContent).toContain("Couldn't claim your tag")
    expect(h.createAccount).toHaveBeenCalledTimes(1)
  })

  it("cancelling the claim spinner stops the wait; a landed op still completes truthfully", async () => {
    let release!: (outcome: unknown) => void
    h.claimTag.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(container.textContent).toContain("Preparing deposit address")

    await click("Cancel")
    expect(container.textContent).not.toContain("Preparing deposit address")
    // Cancelling the spinner does not cancel the request or make it safe to choose another tag.
    expect(container.querySelector('button[aria-label="Close"]')).toBeNull()

    // The op has no client-side abort — a submission that lands anyway surfaces the true outcome.
    await act(async () =>
      release({ kind: "custody", confirmed: false, oxideAccount: ACCOUNT, claim: CLAIM }),
    )
    expect(container.textContent).toContain("all-set")
    expect(loadWalletIdentity()).toMatchObject({ handle: "taga" })
  })
})

describe("modal overlay — one node for the whole step sequence (ULT-803)", () => {
  const overlay = () => container.querySelector(".ww-modal-overlay")
  const overlayCount = () => container.querySelectorAll(".ww-modal-overlay").length

  it("the invitation page has no overlay until a step opens", async () => {
    await render("/claim/taga")
    expect(overlay()).toBeNull()
    await click("landing-signin")
    expect(overlayCount()).toBe(1)
  })

  it("create → pending keeps the same overlay node", async () => {
    // A priced deployment, so the step lands on its ordinary reservation copy.
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    let release!: (outcome: unknown) => void
    h.claimTag.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(container.textContent).toContain("Preparing deposit address")
    const node = overlay()
    expect(node).not.toBeNull()

    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord())
      release({ kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT })
    })
    expect(container.textContent).toContain("reserved for you")
    expect(overlayCount()).toBe(1)
    expect(overlay()).toBe(node)
  })

  it("create → allset keeps the same overlay node", async () => {
    let release!: (outcome: unknown) => void
    h.claimTag.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    const node = overlay()
    expect(node).not.toBeNull()

    await act(async () =>
      release({ kind: "custody", confirmed: false, oxideAccount: ACCOUNT, claim: CLAIM }),
    )
    expect(container.textContent).toContain("all-set")
    expect(overlayCount()).toBe(1)
    expect(overlay()).toBe(node)
  })
})

describe("LostRegistrationNoticeCard", () => {
  const renderCard = () =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <LostRegistrationNoticeCard />
        </MemoryRouter>,
      )
    })

  it("terminal failure copy is generic-honest and steers back to claiming", async () => {
    await seedRecord()
    await getPendingStore().close(ACCOUNT, "failed_terminal")
    await renderCard()

    expect(container.textContent).toContain("pick another tag, or try this one again later")
    expect(container.textContent).not.toContain("different tag")
    await click("Start over")
    expect(h.navigate).toHaveBeenCalledWith("/claim")
  })

  it("needs_recovery steers to enter, never to a new claim", async () => {
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    applyIdentityOutcome("needs_recovery")
    await renderCard()

    expect(container.textContent).toContain("Enter with your passkey")
    await click("Enter with your passkey")
    expect(h.navigate).toHaveBeenCalledWith("/enter")
  })
})

describe("reusePasskeyAccount — pre-commit expectedL2Address verification", () => {
  const SECRET = { toString: () => `0x${"33".repeat(32)}` }
  const recovered = () => ({
    candidates: { first: SECRET },
    authProvider: { getPubkeys: async () => [Buffer.alloc(32, 1), Buffer.alloc(32, 2)] },
    credentialId: "cred-1",
    pubkey: `0x${"44".repeat(64)}`,
    authenticatorType: "platform",
  })

  it("a mismatched passkey mutates nothing — only the pure derivation ran", async () => {
    const commitSecret = vi.fn()
    const recordRecoveryMetadata = vi.fn()
    h.getAuthService.mockReturnValue({
      beginRecovery: async () => recovered(),
      recoverFromCache: async () => undefined,
      commitSecret,
      recordRecoveryMetadata,
    })
    const deriveAccountAddress = vi.fn(async () => ({ toString: () => `0x${"ee".repeat(32)}` }))
    const createObsidionAccount = vi.fn()
    const storageGet = vi.spyOn(AccountStorage, "get")

    await expect(
      realOxideOnboarding.reusePasskeyAccount(
        { deriveAccountAddress, createObsidionAccount } as never,
        L2_ADDRESS,
        undefined,
        async () => ({ signal: new AbortController().signal, reach: "unknown" as const }),
      ),
    ).rejects.toBeInstanceOf(PasskeyMismatchError)
    expect(deriveAccountAddress).toHaveBeenCalledTimes(1)
    expect(commitSecret).not.toHaveBeenCalled()
    expect(createObsidionAccount).not.toHaveBeenCalled()
    expect(recordRecoveryMetadata).not.toHaveBeenCalled()
    expect(storageGet).not.toHaveBeenCalled()
    storageGet.mockRestore()
  })

  it("a matching passkey proceeds to adoption", async () => {
    const commitSecret = vi.fn()
    const recordRecoveryMetadata = vi.fn()
    h.getAuthService.mockReturnValue({
      beginRecovery: async () => recovered(),
      recoverFromCache: async () => undefined,
      commitSecret,
      recordRecoveryMetadata,
    })
    const addWebauthnAccount = vi.fn()
    const storageGet = vi
      .spyOn(AccountStorage, "get")
      .mockReturnValue({ addWebauthnAccount } as never)
    const wallet = {
      deriveAccountAddress: vi.fn(async () => ({ toString: () => L2_ADDRESS })),
      createObsidionAccount: vi.fn(async () => fakeAccount),
    }

    const keys = await realOxideOnboarding.reusePasskeyAccount(
      wallet as never,
      L2_ADDRESS,
      undefined,
      async () => ({ signal: new AbortController().signal, reach: "unknown" as const }),
    )
    expect(keys.account).toBe(fakeAccount)
    expect(commitSecret).toHaveBeenCalledTimes(1)
    expect(recordRecoveryMetadata).toHaveBeenCalledTimes(1)
    expect(addWebauthnAccount).toHaveBeenCalledTimes(1)
    storageGet.mockRestore()
  })
})

describe("buildRetrySignDeps — re-broadcast half", () => {
  // The install's credential id is read from the stored passkey record.
  const storedCredential = () =>
    vi.spyOn(AccountStorage, "get").mockReturnValue({
      getWebAuthnDataForCurrentAccount: async () => ({ credentialId: "cred-alice" }),
    } as never)
  afterEach(() => vi.restoreAllMocks())

  it("arms on any deployment (bootstrap-key gated), with the deriver + broadcast wired", async () => {
    storedCredential()
    const deps = await realOxideOnboarding.buildRetrySignDeps(
      "alice",
      fakeKeys as never,
      h.config as never,
    )
    expect(typeof deps.deriveRegistrationSipa).toBe("function")
    expect(typeof deps.broadcast).toBe("function")
    expect(deps.accountService).toBeDefined()
    expect(deps.credentialId).toBe("cred-alice")
  })

  it("builds against a test-mode account-service too", async () => {
    storedCredential()
    const deps = await realOxideOnboarding.buildRetrySignDeps(
      "alice",
      fakeKeys as never,
      {
        ...h.config,
        accountServiceTestMode: true,
      } as never,
    )
    expect(deps.accountService).toBeDefined()
  })
})

describe("pending step — the deposit gate (registration-fee.md Campaign)", () => {
  // The reduced schedule: the fee is the relayer's cut, and `reduced` — not a zero fee — is what
  // makes it a free tag.
  const claimWithWaiver = () =>
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return {
        kind: "pending",
        claim: {
          ...CLAIM,
          deadline: "4102444800",
          terms: { ...TERMS, minDeposit: "4500000000000000000" },
        },
        oxideAccount: ACCOUNT,
      }
    })

  it.each([
    { phase: "awaiting_deposit" as const, balance: 0n },
    { phase: "awaiting_deposit" as const, balance: 5n * 10n ** 18n },
    { phase: "funded" as const, balance: 0n },
  ])("keeps original deposit status after a quote mismatch: %s", async ({ phase, balance }) => {
    await seedRecord({
      phase,
      broadcast: false,
      ...(phase === "funded" ? { fundedAt: Date.now() } : {}),
    })
    const original = getPendingStore().current()!
    h.balance = balance
    h.config.admissionGate = true
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: "5000000000000000000",
      minDeposit: "10000000000000000000",
      feeWaived: false,
    })
    await render("/claim/taga?fee=waived")
    await settleReads()
    expect(container.querySelector('[aria-label="Existing deposit status"]')).not.toBeNull()
    expect(container.textContent).toContain(original.sipaAddress)
    expect(checkControl()).not.toBeNull()
    expect(termsValue("total")).not.toBe(ask("standard"))
    expect(container.textContent).not.toContain("Return to the campaign")
    expect(button("Retry earned price")).toBeUndefined()
    if (balance >= 5n * 10n ** 18n) {
      expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
      expect(loadWalletIdentity()).toMatchObject({
        address: L2_ADDRESS,
        handle: "taga",
        pending: true,
      })
      const { hasWalletEntry } = await import("../src/features/identity/admission")
      expect(hasWalletEntry()).toBe(true)
      expect(getPendingStore().current()?.phase).toBe("awaiting_deposit")
      expect(getPendingStore().current()?.fundedAt).toBeUndefined()
    }
    if (balance >= 5n * 10n ** 18n) {
      expect(button("Retry")).toBeUndefined()
      expect(button("Recover deposit")).toBeDefined()
    } else if (phase === "awaiting_deposit") {
      // Nothing reached the address: a retry re-signs the same old-price commitment for nothing.
      expect(button("Retry")).toBeUndefined()
      expect(button("Register at earned price")).toBeDefined()
      expect(h.runDetectionTick).not.toHaveBeenCalled()
    } else {
      await click("Retry")
      expect(h.runDetectionTick).toHaveBeenCalled()
    }
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(getPendingStore().current()?.sipaAddress).toBe(original.sipaAddress)
    expect(loadRegistrationTerms(ACCOUNT)?.fee).toBe("5000000000000000000")
  })

  // The earned ask carries headroom over the earned floor; only a floor that outgrew the ask is a
  // mismatch, and the deposit panel stands for everything under it.
  it.each([
    { minDeposit: "4400000000000000000", mismatch: false },
    { minDeposit: "5000000000000000000", mismatch: true },
  ])("reads a signed earned floor against the earned ask: %s", async ({ minDeposit, mismatch }) => {
    await seedRecord({ phase: "awaiting_deposit", broadcast: false })
    h.balance = 0n
    h.config.admissionGate = true
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: "500000000000000000",
      minDeposit,
      feeWaived: true,
    })
    await render("/claim/taga?fee=waived")
    await settleReads()
    const mismatched = container.querySelector('[aria-label="Existing deposit status"]') !== null
    expect(mismatched).toBe(mismatch)
    if (mismatch) expect(termsValue("total")).toBeUndefined()
    else expect(termsValue("total")).toBe(ask("earned_tag"))
  })

  it("reopens admitted registration refund through real navigation and preserves wallet access", async () => {
    h.realNavigation = true
    h.config.admissionGate = true
    await seedRecord({ broadcast: false, retries: 3, startTime: Date.now() - 30 * 60_000 })
    const original = getPendingStore().current()!
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 1,
      fee: "10000000000000000000",
      minDeposit: "5000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    const savedTerms = loadRegistrationTerms(ACCOUNT)
    const { recordDepositAdmission, hasWalletEntry } = await import(
      "../src/features/identity/admission"
    )
    const { SecureNameNoticeCard } = await import("../src/features/onboarding/SecureNameNoticeCard")
    recordDepositAdmission(original, 5n * 10n ** 18n)
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route
              path="/"
              element={
                <div data-testid="wallet-home">
                  <SecureNameNoticeCard />
                </div>
              }
            />
            <Route path="/claim/:handle?" element={<OnboardingScreen />} />
          </Routes>
        </MemoryRouter>,
      ),
    )
    const openRecovery = () =>
      act(async () =>
        container
          .querySelector<HTMLButtonElement>("[data-testid='registration-pending-notice']")!
          .click(),
      )
    await openRecovery()
    await settleReads()
    expect(container.textContent).toContain("Recover deposit for @taga")
    expect(container.textContent).toContain(original.sipaAddress)
    expect(termsValue("total")).toBeUndefined()
    expect(button("Recover deposit")).toBeDefined()
    expect(button("Refresh deposit amount")).toBeUndefined()
    await clickCheck()
    expect(h.runDetectionTick).toHaveBeenCalled()
    expect(getPendingStore().current()?.sipaAddress).toBe(original.sipaAddress)
    expect(loadRegistrationTerms(ACCOUNT)).toEqual(savedTerms)
    expect(hasWalletEntry()).toBe(true)
    await click("Back to wallet")
    expect(container.querySelector("[data-testid='registration-pending-notice']")).not.toBeNull()
    await openRecovery()
    expect(button("Recover deposit")).toBeDefined()
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(),
    )
    expect(container.querySelector("[data-testid='registration-pending-notice']")).not.toBeNull()
    await openRecovery()
    vi.useFakeTimers()
    await act(async () => {
      saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1 })
      await getPendingStore().close(ACCOUNT, "confirmed")
    })
    await act(async () => vi.advanceTimersByTimeAsync(1_600))
    expect(container.querySelector("[data-testid='wallet-home']")).not.toBeNull()
    expect(container.textContent).not.toContain("Registration is still pending")
  })

  it("refunds the old deposit before opening a new earned-price address, with a manual completion action", async () => {
    await seedRecord({ fee: "10000000000000000000", broadcast: true, retries: 3 })
    const original = getPendingStore().current()!
    const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")
    const { recordDepositAdmission } = await import("../src/features/identity/admission")
    const rail = SIPADepositStore.get(webStorage)
    await rail.load()
    const deposit = await rail.upsert(
      original.sipaAddress as Hex,
      { phase: "broadcast" },
      {
        recipientL2Address: L2_ADDRESS,
        tokenAddress: original.depositToken,
        tokenSymbol: "DAI",
        l1ChainId: original.l1ChainId,
        messageSecret: NAME_HASH,
        recoveryAddress: ACCOUNT,
        recipientHash: NAME_HASH,
        amount: "5",
        startTime: 1,
      },
    )
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: original.fee,
      minDeposit: "5000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    recordDepositAdmission(original, 5n * 10n ** 18n)
    h.l1.account = ACCOUNT
    h.prepareRefund.mockResolvedValue(deposit)
    h.recoverDeposit.mockImplementation(async () => {
      await rail.upsert(original.sipaAddress as Hex, {
        phase: "recovered",
        recoveryTxHash: NAME_HASH,
      })
      return NAME_HASH
    })
    const newAddress = "0x00000000000000000000000000000000000000c9"
    h.claimTag.mockImplementation(async () => {
      expect(rail.get(original.sipaAddress as Hex)?.phase).toBe("recovered")
      await getPendingStore().upsert(ACCOUNT, {
        sipaAddress: newAddress,
        fee: TERMS.fee,
        broadcast: false,
        replaced: { sipaAddress: original.sipaAddress, refunded: true, broadcastSpent: true },
      })
      return {
        kind: "pending",
        oxideAccount: ACCOUNT,
        claim: { ...CLAIM, terms: { ...TERMS, minDeposit: "4500000000000000000" } },
      }
    })
    await render("/claim/taga?recovery=1")
    await click("Recover deposit")
    expect(container.textContent).toContain("Recovery requires ETH for gas")
    expect(h.claimTag).not.toHaveBeenCalled()
    await click(`Recover to ${ACCOUNT.slice(0, 6)}…${ACCOUNT.slice(-4)}`)
    expect(container.textContent).toContain("Deposit recovered")
    expect(getPendingStore().current()?.sipaAddress).toBe(original.sipaAddress)
    await click("Done")
    await click("Register at earned price")
    expect(h.claimTag).toHaveBeenCalledWith(
      "taga",
      fakeKeys,
      h.config,
      h.aztec.obsidionWallet,
      undefined,
      true,
      expect.objectContaining({ sipaAddress: original.sipaAddress }),
    )
    expect(getPendingStore().current()?.sipaAddress).toBe(newAddress)
    expect(loadRegistrationTerms(ACCOUNT)).toMatchObject({
      fee: TERMS.fee,
      minDeposit: "4500000000000000000",
    })
    expect(termsValue("total")).toBe(ask("earned_tag"))
    expect(button("Sweep manually")).toBeDefined()
    expect(button("Back to wallet")).toBeDefined()
    expect(button("Retry")).toBeUndefined()
    h.navigate.mockClear()
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, { phase: "funded", fundedAt: Date.now() })
    })
    expect(h.navigate).not.toHaveBeenCalled()
    expect(button("Sweep manually")).toBeDefined()
    expect(container.textContent).toContain("The new address has received your deposit")
    await act(async () => {
      recordDepositAdmission(getPendingStore().current()!, 5n * 10n ** 18n)
    })
    await click("Check again")
    expect(h.navigate).not.toHaveBeenCalled()
    expect(button("Sweep manually")).toBeDefined()
  })

  it("offers the earned-price restart after a sign-out cleared the admission receipt", async () => {
    await seedRecord({ fee: "10000000000000000000", broadcast: true, retries: 3 })
    const original = getPendingStore().current()!
    const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")
    const { recordDepositAdmission, hasDepositAdmission } = await import(
      "../src/features/identity/admission"
    )
    const { signOutNow } = await import("../src/features/identity/signOut")
    const rail = SIPADepositStore.get(webStorage)
    await rail.load()
    await rail.upsert(
      original.sipaAddress as Hex,
      { phase: "recovered", recoveryTxHash: NAME_HASH },
      {
        recipientL2Address: L2_ADDRESS,
        tokenAddress: original.depositToken,
        tokenSymbol: "DAI",
        l1ChainId: original.l1ChainId,
        messageSecret: NAME_HASH,
        recoveryAddress: ACCOUNT,
        recipientHash: NAME_HASH,
        amount: "5",
        startTime: 1,
      },
    )
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: original.fee,
      minDeposit: "5000000000000000000",
      feeWaived: false,
      depositAmount: "5000000000000000000",
      earnedExpected: true,
    })
    recordDepositAdmission(original, 5n * 10n ** 18n)
    // The refund emptied the address, so nothing the L1 watcher reads can rewrite the receipt.
    signOutNow()
    expect(hasDepositAdmission(original)).toBe(false)
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 2 })
    const newAddress = "0x00000000000000000000000000000000000000c9"
    h.claimTag.mockImplementation(async () => {
      await getPendingStore().upsert(ACCOUNT, {
        sipaAddress: newAddress,
        fee: TERMS.fee,
        broadcast: false,
        replaced: { sipaAddress: original.sipaAddress, refunded: true, broadcastSpent: true },
      })
      return {
        kind: "pending",
        oxideAccount: ACCOUNT,
        claim: { ...CLAIM, terms: { ...TERMS, minDeposit: "4500000000000000000" } },
      }
    })
    await render("/claim/taga?recovery=1")
    await settleReads()
    expect(container.textContent).toContain("Recover deposit for @taga")
    expect(container.textContent).toContain("The original deposit was recovered")
    expect(container.textContent).toContain(original.sipaAddress)
    expect(termsValue("total")).toBeUndefined()
    expect(button("Recover deposit")).toBeUndefined()
    expect(button("Back to wallet")).toBeUndefined()
    await click("Register at earned price")
    expect(h.claimTag).toHaveBeenCalledWith(
      "taga",
      fakeKeys,
      h.config,
      h.aztec.obsidionWallet,
      undefined,
      true,
      expect.objectContaining({ sipaAddress: original.sipaAddress }),
    )
    expect(getPendingStore().current()?.sipaAddress).toBe(newAddress)
    expect(termsValue("total")).toBe(ask("earned_tag"))
    expect(container.textContent).toContain("The original deposit was refunded")
    expect(button("Sweep manually")).toBeDefined()
    expect(button("Back to wallet")).toBeDefined()
  })

  it("offers recovery, not the restart, when funds reach a refunded address on the claim route", async () => {
    await seedRecord({ fee: "10000000000000000000", broadcast: true, retries: 3 })
    const original = getPendingStore().current()!
    const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")
    const rail = SIPADepositStore.get(webStorage)
    await rail.load()
    await rail.upsert(
      original.sipaAddress as Hex,
      { phase: "recovered", recoveryTxHash: NAME_HASH },
      {
        recipientL2Address: L2_ADDRESS,
        tokenAddress: original.depositToken,
        tokenSymbol: "DAI",
        l1ChainId: original.l1ChainId,
        messageSecret: NAME_HASH,
        recoveryAddress: ACCOUNT,
        recipientHash: NAME_HASH,
        amount: "5",
        startTime: 1,
      },
    )
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: original.fee,
      minDeposit: "5000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    // Nothing on this route syncs the rail's record; the live balance is what says funds are back.
    h.balance = 2n * 10n ** 17n
    try {
      await render("/claim/taga?recovery=1")
      await settleReads()
      expect(button("Recover deposit")).toBeDefined()
      expect(button("Register at earned price")).toBeUndefined()
      expect(container.textContent).toContain("Recover it to your Ethereum wallet first")
      expect(h.claimTag).not.toHaveBeenCalled()
    } finally {
      h.balance = 0n
    }
  })

  it("keeps a paid registration on its own terms after a recovery: no earned restart", async () => {
    await seedRecord({ fee: "10000000000000000000", broadcast: true, retries: 3 })
    const original = getPendingStore().current()!
    const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")
    const rail = SIPADepositStore.get(webStorage)
    await rail.load()
    await rail.upsert(
      original.sipaAddress as Hex,
      { phase: "recovered", recoveryTxHash: NAME_HASH },
      {
        recipientL2Address: L2_ADDRESS,
        tokenAddress: original.depositToken,
        tokenSymbol: "DAI",
        l1ChainId: original.l1ChainId,
        messageSecret: NAME_HASH,
        recoveryAddress: ACCOUNT,
        recipientHash: NAME_HASH,
        amount: "15",
        startTime: 1,
      },
    )
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: original.fee,
      minDeposit: "5000000000000000000",
      feeWaived: false,
    })
    await render("/claim/taga?recovery=1")
    await settleReads()
    expect(button("Register at earned price")).toBeUndefined()
    expect(termsValue("total")).toBe(ask("standard"))
    expect(container.textContent).not.toContain("earned price")
    expect(h.claimTag).not.toHaveBeenCalled()
  })

  it("offers recovery again for a funded legacy-fee address that holds funds after its refund", async () => {
    await seedRecord({ fee: "0", phase: "funded", fundedAt: 1, broadcast: true, retries: 3 })
    const original = getPendingStore().current()!
    const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")
    const { recordDepositAdmission } = await import("../src/features/identity/admission")
    const rail = SIPADepositStore.get(webStorage)
    await rail.load()
    await rail.upsert(
      original.sipaAddress as Hex,
      { phase: "recovered", recoveryTxHash: NAME_HASH },
      {
        recipientL2Address: L2_ADDRESS,
        tokenAddress: original.depositToken,
        tokenSymbol: "DAI",
        l1ChainId: original.l1ChainId,
        messageSecret: NAME_HASH,
        recoveryAddress: ACCOUNT,
        recipientHash: NAME_HASH,
        amount: "5",
        startTime: 1,
      },
    )
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: "0",
      minDeposit: "5000000000000000000",
      feeWaived: true,
      earnedExpected: true,
    })
    recordDepositAdmission(original, 5n * 10n ** 18n)
    h.skim = 5n * 10n ** 17n
    h.balance = 2n * 10n ** 17n
    try {
      await render("/claim/taga?recovery=1")
      await settleReads()
      expect(button("Recover deposit")).toBeDefined()
      expect(button("Register at earned price")).toBeUndefined()
      expect(h.claimTag).not.toHaveBeenCalled()
    } finally {
      h.skim = 0n
      h.balance = 0n
    }
  })

  it("replaces an old-price address nothing was sent to with one at the earned price, with a manual completion action", async () => {
    await seedRecord({ fee: "10000000000000000000", broadcast: true, retries: 3 })
    const original = getPendingStore().current()!
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: original.fee,
      minDeposit: "5000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    const newAddress = "0x00000000000000000000000000000000000000c9"
    h.claimTag.mockImplementation(async () => {
      // The old address was broadcast, so the rail's one use is gone.
      await getPendingStore().upsert(ACCOUNT, {
        sipaAddress: newAddress,
        fee: TERMS.fee,
        broadcast: false,
        replaced: { sipaAddress: original.sipaAddress, refunded: false, broadcastSpent: true },
      })
      return {
        kind: "pending",
        oxideAccount: ACCOUNT,
        claim: { ...CLAIM, terms: { ...TERMS, minDeposit: "4500000000000000000" } },
      }
    })
    await render("/claim/taga?fee=waived")
    await settleReads()
    expect(container.textContent).toContain("Nothing was sent to the original address")
    expect(container.textContent).toContain(original.sipaAddress)
    expect(termsValue("total")).toBeUndefined()
    expect(button("Recover deposit")).toBeUndefined()
    await click("Register at earned price")
    expect(h.claimTag).toHaveBeenCalledWith(
      "taga",
      fakeKeys,
      h.config,
      h.aztec.obsidionWallet,
      undefined,
      true,
      undefined,
      expect.objectContaining({ sipaAddress: original.sipaAddress, broadcast: true }),
    )
    expect(h.runDetectionTick).not.toHaveBeenCalled()
    expect(getPendingStore().current()?.sipaAddress).toBe(newAddress)
    expect(loadRegistrationTerms(ACCOUNT)).toMatchObject({ fee: TERMS.fee })
    expect(termsValue("total")).toBe(ask("earned_tag"))
    expect(container.textContent).toContain(
      `Fund this new address with the earned ${ask(
        "earned_tag",
      )} total, then choose Sweep manually`,
    )
    expect(container.textContent).not.toContain("The original deposit was refunded")
    expect(button("Sweep manually")).toBeDefined()
    expect(button("Retry")).toBeUndefined()
    // No deposit was refunded, so nothing bought wallet entry.
    expect(button("Back to wallet")).toBeUndefined()
    expect(button("Enter now, deposit later")).toBeDefined()
  })

  it("a replacement whose session died past its checkpoint still completes manually after a reload", async () => {
    const original = "0x00000000000000000000000000000000000000c3"
    // What the checkpoint left behind: the record and its quote, no session result.
    await seedRecord({
      fee: REDUCED_FEE,
      broadcast: false,
      replaced: { sipaAddress: original, refunded: false, broadcastSpent: true },
    })
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: REDUCED_FEE,
      minDeposit: "4500000000000000000",
      feeWaived: true,
      earnedExpected: true,
    })
    await render("/claim/taga")
    await settleReads()
    expect(termsValue("total")).toBe(ask("earned_tag"))
    expect(container.textContent).not.toContain("request a new one")
    expect(container.textContent).toContain(
      `Fund this new address with the earned ${ask(
        "earned_tag",
      )} total, then choose Sweep manually`,
    )
    expect(button("Sweep manually")).toBeDefined()
    expect(button("Retry")).toBeUndefined()
    expect(button("Register at earned price")).toBeUndefined()
    expect(button("Back to wallet")).toBeUndefined()
  })

  it("offers recovery for a deposit short of admission at an old-price address", async () => {
    await seedRecord({ fee: "10000000000000000000", broadcast: true, retries: 3 })
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: "10000000000000000000",
      minDeposit: "5000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    h.balance = 10n ** 18n
    await render("/claim/taga?fee=waived")
    await settleReads()
    expect(container.textContent).toContain("Recover deposit for @taga")
    expect(container.textContent).toContain("Deposit detected: $1.00")
    expect(container.textContent).not.toContain("Your wallet is open")
    expect(termsValue("total")).toBeUndefined()
    expect(button("Recover deposit")).toBeDefined()
    expect(button("Register at earned price")).toBeUndefined()
    expect(h.claimTag).not.toHaveBeenCalled()
  })

  it.each(["expected-price", "deposit-access"])(
    "reopening without campaign parameters preserves %s and does not ask for another deposit",
    async (savedState) => {
      await seedRecord()
      const original = getPendingStore().current()!
      h.config.admissionGate = true
      h.balance = savedState === "expected-price" ? 5n * 10n ** 18n : 0n
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: 0,
        fee: "5000000000000000000",
        minDeposit: "10000000000000000000",
        feeWaived: false,
        ...(savedState === "expected-price" ? { earnedExpected: true } : {}),
      })
      if (savedState === "deposit-access") {
        const { recordDepositAdmission } = await import("../src/features/identity/admission")
        recordDepositAdmission(original, 5n * 10n ** 18n)
      }
      await render("/claim")
      await settleReads()
      expect(termsValue("total")).not.toBe(ask("standard"))
      expect(container.textContent).not.toContain("Send at least")
      expect(container.textContent).not.toContain("01 January")
      expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
      expect(loadWalletIdentity()).toMatchObject({ address: L2_ADDRESS, pending: true })
      expect(getPendingStore().current()?.sipaAddress).toBe(original.sipaAddress)
      expect(loadRegistrationTerms(ACCOUNT)?.feeWaived).toBe(false)
    },
  )

  it("routes a paid pending registration to passkey recovery when wallet entry has no root breadcrumb", async () => {
    await seedRecord()
    h.hasRootBreadcrumb = false
    h.config.admissionGate = true
    h.balance = 5n * 10n ** 18n
    await render("/claim/taga?fee=waived")
    await settleReads()
    expect(h.navigate).toHaveBeenCalledWith("/enter?handle=taga", { replace: true })
    expect(h.navigate).not.toHaveBeenCalledWith("/", { replace: true })
    expect(loadWalletIdentity()).toMatchObject({ address: L2_ADDRESS, pending: true })
    expect(container.textContent).not.toContain("Send at least")
  })

  it("a free name that chose Deposit still gets the address, fee shown as waived", async () => {
    claimWithWaiver()
    await render("/claim/taga?fee=waived")
    await click("landing-signin")
    await clickDeposit()

    expect(container.textContent).toContain("@taga is reserved for you")
    expect(container.textContent).toContain("Tag priceWaived")
    // The schedule fee is what the free tag still costs: it funds the network with the portal's cut.
    expect(termsValue("network-funding")).toBe(usd(75n * 10n ** 16n))
    expect(termsValue("total")).toBe(ask("earned_tag"))
    expect(summary()).toContain(
      `Send at least ${ask("earned_tag")} to activate your account. The tag is free, and ${usd(
        75n * 10n ** 16n,
      )} is network funding.`,
    )
    expect(button("Enter now, deposit later")).toBeTruthy()
    expect(container.textContent).not.toContain("all-set")
  })

  it("a free name that chose to enter first skips the gate: the wallet opens pending, terms kept for the reminder", async () => {
    claimWithWaiver()
    await render("/claim/taga?fee=waived")
    await click("landing-signin")
    await click("I'll do this later")

    expect(container.textContent).toContain("all-set")
    expect(container.textContent).not.toContain("Deposit to register")
    expect(loadWalletIdentity()).toMatchObject({
      handle: "taga",
      address: L2_ADDRESS,
      pending: true,
    })
    expect(loadRegistrationTerms(ACCOUNT)).toMatchObject({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: REDUCED_FEE,
      minDeposit: "4500000000000000000",
      feeWaived: true,
    })
  })

  it("without a waiver the gate quotes the registry's minimum, fee and total on the deposit chain", async () => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    try {
      await walkToPendingWithKeys()
      await settleReads()
      const text = container.textContent!
      expect(text).toContain("@taga is reserved for you")
      expect(text).toContain("Send at least $15.00 to claim your tag and activate your account.")
      expect(text).toContain("NetworkSepolia")
      expect(termsValue("opening-balance")).toBe(usd(475n * 10n ** 16n))
      // The tag price is what the fee carries above the relayer's sweep; the sweep and the portal's
      // cut are network funding, the same figure a free schedule quotes.
      expect(termsValue("tag-price")).toBe(usd(95n * 10n ** 17n))
      expect(termsValue("network-funding")).toBe(usd(75n * 10n ** 16n))
      expect(termsValue("total")).toBe(ask("standard"))
      expect(text).toContain("Reserved until")
      expect(checkControl()).toBeTruthy()
      expect(button("Register @taga")).toBeUndefined()
      expect(button("Enter now, deposit later")).toBeUndefined()
      expect(loadRegistrationTerms(ACCOUNT)?.feeWaived).toBe(false)
    } finally {
      h.amounts = { min: 0n, fee: 0n }
    }
  })

  it("a waived quote still totals the relay fee it signed", async () => {
    await seedRecord()
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: "500000000000000000",
      minDeposit: "4500000000000000000",
      feeWaived: true,
    })
    await render()
    const text = container.textContent!
    expect(text).toContain("Tag priceWaived")
    expect(termsValue("network-fee")).toBeUndefined()
    expect(termsValue("network-funding")).toBe(usd(75n * 10n ** 16n))
    expect(termsValue("opening-balance")).toBe(usd(425n * 10n ** 16n))
    expect(termsValue("total")).toBe(ask("earned_tag"))
    expect(summary()).toContain(
      `Send at least ${ask("earned_tag")} to activate your account. The tag is free, and ${usd(
        75n * 10n ** 16n,
      )} is network funding.`,
    )
    // The ask, never the signed floor.
    expect(termsValue("total")).not.toBe(due(45n * 10n ** 17n))
  })

  it("a waived reload shows the fee as waived and can enter now, deposit later", async () => {
    await seedRecord()
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: REDUCED_FEE,
      minDeposit: "4500000000000000000",
      feeWaived: true,
    })
    await render()
    expect(container.textContent).toContain("Tag priceWaived")
    expect(container.textContent).toContain("Network funding$0.75")
    expect(container.textContent).toContain("The tag is free, and $0.75 is network funding.")
    expect(button("Enter now, deposit later")).toBeTruthy()

    await click("Enter now, deposit later")
    expect(loadWalletIdentity()).toMatchObject({
      handle: "taga",
      address: L2_ADDRESS,
      pending: true,
    })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })
})

describe("pending step — deposit feedback", () => {
  it("a landed deposit shows as received with its amount and nudges one forced tick", async () => {
    vi.useFakeTimers()
    h.amounts = { min: 95n * 10n ** 17n, fee: 5n * 10n ** 18n }
    await seedRecord()
    unsignedTerms()
    await render()
    expect(container.textContent).toContain("@taga is reserved for you")

    h.balance = 15n * 10n ** 18n
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500)
    })
    expect(container.textContent).toContain("Deposit received for @taga")
    expect(container.textContent).toContain("Deposit received: $15.00")
    expect(h.runDetectionTick).toHaveBeenCalledTimes(1)
    expect(h.runDetectionTick.mock.calls[0][1]).toMatchObject({ force: true })
    h.balance = 0n
    h.amounts = { min: 0n, fee: 0n }
  })

  it("asks the full deposit before the schedule read lands, and acknowledges one that arrives", async () => {
    vi.useFakeTimers()
    h.scheduleFails = true
    await seedRecord()
    unsignedTerms()
    await render()
    // The asked total is a constant, so it is there from the first paint; the split it covers is not.
    expect(termsValue("total")).toBe(ask("standard"))
    expect(termsValue("tag-price")).toBe(DEPOSIT_TERMS_PENDING)

    h.balance = 6n * 10n ** 18n
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500)
    })
    // Under the ask with no floor to weigh it against: no verdict, so the panel keeps asking.
    expect(container.textContent).not.toContain("Deposit received")

    h.balance = 15n * 10n ** 18n
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500)
    })
    // The whole ask covers any floor it was priced to, so the panel reports it.
    expect(container.textContent).toContain(`Deposit received: ${seen(15n * 10n ** 18n)}`)
    h.balance = 0n
  })

  it("a deposit short of the quote prices the top-up and keeps the address, no celebration", async () => {
    vi.useFakeTimers()
    h.amounts = { min: 10n * 10n ** 18n, fee: 1n * 10n ** 18n }
    await seedRecord()
    unsignedTerms()
    await render()

    h.balance = 5n * 10n ** 18n
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500)
    })
    // The ask is the quoted deposit; the top-up is priced to it, not to the chain's own floor.
    expect(summary()).toContain(
      `${seen(5n * 10n ** 18n)} of ${ask("standard")} received. Send at least`,
    )
    expect(summary()).toContain(due(askedTotal("standard") - 5n * 10n ** 18n))
    expect(container.textContent).not.toContain("Deposit received")
    expect(container.textContent).not.toContain("Confirming your name")
    await act(async () => {
      buttons()
        .find((b) => b.textContent?.startsWith("Connect your wallet"))!
        .click()
    })
    expect(h.l1.connect).toHaveBeenCalledTimes(1)

    h.balance = 11n * 10n ** 18n
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500)
    })
    expect(container.textContent).toContain("Deposit received: $11.00")
    h.balance = 0n
    h.amounts = { min: 0n, fee: 0n }
  })
})

describe("pending step — a reload with no signed quote left", () => {
  it("a campaign hand-off saves its expectation without inventing a signed waiver", async () => {
    // The record outlives the quote: freshClaim is memory-only and the stored copy can be absent.
    // Reading that as "you pay" reprices a free tag at the full total.
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    await seedRecord()
    await render("/claim/taga?src=campaign&fee=waived")
    await settleReads()
    // The hint records the expectation only: a waiver is the signature's to name, and writing
    // `feeWaived: false` here would state a schedule nothing has signed.
    expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({ earnedExpected: true })
    expect(loadRegistrationTerms(ACCOUNT, "taga")?.feeWaived).toBeUndefined()
    // No quote to disagree with, and the stamped deadline 0 is unknown, not lapsed: the address
    // and the reservation stand, and the hint alone quotes the earned ask.
    expect(termsValue("tag-price")).toBe("Waived")
    expect(termsValue("total")).toBe(ask("earned_tag"))
    expect(termsValue("total")).not.toBe(ask("standard"))
    expect(container.textContent).not.toContain("Original deposit address")
    expect(container.textContent).not.toContain(`Refresh the deposit for @taga`)
    expect(button("Enter now, deposit later")).toBeTruthy()
    expect(checkControl()).not.toBeNull()
    expect(getPendingStore().current()?.sipaAddress).toBe(
      "0x00000000000000000000000000000000000000c3",
    )
  })

  it("without the hint it stays priced, rather than inventing a waiver", async () => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    await seedRecord()
    unsignedTerms()
    await render("/claim/taga")
    await settleReads()
    expect(termsValue("total")).toBe(ask("standard"))
    // The claim carried no schedule, so the controller's immutables are what price it.
    expect(h.scheduleReads).toBeGreaterThan(0)
    expect(termsValue("tag-price")).toBe(usd(95n * 10n ** 17n))
  })

  it("drops the split once the controller answers a fee this address is not committed to", async () => {
    // The schedule landed and prices another fee, so it cannot price this record and no further
    // read will: the rows it prices go, rather than holding a placeholder for good.
    h.amounts = { min: 5n * 10n ** 18n, fee: 7n * 10n ** 18n }
    await seedRecord({ fee: String(5n * 10n ** 18n) })
    unsignedTerms()
    await render("/claim/taga")
    await settleReads()
    expect(h.scheduleReads).toBeGreaterThan(0)
    expect(termsValue("total")).toBe(ask("standard"))
    for (const row of ["tag-price", "network-funding", "opening-balance"]) {
      expect(termsValue(row)).toBeUndefined()
    }
  })

  it("a registration whose sign never landed asks the total alone and reads no schedule", async () => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    await seedRecord()
    await render("/claim/taga")
    await settleReads()
    expect(termsValue("total")).toBe(ask("standard"))
    expect(h.scheduleReads).toBe(0)
    for (const row of ["tag-price", "network-funding", "opening-balance"]) {
      expect(termsValue(row)).toBeUndefined()
    }
  })

  /** Virtual time, since the surfaces here retry their reads on a slow cadence. */
  const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  it("a deployment that takes no registration says so, asks nothing, and re-reads no more", async () => {
    vi.useFakeTimers()
    // The registry answers zero for both immutables — an answer, not a read still outstanding.
    await seedRecord()
    unsignedTerms()
    await render("/claim/taga")
    await tick(10)
    const reads = h.scheduleReads
    expect(reads).toBeGreaterThan(0)
    expect(paused()).toContain(REGISTRATIONS_PAUSED_NOTICE)
    // No figure and no address: a deposit sent now could not be swept.
    expect(termsValue("total")).toBeUndefined()
    expect(container.textContent).not.toContain("0x000000...0000c3")

    await tick(CHAIN_READ_RETRY_MS + 1_000)
    expect(h.scheduleReads).toBe(reads)
  })

  it("says the same where the schedule's fee sits under the relayer's sweep fee", async () => {
    // Nothing at the address could fund the sweep, so the deposit is never asked for.
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n ** 17n }
    await seedRecord()
    unsignedTerms()
    await render("/claim/taga")
    await settleReads()
    expect(paused()).toContain(REGISTRATIONS_PAUSED_NOTICE)
    expect(termsValue("total")).toBeUndefined()
  })

  it("holds the name and asks for nothing while registrations are paused", async () => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n ** 17n }
    await seedRecord()
    unsignedTerms()
    await render("/claim/taga")
    await settleReads()
    expect(container.textContent).not.toContain("Send the deposit to the address below")
    // The notice stands once, with the check control beside it rather than inside its sentence.
    expect(container.textContent!.split(REGISTRATIONS_PAUSED_NOTICE)).toHaveLength(2)
    expect(checkControl()).not.toBeNull()
  })

  it("a schedule read that failed keeps checking, and prices the rows once one lands", async () => {
    vi.useFakeTimers()
    h.scheduleFails = true
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    await seedRecord()
    unsignedTerms()
    await render("/claim/taga")
    await tick(2_000)
    // Unread is not an answer: the row holds and the cadence keeps asking.
    expect(termsValue("tag-price")).toBe(DEPOSIT_TERMS_PENDING)
    const reads = h.scheduleReads

    h.scheduleFails = false
    await tick(CHAIN_READ_RETRY_MS + 1_000)
    expect(h.scheduleReads).toBeGreaterThan(reads)
    expect(termsValue("tag-price")).toBe(usd(95n * 10n ** 17n))
  })
})

describe("pending step — a quote past its deadline", () => {
  const auth = {
    clear: vi.fn(),
    lockOut: vi.fn(),
    rootCredentialId: vi.fn(async () => undefined as string | undefined),
  }
  const expiredTerms = () =>
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor(Date.now() / 1000) - 60,
      feeWaived: false,
    })
  beforeEach(() => {
    auth.clear.mockClear()
    h.getAuthService.mockReturnValue(auth)
  })

  it("offers the refresh, hides the address, and never says the name was lost", async () => {
    await seedRecord()
    expiredTerms()
    await render()
    expect(container.textContent).toContain(`Refresh the deposit for @taga`)
    // The deadline is the claim signature's; the 7-day hold is not what ran out.
    expect(container.textContent).not.toContain("reservation")
    expect(container.textContent).not.toContain(
      `Send at least ${ask("standard")} to claim your tag`,
    )
    expect(button("Refresh deposit amount")).toBeTruthy()
    expect(button("Register @taga")).toBeUndefined()
  })

  it("a still-free name is re-claimed through the re-broadcast branch, with the new deadline kept", async () => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    await seedRecord()
    expiredTerms()
    await render()
    h.getClaimStatus.mockResolvedValue("reserved")
    h.tuple = { registry: "0x00000000000000000000000000000000000000e4" }
    const freshDeadline = String(Math.floor(Date.now() / 1000) + 7200)
    h.buildRetrySignDeps.mockReturnValue({
      accountService: { signDomain: vi.fn(async () => ({ ...CLAIM, deadline: freshDeadline })) },
    })
    h.runDetectionTick.mockImplementation(async (deps: { getSignDeps: () => Promise<any> }) => {
      const sign = await deps.getSignDeps()
      await sign.accountService.signDomain({ nameHash: NAME_HASH, userAddress: ACCOUNT })
      await getPendingStore().upsert(ACCOUNT, { broadcast: true })
      return "pending"
    })

    await click("Refresh deposit amount")
    expect(h.runDetectionTick).toHaveBeenCalledTimes(1)
    expect(h.runDetectionTick.mock.calls[0][1]).toMatchObject({ force: true })
    expect(loadRegistrationTerms(ACCOUNT)?.deadline).toBe(Number(freshDeadline))
    expect(getPendingStore().current()?.broadcast).toBe(true)
    expect(container.textContent).not.toContain(`Refresh the deposit for @taga`)
    expect(summary()).toContain(
      `Send at least ${ask("standard")} to claim your tag and activate your account.`,
    )
  })

  it("a spent-rail replacement renews its reservation through the forced tick and keeps its manual sweep", async () => {
    await seedRecord({
      fee: REDUCED_FEE,
      broadcast: false,
      replaced: {
        sipaAddress: "0x00000000000000000000000000000000000000c3",
        refunded: false,
        broadcastSpent: true,
      },
    })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor(Date.now() / 1000) - 60,
      fee: REDUCED_FEE,
      minDeposit: "4500000000000000000",
      feeWaived: true,
      earnedExpected: true,
    })
    await render("/claim/taga")
    await settleReads()
    expect(container.textContent).toContain(`Refresh the deposit for @taga`)
    expect(button("Refresh deposit amount")).toBeTruthy()
    h.getClaimStatus.mockResolvedValue("reserved")
    h.tuple = { registry: "0x00000000000000000000000000000000000000e4" }
    const freshDeadline = String(Math.floor(Date.now() / 1000) + 7200)
    h.buildRetrySignDeps.mockReturnValue({
      accountService: {
        signDomain: vi.fn(async () => ({
          ...CLAIM,
          deadline: freshDeadline,
          terms: {
            fee: REDUCED_FEE,
            minDeposit: "4500000000000000000",
            nonce: "1",
            deadline: freshDeadline,
            signature: "0x",
            reduced: true,
          },
        })),
      },
    })
    // The tick renews the claim and publishes nothing: the rail is spent.
    h.runDetectionTick.mockImplementation(async (deps: { getSignDeps: () => Promise<any> }) => {
      const sign = await deps.getSignDeps()
      await sign.accountService.signDomain({ nameHash: NAME_HASH, userAddress: ACCOUNT })
      return "pending"
    })

    await click("Refresh deposit amount")
    expect(h.runDetectionTick.mock.calls[0][1]).toMatchObject({ force: true })
    expect(loadRegistrationTerms(ACCOUNT)?.deadline).toBe(Number(freshDeadline))
    expect(getPendingStore().current()?.broadcast).toBe(false)
    expect(container.textContent).not.toContain(`Refresh the deposit for @taga`)
    expect(termsValue("total")).toBe(ask("earned_tag"))
    expect(button("Sweep manually")).toBeDefined()
  })

  it("a lapsed paid quote under an earned expectation is replaced at the earned price, not renewed", async () => {
    await seedRecord()
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor(Date.now() / 1000) - 60,
      fee: "5000000000000000000",
      minDeposit: "10000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    await render("/claim/taga?fee=waived")
    await settleReads()
    expect(container.textContent).toContain(`Refresh the deposit for @taga`)
    expect(container.textContent).toContain("Nothing was sent to the original address")
    expect(button("Refresh deposit amount")).toBeUndefined()
    expect(button("Register at earned price")).toBeTruthy()
  })

  it("a name the registry now shows as someone else's ends the attempt: record closed, fresh start", async () => {
    await seedRecord()
    expiredTerms()
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    await render()
    h.getClaimStatus.mockResolvedValue("claimed")

    await click("Refresh deposit amount")
    expect(getPendingStore().current()).toBeNull()
    expect(getPendingStore().list()[0]?.phase).toBe("failed_taken")
    expect(auth.lockOut).toHaveBeenCalledTimes(1)
    expect(loadWalletIdentity()).toBeNull()
    expect(container.textContent).toContain("taken:taga")
    expect(h.runDetectionTick).not.toHaveBeenCalled()
  })
})

describe("pending step — log out", () => {
  it("leaves the deposit screen for the landing without touching the record, even with custody", async () => {
    await seedRecord({ fundedAt: Date.now() })
    waivedTerms()
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    await render("/claim/taga")

    await click("Log out")
    expect(container.textContent).toContain("landing-signin")
    expect(loadWalletIdentity()).toBeNull()
    expect(getPendingStore().current()?.fundedAt).toBeDefined()
    // The terms describe the record, and go with it, not with the session.
    expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({ feeWaived: true })
    expect(h.navigate).toHaveBeenCalledWith("/claim", { replace: true })
  })

  // The record keeps running after the session leaves, and the tick prices its floor from these
  // terms: without them an earned deposit is measured against the chain's standard schedule.
  it("keeps the terms the open record is priced by", async () => {
    await seedRecord()
    waivedTerms()
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    await render("/claim/taga")

    await click("Log out")
    expect(loadRegistrationTerms(ACCOUNT, "taga")?.feeWaived).toBe(true)
  })

  it("drops terms once the record they priced is closed", async () => {
    await seedRecord()
    waivedTerms()
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    await render("/claim/taga")
    await getPendingStore().close(ACCOUNT, "failed_terminal")

    await click("Log out")
    expect(loadRegistrationTerms(ACCOUNT, "taga")).toBeNull()
  })
})

describe("the intro's wait applies what the hand-off decides after the last tap", () => {
  const HANDOFF = "/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12"
  const deferredClaim = () => {
    let settle!: { resolve: () => void; reject: (error: Error) => void }
    h.claimTag.mockImplementation(
      (tag: string) =>
        new Promise<unknown>((resolve, reject) => {
          settle = {
            resolve: () => {
              void getPendingStore()
                .upsert(ACCOUNT, {}, baseRecord({ tag }))
                .then(() => resolve({ kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }))
            },
            reject,
          }
        }),
    )
    return () => settle
  }

  it("a claim that succeeds after the wait gave up still enters, with no second claim", async () => {
    const claim = deferredClaim()
    await render(HANDOFF)
    await enterHandoff()
    vi.useFakeTimers()
    try {
      await leaveIntro()
      expect(container.querySelector('[data-testid="handoff-entering"]')).not.toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_001)
      })
      // The wait gave up on the terms sheet, which can ask again.
      expect(container.textContent).toContain("Get instant access")
      expect(h.navigate).not.toHaveBeenCalled()

      await act(async () => {
        claim().resolve()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
      expect(h.claimTag).toHaveBeenCalledTimes(1)
      expect(h.navigate).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("a tap parked on a running hand-off is released when it succeeds: the last tap enters at once", async () => {
    // The bridge left material, so the silent attempt runs the claim with no prompt.
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    const claim = deferredClaim()
    await render(HANDOFF)
    // The first tap lands while that attempt runs, so it is kept for a prompt.
    await enterHandoff()
    await act(async () => {
      claim().resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
    await leaveIntro()
    // The attempt ended with an account: nothing is owed a prompt, and nothing holds the entry.
    expect(container.querySelector('[data-testid="handoff-entering"]')).toBeNull()
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a hand-off that commits another account than this page loaded reloads before the claim", async () => {
    // This browser's stores loaded under an earlier account; the material names a new one.
    setActiveStorageId("account-a")
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    h.adoptHandoff.mockImplementationOnce(async () => {
      setActiveStorageId("account-b")
      return fakeKeys
    })
    h.reloadIfSessionSwitched.mockReturnValueOnce(true)
    await render(HANDOFF)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(h.reloadIfSessionSwitched).toHaveBeenCalledWith("account-a", L2_ADDRESS)
    // Nothing is written for the new account in this document: the reloaded one claims.
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(loadWalletIdentity()).toBeNull()
  })

  it("a claim refused after the last tap shows its error, not the terms sheet", async () => {
    const claim = deferredClaim()
    await render(HANDOFF)
    await enterHandoff()
    await leaveIntro()
    expect(container.querySelector('[data-testid="handoff-entering"]')).not.toBeNull()

    await act(async () => {
      claim().reject(new Error("claim refused late"))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(container.textContent).toContain("claim-modal")
    expect(container.textContent).toContain("claim refused late")
    expect(container.textContent).not.toContain("Get instant access")
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it("a claim refused after the wait gave up shows its error over the terms sheet", async () => {
    const claim = deferredClaim()
    await render(HANDOFF)
    await enterHandoff()
    vi.useFakeTimers()
    try {
      await leaveIntro()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_001)
      })
      expect(container.textContent).toContain("Get instant access")

      await act(async () => {
        claim().reject(new Error("claim refused late"))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(container.textContent).toContain("claim refused late")
      expect(h.navigate).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("a claim refused before the last tap still owns the screen after it", async () => {
    const claim = deferredClaim()
    await render(HANDOFF)
    await enterHandoff()
    await act(async () => {
      claim().reject(new Error("claim refused early"))
      await new Promise((r) => setTimeout(r, 0))
    })
    // The slides are not pulled from under the reader; the last tap lands on the error.
    expect(container.textContent).not.toContain("claim refused early")
    await leaveIntro()
    expect(container.textContent).toContain("claim refused early")
  })
})

describe("the intro's spinner holds until there is something to enter on", () => {
  it("enters on a registration still publishing, which Home's activation hero owns", async () => {
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return {
        kind: "pending",
        claim: CLAIM,
        oxideAccount: ACCOUNT,
        // Never settles: entry that waited on the broadcast would sit here for the hold's length.
        broadcastDone: new Promise<boolean>(() => {}),
      }
    })
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await act(async () => new Promise((r) => setTimeout(r, 0)))

    await leaveIntro()
    // The deposit address is good before the claim publishes, so nothing is gained by holding it.
    expect(h.navigate).toHaveBeenCalled()
  })

  it("waits for a wallet that is still booting, rather than asking for the tag again", async () => {
    h.aztec = { obsidionWallet: undefined }
    try {
      await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
      await act(async () => new Promise((r) => setTimeout(r, 0)))
      // Nothing could start, so the tap is owed and the last slide must not give up on it.
      expect(h.resolveHandoff).not.toHaveBeenCalled()

      await enterHandoff()
      await leaveIntro()
      expect(container.querySelector('[data-testid="handoff-entering"]')).not.toBeNull()
      expect(container.textContent).not.toContain("Get instant access")
    } finally {
      h.aztec = { obsidionWallet: { wallet: true } }
    }
  })
})

describe("the wallet keeps no signup of its own", () => {
  const withStubbedAssign = async (run: (assign: ReturnType<typeof vi.fn>) => Promise<void>) => {
    h.config.campaignUrl = "https://launch.test.invalid"
    const assign = vi.fn()
    const real = window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...real, assign, href: real.href, origin: real.origin, pathname: "/claim" },
    })
    try {
      await run(assign)
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: real })
      h.config.campaignUrl = ""
    }
  }

  it("a bare visit leaves for the campaign's landing, which owns signup", async () => {
    await withStubbedAssign(async (assign) => {
      await render("/claim")
      await act(async () => new Promise((r) => setTimeout(r, 0)))
      expect(assign).toHaveBeenCalledWith("https://launch.test.invalid")
    })
  })

  it("a name in the path is not a hand-off, and goes back to the campaign", async () => {
    await withStubbedAssign(async (assign) => {
      await render("/claim/taga")
      await act(async () => new Promise((r) => setTimeout(r, 0)))
      expect(assign).toHaveBeenCalledWith("https://launch.test.invalid")
    })
  })

  it("a hand-off naming another wallet's RP is no hand-off either", async () => {
    await withStubbedAssign(async (assign) => {
      await render("/claim/taga?entry=passkey&rp=wallet.zk.money&cred=cred-1&pk=ab12")
      await act(async () => new Promise((r) => setTimeout(r, 0)))
      expect(assign).toHaveBeenCalledWith("https://launch.test.invalid")
    })
  })

  it("a hand-off has something to act on, and stays", async () => {
    await withStubbedAssign(async (assign) => {
      await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
      await act(async () => new Promise((r) => setTimeout(r, 0)))
      expect(assign).not.toHaveBeenCalled()
      expect(container.querySelector('[data-testid="carousel-next"]')).not.toBeNull()
    })
  })

  it("an account this browser entered, still nameless, stays and names itself", async () => {
    // RegisterNameCard's entry: the bare /claim, with the campaign configured.
    const { setActiveCredentialId, setActiveStorageId } = await import(
      "../src/platform/storage/activeStorage"
    )
    saveWalletIdentity({ address: L2_ADDRESS, claimedAt: 1 })
    setActiveStorageId("s")
    setActiveCredentialId("cred-bound")
    h.getAuthService.mockReturnValue({
      rootCredentialId: async () => "cred-newer",
      recoverFromCache: async () => undefined,
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await withStubbedAssign(async (assign) => {
      await render("/claim")
      await settleReads()
      expect(assign).not.toHaveBeenCalled()
      expect(container.textContent).toContain("landing-signin")

      await click("landing-signin")
      await clickDeposit()
      // The name lands on the account that entered: its passkey is asserted, none is minted.
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.collectOnboardingKeys).not.toHaveBeenCalled()
      expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
        h.aztec.obsidionWallet,
        L2_ADDRESS,
        { credentialId: "cred-bound" },
        expect.any(Function),
        expect.any(AbortSignal),
        expect.any(Function),
      )
    })
  })

  it("a named account on the bare step stays too", async () => {
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1 })
    await withStubbedAssign(async (assign) => {
      await render("/claim")
      await settleReads()
      expect(assign).not.toHaveBeenCalled()
    })
  })
})

describe("a second arrival on a name this browser already entered", () => {
  it("goes straight into the wallet, where the activation sheet asks for the deposit", async () => {
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    await seedRecord({ tag: "taga" })
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(h.navigate).toHaveBeenCalled()
  })

  it("leaves the pending sheet a way out, rather than a gate with no close", async () => {
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    await seedRecord({ tag: "taga" })
    // No hand-off here: the sheet is the surface, and a paid reservation waives nothing.
    await render("/claim/taga")
    await settleReads()
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    expect(close).not.toBeNull()

    await act(async () => close!.click())
    expect(h.navigate).toHaveBeenCalled()
  })
})

describe("campaign hand-off — the bridge's material needs no tap", () => {
  it("material in place completes the hand-off while the first slide is read", async () => {
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    // No tap yet: the material was taken with no prompt, and the name was claimed.
    expect(h.resolveHandoff).toHaveBeenCalledTimes(1)
    expect(h.resolveHandoff.mock.calls[0][6]).toBe(true)
    expect(h.claimTag).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="carousel-next"]')).not.toBeNull()

    await leaveIntro()
    expect(h.navigate).toHaveBeenCalled()
  })

  it("a tap before the wallet is ready is kept, and spent on the prompt once it is", async () => {
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    // The attempt made with no tap was refused: a prompt is needed.
    expect(h.resolveHandoff).toHaveBeenCalledTimes(1)
    expect(h.claimTag).not.toHaveBeenCalled()

    await enterHandoff()
    expect(h.resolveHandoff).toHaveBeenCalledTimes(2)
    expect(h.resolveHandoff.mock.calls[1][6]).toBeFalsy()
    expect(h.claimTag).toHaveBeenCalledTimes(1)
  })
})

describe("pending step — passkey telemetry", () => {
  const events = () => passkeyEvents(h.fireEvent)
  type Gate = (opts?: unknown) => Promise<{ signal: AbortSignal; reach: string }>
  let harness: Awaited<ReturnType<typeof passkeyTelemetryHarness>>
  let pendingStore: typeof getPendingStore
  let renderPage: () => Promise<void>
  const seedPending = (over: Partial<PendingRegistrationRecord> = {}) =>
    pendingStore().upsert(ACCOUNT, {}, baseRecord(over))

  /** The retry's sign-in: past the gate it asks through the tracker and waits for the test. */
  const heldRetry = () => {
    const held: { request?: HeldRequest } = {}
    h.reusePasskeyAccount.mockImplementation(
      async (
        _w: unknown,
        _a: unknown,
        _h: unknown,
        gate: Gate,
        _signal?: AbortSignal,
        own?: PasskeyRequestScope,
      ) => {
        const { signal } = await gate()
        held.request = harness.request("assert", signal, own)
        await held.request.settled
        return fakeKeys
      },
    )
    return held
  }
  /** A gate that passes at once with a signal its cancel aborts; `steps` keeps its steps up once asked. */
  const passingGate = (steps = false) => {
    const controller = new AbortController()
    let asked = false
    h.gateHook = () => ({
      gate: async () => {
        asked = true
        return { signal: controller.signal, reach: "unknown" as const }
      },
      state:
        steps && asked
          ? { kind: "awaiting-action", proceed: () => {}, reach: "unknown", prompt: "phone-steps" }
          : { kind: "idle" },
      cancel: () => controller.abort(),
      dismiss: () => {},
    })
  }
  const leaveAtOnce = (press: () => void) => {
    act(() => {
      press()
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
  }

  beforeEach(async () => {
    // An attempt an earlier test left open ends here, before this test counts anything.
    pageHide()
    h.fireEvent.mockClear()
    // A fresh page load: its own tracker, so attempt numbers and once-per-page events start over.
    vi.resetModules()
    const { OnboardingScreen: Screen } = await import("../src/features/onboarding/OnboardingScreen")
    ;({ getPendingStore: pendingStore } = await import(
      "../src/features/onboarding/webRegistration"
    ))
    await pendingStore().load()
    harness = await passkeyTelemetryHarness()
    renderPage = () => render("/claim", Screen)
  })

  it("Cancel at the retry's steps during its request sends one cancel, and nothing once the screen and page go", async () => {
    passingGate(true)
    const held = heldRetry()
    await seedPending({ broadcast: false })
    await renderPage()
    await click("Retry")
    expect(held.request).toBeDefined()
    leaveAtOnce(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="phone-steps-cancel"]')!.click(),
    )
    await settleReads()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "onboarding",
        outcome: "cancelled",
        reason: "in_app_cancel",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("closing a waived sheet during the retry's request is the user's cancel, sent once", async () => {
    passingGate()
    const held = heldRetry()
    await seedPending({ broadcast: false })
    waivedTerms()
    await renderPage()
    await click("Retry")
    expect(held.request).toBeDefined()
    leaveAtOnce(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(),
    )
    await settleReads()
    expect(events()).toEqual([
      expect.objectContaining({
        outcome: "cancelled",
        reason: "in_app_cancel",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("the record moving on while the retry's request is pending sends nothing for it", async () => {
    const held = heldRetry()
    await seedPending({ broadcast: false })
    await renderPage()
    await click("Retry")
    expect(held.request).toBeDefined()
    await act(async () => {
      await pendingStore().upsert(ACCOUNT, { phase: "funded", fundedAt: Date.now() })
    })
    await act(async () => held.request!.reject(new DOMException("closed", "NotAllowedError")))
    act(() => pageHide())
    expect(events()).toEqual([])
  })

  it("a failed registration sent back to the landing while the retry's request is pending sends nothing", async () => {
    const held = heldRetry()
    await seedPending({ broadcast: false })
    await renderPage()
    await click("Retry")
    expect(held.request).toBeDefined()
    await act(async () => {
      await pendingStore().close(ACCOUNT, "failed_terminal")
    })
    expect(container.textContent).toContain("The claim could not be completed")
    await act(async () => held.request!.reject(new DOMException("closed", "NotAllowedError")))
    act(() => pageHide())
    expect(events()).toEqual([])
  })

  it("the record failing while the retry waits at the phone steps sends nothing", async () => {
    let asked = false
    let rejectGate: (error: Error) => void = () => {}
    h.gateHook = () => ({
      gate: () => {
        asked = true
        return new Promise<{ signal: AbortSignal; reach: "unknown" }>(
          (_, reject) => (rejectGate = reject),
        )
      },
      state: asked
        ? { kind: "awaiting-action", proceed: () => {}, reach: "unknown", prompt: "phone-steps" }
        : { kind: "idle" },
      cancel: () => {},
      dismiss: () => rejectGate(new GateCancelledError()),
    })
    h.reusePasskeyAccount.mockImplementation(
      async (_w: unknown, _a: unknown, _h: unknown, gate: Gate) => {
        await gate()
        return fakeKeys
      },
    )
    await seedPending({ broadcast: false })
    await renderPage()
    await click("Retry")
    expect(container.querySelector('[data-testid="phone-steps"]')).not.toBeNull()
    await act(async () => {
      await pendingStore().close(ACCOUNT, "failed_terminal")
    })
    await settleReads()
    act(() => pageHide())
    expect(events()).toEqual([])
  })

  it("a second Retry while the first is asking starts nothing, and one attempt is sent", async () => {
    const held = heldRetry()
    await seedPending({ broadcast: false })
    await renderPage()
    await click("Retry")
    const busyRetry = button("Confirm your passkey…")
    expect(busyRetry?.disabled).toBe(true)
    await act(async () => busyRetry!.click())
    expect(h.reusePasskeyAccount).toHaveBeenCalledTimes(1)
    await act(async () => held.request!.answer())
    await settleReads()
    expect(events()).toEqual([
      expect.objectContaining({ outcome: "succeeded", prompts: "1", attempt: "1" }),
    ])
  })

  it("a ticket signup resuming on its bound passkey reports a sign-in, not a creation", async () => {
    screenProps = { ticketSignup: true }
    stashTicketSignup({
      fragment: "paylink-frag",
      threshold: String(2n * 10n ** 18n),
      schedule: { fee: String(10n ** 18n / 2n), minDeposit: "0" },
      memo: "Pizza dinner",
    })
    saveTicketSignupAccount("localhost", "id:paylink-frag", {
      credentialId: "ticket-a",
      l2Address: L2_ADDRESS,
      tag: "taga",
    })
    passingGate()
    h.reusePasskeyAccount.mockImplementation(
      async (
        _w: unknown,
        _a: unknown,
        _h: unknown,
        gate: Gate,
        _signal?: AbortSignal,
        own?: PasskeyRequestScope,
      ) => {
        await gate()
        await harness.answered("assert", own)
        return fakeKeys
      },
    )
    await renderPage()
    await click("Continue with your passkey")
    await settleReads()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "onboarding",
        outcome: "succeeded",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("claiming the payment from the pending step recovers the passkey and reports it", async () => {
    screenProps = { ticketSignup: true }
    stashTicketSignup({
      fragment: "paylink-frag",
      threshold: String(2n * 10n ** 18n),
      schedule: { fee: String(10n ** 18n / 2n), minDeposit: "0" },
      memo: "Pizza dinner",
      amount: String(20n * 10n ** 18n),
    })
    await seedPending()
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor(Date.now() / 1000) + 7200,
      fee: String(10n ** 18n / 2n),
      minDeposit: "0",
      feeWaived: true,
      paylinkFunded: true,
      paylinkId: "id:paylink-frag",
    })
    passingGate()
    h.reusePasskeyAccount.mockImplementation(
      async (
        _w: unknown,
        _a: unknown,
        _h: unknown,
        gate: Gate,
        _signal?: AbortSignal,
        own?: PasskeyRequestScope,
      ) => {
        await gate()
        await harness.answered("assert", own)
        return fakeKeys
      },
    )
    await renderPage()
    await settleReads()
    await click("Claim your payment")
    await settleReads()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "onboarding",
        outcome: "succeeded",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })
})

describe("campaign hand-off — the URL's tag and passkey win", () => {
  const auth = {
    clear: vi.fn(),
    lockOut: vi.fn(),
    rootCredentialId: vi.fn(async () => undefined as string | undefined),
  }
  beforeEach(() => {
    auth.clear.mockClear()
    auth.rootCredentialId.mockResolvedValue(undefined)
    h.getAuthService.mockReturnValue(auth)
  })

  it.each(["", "&rp=wallet.zk.money", "&rp=staging.zk.money"])(
    "ignores a stale handoff RP %s",
    async (rp) => {
      await render(`/claim/newtag?entry=passkey&cred=old-credential${rp}`)
      expect(container.querySelector('[aria-label="Account setup"]')).toBeNull()
      expect(h.resolveHandoff).not.toHaveBeenCalled()
    },
  )

  it("an in-flight record for another tag does not capture the wizard, and is abandoned only once the hand-off passkey resolves (no custody)", async () => {
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    await seedRecord({ tag: "oldtag" })
    await render("/claim/newtag?entry=passkey&rp=localhost&cred=c1&pk=ab")
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(container.textContent).toContain("@newtag.zk.money")
    expect(container.textContent).not.toContain("oldtag")
    // Nothing has moved yet: a refused or unknown hand-off must leave the old record in place.
    expect(getPendingStore().current()?.tag).toBe("oldtag")

    // The abandon lands inside adoption's pre-commit step: after the account resolved, before
    // storage moves to the hand-off's account.
    let tagBefore: string | undefined
    let tagAfter: string | undefined
    h.adoptHandoff.mockImplementationOnce(
      async (_wallet, _resolved, beforeCommit?: () => Promise<void>) => {
        tagBefore = getPendingStore().current()?.tag
        await beforeCommit?.()
        tagAfter = getPendingStore().current()?.tag
        return fakeKeys
      },
    )
    await leaveIntro()
    await clickDeposit()
    expect(h.resolveHandoff).toHaveBeenCalledTimes(2)
    expect(tagBefore).toBe("oldtag")
    expect(tagAfter).not.toBe("oldtag")
    expect(getPendingStore().current()?.tag).not.toBe("oldtag")
  })

  it("another tag's earned expectation and deposit receipt do not price the hand-off's paid tag", async () => {
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    try {
      await seedRecord({ tag: "oldtag", fundedAt: Date.now() })
      const old = getPendingStore().current()!
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "oldtag",
        deadline: 0,
        feeWaived: false,
        earnedExpected: true,
      })
      const { recordDepositAdmission } = await import("../src/features/identity/admission")
      recordDepositAdmission(old, 5n * 10n ** 18n)
      await render("/claim/newtag?entry=passkey&rp=localhost&cred=c1&pk=ab")
      await settleReads()
      expect(container.textContent).toContain("@newtag.zk.money")

      await leaveIntro()
      expect(termsValue("total")).toBe(ask("standard"))
      expect(container.textContent).not.toContain("Tag priceWaived")
      expect(button("I'll do this later")).toBeUndefined()

      await clickDeposit()
      expect(h.claimTag).toHaveBeenCalledTimes(1)
      // The paid quote is not held to the earned total.
      expect(h.claimTag.mock.calls[0][5]).toBeFalsy()
    } finally {
      h.amounts = { min: 0n, fee: 0n }
    }
  })

  it("a funded record for another tag stays tracked, and the wizard still opens on the URL's tag", async () => {
    await seedRecord({ tag: "oldtag", fundedAt: Date.now() })
    await render("/claim/newtag?entry=passkey&rp=localhost&cred=c1&pk=ab")
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(container.textContent).toContain("@newtag.zk.money")
    expect(getPendingStore().current()?.tag).toBe("oldtag")
  })

  it("a different local identity is signed out only once the hand-off passkey resolves", async () => {
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    saveWalletIdentity({ handle: "someoneelse", address: L2_ADDRESS, claimedAt: 1 })
    auth.rootCredentialId.mockResolvedValue("other-cred")
    await render("/claim/newtag?entry=passkey&rp=localhost&cred=c1&pk=ab")
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(container.textContent).toContain("@newtag.zk.money")
    // Mounting the hand-off clears nothing.
    expect(loadWalletIdentity()?.handle).toBe("someoneelse")
    expect(auth.clear).not.toHaveBeenCalled()

    await leaveIntro()
    await clickDeposit()
    expect(loadWalletIdentity()?.handle).not.toBe("someoneelse")
  })

  it("a hand-off that resolves to no wallet leaves the local session untouched", async () => {
    saveWalletIdentity({ handle: "someoneelse", address: L2_ADDRESS, claimedAt: 1 })
    await seedRecord({ tag: "oldtag" })
    await render("/claim/newtag?entry=passkey&rp=localhost&cred=c1&pk=ab")
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    h.resolveHandoff.mockRejectedValueOnce(new Error("No wallet was found for this passkey"))
    await leaveIntro()
    await clickDeposit()
    // Once with no tap, refused; once on the tap.
    expect(h.resolveHandoff).toHaveBeenCalledTimes(2)
    expect(h.adoptHandoff).not.toHaveBeenCalled()
    expect(loadWalletIdentity()?.handle).toBe("someoneelse")
    expect(getPendingStore().current()?.tag).toBe("oldtag")
    expect(h.claimTag).not.toHaveBeenCalled()
  })

  it("the same passkey and tag leave the local session alone", async () => {
    saveWalletIdentity({ handle: "newtag", address: L2_ADDRESS, claimedAt: 1, pending: true })
    auth.rootCredentialId.mockResolvedValue("c1")
    await render("/claim/newtag?entry=passkey&rp=localhost&cred=c1&pk=ab")
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(auth.clear).not.toHaveBeenCalled()
    expect(loadWalletIdentity()?.handle).toBe("newtag")
  })

  it("a ceremony cancelled before it resolves adopts nothing and displaces nothing", async () => {
    let release!: (value: unknown) => void
    saveWalletIdentity({ handle: "someoneelse", address: L2_ADDRESS, claimedAt: 1 })
    await seedRecord({ tag: "oldtag" })
    await render("/claim/newtag?entry=passkey&rp=localhost&cred=c1&pk=ab")
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    h.resolveHandoff.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    await leaveIntro()
    await clickDeposit()
    await click("Cancel")

    // WebAuthn has no client-side abort: the ceremony completes anyway, and its result is dropped.
    // Nothing was written, so the next click asks again.
    await act(async () => release(fakeResolved))
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(h.adoptHandoff).not.toHaveBeenCalled()
    expect(h.setObsidionAccount).not.toHaveBeenCalled()
    expect(loadWalletIdentity()?.handle).toBe("someoneelse")
    expect(getPendingStore().current()?.tag).toBe("oldtag")
    expect(h.claimTag).not.toHaveBeenCalled()
  })

  it("once adoption starts, Cancel is withdrawn and the switch finishes", async () => {
    let release!: () => void
    h.adoptHandoff.mockImplementationOnce(
      async (_wallet, _resolved, beforeCommit?: () => Promise<void>) => {
        await new Promise<void>((resolve) => (release = resolve))
        await beforeCommit?.()
        return fakeKeys
      },
    )
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    await render("/claim/newtag?entry=passkey&rp=localhost&cred=c1&pk=ab")
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    await leaveIntro()
    await clickDeposit()
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(container.textContent).toContain("Finishing sign-in")
    expect(button("Cancel")).toBeUndefined()

    await act(async () => release())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(h.setObsidionAccount).toHaveBeenCalledTimes(1)
    expect(h.claimTag).toHaveBeenCalledTimes(1)
  })
})

describe("deposit terms step — before any passkey prompt", () => {
  it("closes paid terms only with the X before creating an account", async () => {
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await leaveIntro()
    expect(container.textContent).toContain("Get instant access")
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    expect(close).not.toBeNull()

    const dialog = container.querySelector("dialog")!
    for (const event of [
      new MouseEvent("click", { bubbles: true }),
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      new Event("cancel", { cancelable: true }),
    ]) {
      await act(async () => {
        dialog.dispatchEvent(event)
      })
      expect(container.querySelector("dialog")).toBe(dialog)
      expect(dialog.open).toBe(true)
      expect(h.navigate).not.toHaveBeenCalled()
    }

    await act(async () => {
      close!.click()
    })

    expect(container.querySelector("dialog")).toBeNull()
    expect(h.navigate).toHaveBeenCalledWith("/claim", { replace: true })
    expect(h.createAccount).not.toHaveBeenCalled()
    // The no-tap attempt ran and found no material; nothing was claimed.
    expect(h.resolveHandoff).toHaveBeenCalledTimes(1)
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(getPendingStore().current()).toBeNull()
    // The name is the user's own campaign reservation. The probe answers anonymously — it would
    // read that reservation as "held by someone else" and refuse them their own tag — so a
    // hand-off never runs it.
    expect(container.querySelector('[data-testid="invite-probe"]')?.textContent).toBe("false")

    await click("landing-signin")
    expect(container.textContent).toContain("Get instant access")
  })

  it("quotes the terms and the campaign's benefits, then goes on to the passkey", async () => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    h.skim = 5n * 10n ** 17n
    try {
      await render("/claim/taga?fee=waived&until=1700000000")
      await click("landing-signin")
      await settleReads()
      const text = container.textContent!
      expect(text).toContain("Activate account")
      expect(text).toContain("@taga.zk.money")
      expect(text).toContain("The tag is free.")
      // The schedule arrives with the signed claim; the ask needs none, so the hint quotes it now
      // and the split it would buy is left off entirely.
      expect(termsValue("total")).toBe(ask("earned_tag"))
      expect(h.scheduleReads).toBe(0)
      expect(termsValue("network-fee")).toBeUndefined()
      expect(termsValue("network-funding")).toBeUndefined()
      expect(termsValue("opening-balance")).toBeUndefined()
      expect(termsValue("tag-price")).toBe("Waived")
      expect(text).toContain("Reserved until")
      expect(text).not.toContain("create-modal")
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(button("I'll do this later")).toBeTruthy()

      await click(`Deposit ${ask("earned_tag")}`)
      expect(h.createAccount).toHaveBeenCalledTimes(1)
    } finally {
      h.amounts = { min: 0n, fee: 0n }
      h.skim = 0n
    }
  })

  it("quotes a paid tag's ask alone before the claim, with no schedule read behind it", async () => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    await render("/claim/taga")
    await click("landing-signin")
    await settleReads()
    expect(termsValue("total")).toBe(ask("standard"))
    expect(h.scheduleReads).toBe(0)
    for (const row of ["tag-price", "network-funding", "opening-balance"]) {
      expect(termsValue(row)).toBeUndefined()
    }
    expect(container.textContent).not.toContain(DEPOSIT_TERMS_PENDING)
  })

  it("a link stashed for an ordinary claim on Home leaves the signup on its own schedule", async () => {
    sessionStorage.setItem(CLAIM_STASH_KEY, "paylink-frag")
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    try {
      await render("/claim/taga")
      await click("landing-signin")
      await settleReads()
      const text = container.textContent!
      expect(text).toContain("Get instant access")
      expect(text).toContain("Total to send$15.00")
      expect(text).not.toContain("This payment covers your account")
      expect(text).not.toContain("Welcome")
      expect(button("Deposit $15.00")).toBeTruthy()
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
    } finally {
      h.amounts = { min: 0n, fee: 0n }
    }
  })

  it("an ordinary stashed link resumes a leftover reservation like any other reload", async () => {
    sessionStorage.setItem(CLAIM_STASH_KEY, "paylink-frag")
    await seedRecord({ tag: "hmm2" })
    await render("/claim")
    await settleReads()
    expect(h.claimSponsoredLink).not.toHaveBeenCalled()
    expect(container.textContent).toContain("@hmm2.zk.money")
    expect(container.textContent).not.toContain("Claim your payment")
  })

  describe("a ticket-funded signup (the link pays for the account)", () => {
    const ONE = 10n ** 18n
    /** The signer marks a ticket's terms as such; a reduced flag alone is an earned tag. */
    const TICKET_CLAIM = {
      ...WAIVED_CLAIM,
      terms: { ...WAIVED_CLAIM.terms, reduced: true, ticket: true },
    }
    beforeEach(() => {
      screenProps = { ticketSignup: true }
    })
    const ticketStash = (over: { fragment?: string; amount?: bigint } = {}) =>
      stashTicketSignup({
        fragment: over.fragment ?? "paylink-frag",
        threshold: (2n * ONE).toString(),
        schedule: { fee: (ONE / 2n).toString(), minDeposit: "0" },
        memo: "Pizza dinner",
        ...(over.amount !== undefined ? { amount: over.amount.toString() } : {}),
      })
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!
      .set!
    const typeTag = (tag: string) =>
      act(async () => {
        const input = container.querySelector<HTMLInputElement>('input[aria-label="Your tag"]')
        if (!input) throw new Error("no tag field")
        setValue.call(input, tag)
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
    /** Tag step → welcome step → the ceremony's CTA. */
    const walkToPasskey = async () => {
      await render("/claim")
      if (container.querySelector('input[aria-label="Your tag"]')) {
        await typeTag("taga")
        await click("Claim tag")
        expect(container.textContent).toContain("Welcome taga!")
      }
      expect(container.textContent).not.toContain("Deposit")
      await click(
        button("Continue with your passkey")
          ? "Continue with your passkey"
          : "Create account with passkey",
      )
    }
    const pendingClaim = (claim: unknown, recordOver: Partial<PendingRegistrationRecord> = {}) =>
      h.claimTag.mockImplementation(async (tag: string) => {
        await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag, ...recordOver }))
        return { kind: "pending", claim, oxideAccount: ACCOUNT }
      })

    it("recovers the saved ticket account after key collection fails", async () => {
      ticketStash()
      h.collectOnboardingKeys.mockRejectedValueOnce(new Error("wallet is locked"))
      await walkToPasskey()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(loadTicketSignupAccount("localhost", "id:paylink-frag")?.credentialId).toBe(
        "new-ticket-passkey",
      )
      await act(async () => root.unmount())
      root = createRoot(container)
      sessionStorage.clear()
      ticketStash()
      pendingClaim(TICKET_CLAIM)
      await walkToPasskey()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.reusePasskeyAccount).toHaveBeenCalledTimes(1)
      expect(h.claimTag).toHaveBeenCalledTimes(1)
    })

    /** The session writes its checkpoint the way `claimTag` does, then dies before the outcome. */
    const interruptedAfterCheckpoint = () =>
      h.claimTag.mockImplementationOnce(
        async (
          tag: string,
          _keys: unknown,
          _config: unknown,
          _wallet: unknown,
          _onStage: unknown,
          earned: unknown,
          _refunded: unknown,
          _replaced: unknown,
          ticket: unknown,
        ) => {
          await seedRecord({ tag })
          saveRegistrationTerms(
            realOxideOnboarding.checkpointRegistrationTerms(ACCOUNT, tag, TICKET_CLAIM as never, {
              earnedExpected: earned === true,
              ticket: ticket as never,
            }),
          )
          throw new Error("interrupted after checkpoint")
        },
      )

    it("a same-wizard retry resumes a registration interrupted after its checkpoint without signing another claim", async () => {
      ticketStash()
      interruptedAfterCheckpoint()
      await walkToPasskey()
      expect(button("claim-tag")).toBeTruthy()
      await click("claim-tag")
      expect(container.textContent).toContain("@taga")
      expect(button("claim-tag")).toBeUndefined()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.claimTag).toHaveBeenCalledTimes(1)
    })

    it("a reopen after the checkpoint resumes the bound registration without another proof or claim", async () => {
      ticketStash()
      interruptedAfterCheckpoint()
      await walkToPasskey()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.claimTag).toHaveBeenCalledTimes(1)
      await act(async () => root.unmount())
      root = createRoot(container)
      sessionStorage.clear()
      ticketStash()
      ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
      await getPendingStore().load()
      await render("/claim")
      await settleReads()
      expect(container.textContent).toContain("@taga")
      expect(container.textContent).not.toContain("Choose your")
      expect(button("Continue with your passkey")).toBeUndefined()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
      expect(h.claimTag).toHaveBeenCalledTimes(1)
    })

    it("a refused attempt write prevents opening the authenticator", async () => {
      ticketStash()
      const original = Storage.prototype.setItem
      const write = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
          if (key.startsWith("obsidion.ticket-signup.account:"))
            throw new DOMException("full", "QuotaExceededError")
          return original.call(this, key, value)
        })
      try {
        await walkToPasskey()
        expect(h.createAccount).not.toHaveBeenCalled()
        expect(h.claimTag).not.toHaveBeenCalled()
      } finally {
        write.mockRestore()
      }
    })

    it("a failed binding write preserves the incomplete attempt and requires an explicit restart", async () => {
      ticketStash()
      const original = Storage.prototype.setItem
      const write = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
          if (key.startsWith("obsidion.ticket-signup.account:") && JSON.parse(value).credentialId)
            throw new DOMException("full", "QuotaExceededError")
          return original.call(this, key, value)
        })
      try {
        await walkToPasskey()
      } finally {
        write.mockRestore()
      }
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(loadTicketSignupAttempt("localhost", "id:paylink-frag")).toMatchObject({
        phase: "creating",
      })
      await act(async () => root.unmount())
      root = createRoot(container)
      ticketStash()
      await render("/claim")
      expect(container.textContent).toContain("No ticket was redeemed")
      expect(button("Create another passkey")).toBeTruthy()
      expect(button("Create account with passkey")).toBeUndefined()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      pendingClaim(TICKET_CLAIM)
      await click("Create another passkey")
      expect(h.createAccount).toHaveBeenCalledTimes(2)
      expect(h.claimTag).toHaveBeenCalledTimes(1)
    })

    it("an interrupted creation cannot silently create again on reopening", async () => {
      ticketStash()
      beginTicketSignupAccount("localhost", "id:paylink-frag", "taga")
      await render("/claim")
      await settleReads()
      expect(container.textContent).toContain("No ticket was redeemed")
      expect(button("Create another passkey")).toBeTruthy()
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
    })

    it("a stale tab cannot restart an attempt another tab already restarted", async () => {
      ticketStash()
      const first = beginTicketSignupAccount("localhost", "id:paylink-frag", "taga")
      await render("/claim")
      await settleReads()
      expect(button("Create another passkey")).toBeTruthy()
      // Another tab restarts the same attempt and opens its own ceremony.
      restartTicketSignupAccount("localhost", "id:paylink-frag", first.attemptId)
      const second = beginTicketSignupAccount("localhost", "id:paylink-frag", "taga")
      await click("Create another passkey")
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(loadTicketSignupAttempt("localhost", "id:paylink-frag")).toEqual(second)
      expect(container.textContent).toContain("restarted in another tab")
      expect(button("Create another passkey")).toBeTruthy()
      // The other tab's ceremony completes and binds the account this link continues with.
      completeTicketSignupAccount("localhost", "id:paylink-frag", second.attemptId, {
        credentialId: "other-tab-passkey",
        l2Address: L2_ADDRESS,
      })
      expect(loadTicketSignupAccount("localhost", "id:paylink-frag")).toEqual({
        credentialId: "other-tab-passkey",
        l2Address: L2_ADDRESS,
        tag: "taga",
      })
    })

    it("resumes ticket A and pins status checks when an unrelated record is newer", async () => {
      ticketStash()
      saveTicketSignupAccount("localhost", "id:paylink-frag", {
        credentialId: "ticket-a",
        l2Address: L2_ADDRESS,
        tag: "taga",
      })
      await seedRecord({ tag: "taga", startTime: Date.now() - 60000 })
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: String(ONE / 2n),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      const OTHER = "0x00000000000000000000000000000000000000bb"
      await getPendingStore().upsert(
        OTHER,
        {},
        baseRecord({ tag: "tagb", l2Address: `0x${"ef".repeat(32)}` }),
      )
      await render("/claim")
      await settleReads()
      expect(container.textContent).not.toContain("Choose your")
      expect(container.textContent).toContain("@taga")
      expect(container.textContent).not.toContain("@tagb")
      h.runDetectionTick.mockClear()
      await clickCheck()
      expect(h.runDetectionTick).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          expectedRecord: { account: ACCOUNT, nameHash: NAME_HASH },
        }),
      )
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(getPendingStore().get(OTHER)?.phase).toBe("awaiting_deposit")
    })

    it("recovers the bound account before loading its registration after an account switch", async () => {
      const { setActiveStorageId } = await import("../src/platform/storage/activeStorage")
      setActiveStorageId("account-a")
      await getPendingStore().reload()
      ticketStash()
      saveTicketSignupAccount("localhost", "id:paylink-frag", {
        credentialId: "ticket-a",
        l2Address: L2_ADDRESS,
        tag: "taga",
      })
      await seedRecord({ tag: "taga" })
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: String(ONE / 2n),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      setActiveStorageId("account-b")
      ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
      await getPendingStore().load()
      await getPendingStore().upsert(
        "0x00000000000000000000000000000000000000bb",
        {},
        baseRecord({ tag: "tagb", l2Address: `0x${"ef".repeat(32)}` }),
      )
      await render("/claim")
      expect(container.textContent).toContain("Continue your signup")
      expect(container.textContent).not.toContain("Choose your")
      h.reusePasskeyAccount.mockImplementationOnce(async () => {
        setActiveStorageId("account-a")
        return fakeKeys
      })
      h.reloadIfSessionSwitched.mockReturnValueOnce(true)
      await click("Continue with your passkey")
      expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
        h.aztec.obsidionWallet,
        L2_ADDRESS,
        { credentialId: "ticket-a" },
        expect.any(Function),
        expect.any(AbortSignal),
        expect.any(Function),
      )
      expect(h.reloadIfSessionSwitched).toHaveBeenCalledWith("account-b", L2_ADDRESS)
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
      await act(async () => root.unmount())
      root = createRoot(container)
      ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
      await getPendingStore().load()
      await render("/claim")
      expect(container.textContent).toContain("@taga")
      expect(container.textContent).not.toContain("Choose your")
      expect(h.claimTag).not.toHaveBeenCalled()
    })

    it("a clean ticket signup creates a passkey and binds it to this link", async () => {
      ticketStash({ amount: 20n * ONE })
      h.getAuthService.mockReturnValue({ recoverFromCache: async () => undefined })
      pendingClaim(TICKET_CLAIM)
      await walkToPasskey()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
      expect(h.claimTag).toHaveBeenCalledTimes(1)
      expect(loadTicketSignupAccount("localhost", "id:paylink-frag")).toEqual({
        credentialId: "new-ticket-passkey",
        l2Address: L2_ADDRESS,
        tag: "taga",
      })
    })

    it.each([false, true])(
      "a new ticket signup ignores an unrelated account, nameless identity=%s",
      async (nameless) => {
        ticketStash({ amount: 20n * ONE })
        if (nameless) saveWalletIdentity({ address: L2_ADDRESS, claimedAt: 1 })
        const recoverFromCache = vi.fn(async () => ({
          credentialId: "previous-account-passkey",
          expectedAddress: L2_ADDRESS,
        }))
        h.getAuthService.mockReturnValue({ recoverFromCache })
        pendingClaim(TICKET_CLAIM)
        await walkToPasskey()
        expect(h.createAccount).toHaveBeenCalledTimes(1)
        expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
        expect(recoverFromCache).not.toHaveBeenCalled()
        expect(h.claimTag).toHaveBeenCalledTimes(1)
      },
    )

    it("a failed ticket signup recovers its own passkey after the wizard remounts", async () => {
      ticketStash({ amount: 20n * ONE })
      h.claimTag.mockRejectedValueOnce(new Error("account service unavailable"))
      await walkToPasskey()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(getPendingStore().current()).toBeNull()
      await act(async () => root.unmount())
      root = createRoot(container)
      sessionStorage.clear()
      ticketStash({ amount: 20n * ONE })
      pendingClaim(TICKET_CLAIM)
      await walkToPasskey()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
        h.aztec.obsidionWallet,
        L2_ADDRESS,
        { credentialId: "new-ticket-passkey" },
        expect.any(Function),
        expect.any(AbortSignal),
        expect.any(Function),
      )
      expect(h.claimTag).toHaveBeenCalledTimes(2)
    })

    it("another ticket's saved account does not replace creation", async () => {
      ticketStash()
      saveTicketSignupAccount("localhost", "id:another-link", {
        credentialId: "other-ticket-passkey",
        l2Address: L2_ADDRESS,
      })
      pendingClaim(TICKET_CLAIM)
      await walkToPasskey()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
    })

    it("an unreadable saved binding fails without creating or claiming", async () => {
      ticketStash()
      localStorage.setItem("obsidion.ticket-signup.account:localhost:id:paylink-frag", "broken")
      await walkToPasskey()
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(container.textContent).toContain("account could not be read")
    })

    it("a binding from another RP does not select the ticket's passkey", async () => {
      ticketStash()
      saveTicketSignupAccount("another-rp", "id:paylink-frag", {
        credentialId: "other-rp-passkey",
        l2Address: L2_ADDRESS,
      })
      pendingClaim(TICKET_CLAIM)
      await walkToPasskey()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
    })

    it("a refused bound passkey neither creates another account nor redeems the ticket", async () => {
      ticketStash()
      saveTicketSignupAccount("localhost", "id:paylink-frag", {
        credentialId: "ticket-passkey",
        l2Address: L2_ADDRESS,
      })
      h.reusePasskeyAccount.mockRejectedValueOnce(new PasskeyMismatchError())
      await walkToPasskey()
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(container.textContent).toContain("isn't the passkey")
    })

    it("the same ticket resumes its committed registration without choosing a new account", async () => {
      ticketStash()
      await seedRecord({ tag: "taga" })
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: String(ONE / 2n),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      await render("/claim")
      await settleReads()
      expect(container.textContent).not.toContain("Choose your")
      expect(container.textContent).toContain("@taga")
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
    })

    it("a named identity prevents the generic cache shortcut", async () => {
      ticketStash({ amount: 20n * ONE })
      saveWalletIdentity({ handle: "previous-tag", address: L2_ADDRESS, claimedAt: 1 })
      const recoverFromCache = vi.fn(async () => ({
        credentialId: "previous-account-passkey",
        expectedAddress: L2_ADDRESS,
      }))
      h.getAuthService.mockReturnValue({ recoverFromCache })
      pendingClaim(TICKET_CLAIM)
      await walkToPasskey()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
      expect(recoverFromCache).not.toHaveBeenCalled()
    })

    it("tickets paused before the redeem: the signup goes on at the signed price and keeps the link for Home", async () => {
      ticketStash({ amount: 20n * ONE })
      const PAID_CLAIM = {
        ...CLAIM,
        terms: {
          ...WAIVED_CLAIM.terms,
          fee: "4900000000000000000",
          minDeposit: "9500000000000000000",
        },
      }
      h.claimTag.mockImplementation(async (tag: string) => {
        await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
        return {
          kind: "pending",
          claim: PAID_CLAIM,
          oxideAccount: ACCOUNT,
          ticketUnavailable: true,
        }
      })
      await walkToPasskey()
      await settleReads()
      expect(sessionStorage.getItem(TICKET_STASH_KEY)).toBeNull()
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
      expect(container.textContent).toContain("paylink tickets are paused right now")
      expect(container.textContent).toContain("Get instant access")
      expect(container.textContent).toContain("Send the deposit to the address below")
      expect(button("Claim your payment")).toBeUndefined()
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(getPendingStore().current()?.phase).toBe("awaiting_deposit")
      const terms = loadRegistrationTerms(ACCOUNT, "taga")
      expect(terms).toMatchObject({ fee: "4900000000000000000", feeWaived: false })
      expect(terms?.paylinkFunded).toBeUndefined()
      expect(terms?.paylinkId).toBeUndefined()
    })

    it("a ticket redeemed before the pause still prices the claim: the ticket path goes on", async () => {
      ticketStash({ amount: 20n * ONE })
      h.claimTag.mockImplementation(async (tag: string) => {
        await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
        return {
          kind: "pending",
          claim: TICKET_CLAIM,
          oxideAccount: ACCOUNT,
          ticketUnavailable: true,
        }
      })
      await walkToPasskey()
      expect(sessionStorage.getItem(TICKET_STASH_KEY)).not.toBeNull()
      expect(container.textContent).toContain("Someone sent you")
      expect(container.textContent).not.toContain("paylink tickets are paused")
      expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
    })

    it("an ordinary pending registration ignores another visitor's ticket marker", async () => {
      screenProps = {}
      await seedRecord()
      waivedTerms()
      ticketStash({ fragment: "unrelated-link", amount: 20n * ONE })
      await render("/claim")
      await settleReads()
      expect(container.textContent).not.toContain("Claim your payment")
      expect(button("Enter now, deposit later")).toBeTruthy()
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
    })

    it("a pending registration continues only with the link its terms name", async () => {
      screenProps = {}
      await seedRecord()
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: (ONE / 2n).toString(),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      ticketStash({ fragment: "other-link", amount: 20n * ONE })
      await render("/claim")
      await settleReads()
      expect(container.textContent).not.toContain("Claim your payment")

      ticketStash({ amount: 20n * ONE })
      await render("/claim")
      await settleReads()
      expect(container.textContent).toContain("Claim your payment")
    })

    it("a pending registration continues with the bound link reopened without its marker", async () => {
      screenProps = {}
      await seedRecord()
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: (ONE / 2n).toString(),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      sessionStorage.setItem(CLAIM_STASH_KEY, "paylink-frag")
      await render("/claim")
      await settleReads()
      expect(container.textContent).toContain("Claim your payment")
      expect(container.textContent).not.toContain("Send 15 DAI")
      expect(button("Enter now, deposit later")).toBeUndefined()
    })

    it("holds the claim of a bound link while the address is unpublished, and says so", async () => {
      screenProps = {}
      await seedRecord({ broadcast: false })
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: (ONE / 2n).toString(),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      ticketStash({ amount: 20n * ONE })
      await render("/claim")
      await settleReads()
      expect(container.textContent).toContain("being published")
      expect(container.textContent).not.toContain("Send 15 DAI")
      expect(button("Claim your payment")?.disabled).toBe(true)
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
    })

    it("re-reads the activation at the click: a burn already out claims nothing", async () => {
      screenProps = {}
      await seedRecord()
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: (ONE / 2n).toString(),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      ticketStash({ amount: 20n * ONE })
      await render("/claim")
      await settleReads()
      expect(button("Claim your payment")?.disabled).toBe(false)
      // Another tab's claim seeded the burn's record between the render and the click.
      const { WithdrawalStorage } = await import("@obsidion/front-core")
      const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")
      await WithdrawalStorage.get(webStorage).create({
        localId: "wdraw_test",
        recipient: "0x00000000000000000000000000000000000000c3",
        recipientProvenance: "saved-recipient",
        amount: "0.61",
        tokenSymbol: "DAI",
        phase: "submitting",
        startTime: Date.now(),
      })
      await click("Claim your payment")
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(container.textContent).toContain("already claimed")
    })

    /**
     * Expired paylink-funded terms plus a forced tick whose re-sign answers `quote`. A reduced quote
     * runs a stubbed tick (the real machine would go on to broadcast); a paid one runs the real
     * resume machine, which reads such a claim as ordinary and backs off without reporting.
     */
    const renewal = async (quote: { fee: bigint; minDeposit: bigint; reduced: boolean }) => {
      screenProps = {}
      await seedRecord({
        fee: (ONE / 2n).toString(),
        beneficiary: "0x00000000000000000000000000000000000000b5",
      })
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) - 60,
        fee: (ONE / 2n).toString(),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      ticketStash({ amount: 20n * ONE })
      await render()
      const deadline = Math.floor(Date.now() / 1000) + 7200
      const signDomain = vi.fn(async (_req: unknown) => ({
        ...CLAIM,
        deadline: String(deadline),
        terms: {
          fee: quote.fee.toString(),
          minDeposit: quote.minDeposit.toString(),
          reduced: quote.reduced,
          ticket: quote.reduced,
        },
      }))
      if (quote.reduced) {
        h.buildRetrySignDeps.mockReturnValue({ accountService: { signDomain } })
        h.runDetectionTick.mockImplementation(
          async (deps: {
            getSignDeps: () => Promise<{ accountService: { signDomain: typeof signDomain } }>
          }) => {
            const sign = await deps.getSignDeps()
            await sign.accountService.signDomain({ nameHash: NAME_HASH, userAddress: ACCOUNT })
            await getPendingStore().upsert(ACCOUNT, { broadcast: true })
            return "pending"
          },
        )
      } else {
        const real = await vi.importActual<
          typeof import("../src/features/onboarding/webRegistration")
        >("../src/features/onboarding/webRegistration")
        h.runDetectionTick.mockImplementation(real.runDetectionTick)
        h.buildRetrySignDeps.mockReturnValue({
          masterSecret: `0x${"11".repeat(32)}`,
          accountService: { signDomain },
          deriveRegistrationSipa: async () => ({
            sipaAddress: "0x00000000000000000000000000000000000000c3",
            sipaArgs: {},
          }),
          broadcast: vi.fn(),
        })
        h.buildWebDetectionDeps.mockImplementation(async (_config: unknown, extras = {}) => ({
          ...extras,
          env: { l1ChainId: 11155111, registry: ACCOUNT, factory: ACCOUNT, feeToken: ACCOUNT },
          l1: {
            readUserAddress: async () => "0x0000000000000000000000000000000000000000",
            readNameOf: async () => `0x${"00".repeat(32)}`,
            predictAccountAddress: async () => ACCOUNT,
          },
          deposits: {
            readFunding: async () => [],
            readSweeps: async () => [],
            readBalance: async () => 0n,
            floor: async () => ONE / 2n,
          },
          pendingStore: getPendingStore(),
          publicClient: {},
        }))
      }
      await click("Refresh deposit amount")
      expect(signDomain).toHaveBeenCalledOnce()
      return deadline
    }

    it("renewing the signed claim keeps the ticket continuation while the quote still funds it", async () => {
      const deadline = await renewal({ fee: ONE / 2n, minDeposit: 0n, reduced: true })
      expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({
        deadline,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      expect(loadRegistrationTerms(ACCOUNT, "taga")?.paylinkBlocked).toBeUndefined()
      expect(button("Claim your payment")).toBeTruthy()
      const { ticketSignupContinuation } = await import(
        "../src/features/paylink/ticketContinuation"
      )
      expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toMatchObject({
        activation: { state: "ready" },
      })
    })

    it("a renewed quote the link can no longer pay for blocks the link on this signup, and says so", async () => {
      await renewal({ fee: 5n * ONE, minDeposit: 10n * ONE, reduced: false })
      // The machine swallowed the claim as ordinary; the sheet still says why nothing can be claimed.
      expect(container.textContent).toContain("did not waive the tag price")
      expect(h.showReportableError).not.toHaveBeenCalled()
      expect(button("Claim your payment")).toBeUndefined()
      expect(button("Enter now, deposit later")).toBeUndefined()
      expect(container.textContent).not.toContain("Send 15 DAI")
      expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
        paylinkBlocked: true,
      })
      const { ticketSignupContinuation, ticketSignupCommitted } = await import(
        "../src/features/paylink/ticketContinuation"
      )
      expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toMatchObject({
        activation: { state: "blocked" },
      })
      expect(ticketSignupCommitted("paylink-frag")).toBe(true)
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()

      // A later re-sign that waives the tag again lifts the block.
      h.runDetectionTick.mockImplementation(
        async (deps: {
          getSignDeps: () => Promise<{
            accountService: { signDomain: (req: unknown) => Promise<unknown> }
          }>
        }) => {
          const sign = await deps.getSignDeps()
          await sign.accountService.signDomain({ nameHash: NAME_HASH, userAddress: ACCOUNT })
          return "pending"
        },
      )
      h.buildRetrySignDeps.mockReturnValue({
        accountService: {
          signDomain: async () => ({
            ...CLAIM,
            deadline: String(Math.floor(Date.now() / 1000) + 7200),
            terms: { fee: (ONE / 2n).toString(), minDeposit: "0", reduced: true, ticket: true },
          }),
        },
      })
      saveRegistrationTerms({
        ...loadRegistrationTerms(ACCOUNT, "taga")!,
        deadline: Math.floor(Date.now() / 1000) - 60,
      })
      await settleReads()
      await click("Refresh deposit amount")
      expect(loadRegistrationTerms(ACCOUNT, "taga")?.paylinkBlocked).toBeUndefined()
      expect(button("Claim your payment")).toBeTruthy()
      expect(container.textContent).not.toContain("did not waive the tag price")
    })

    it("logging out of a blocked signup keeps the link bound and blocked until it is renewed or abandoned", async () => {
      await renewal({ fee: 5n * ONE, minDeposit: 10n * ONE, reduced: false })
      const { ticketSignupContinuation, ticketSignupCommitted } = await import(
        "../src/features/paylink/ticketContinuation"
      )
      await click("Log out")
      expect(getPendingStore().current()?.phase).toBe("awaiting_deposit")
      expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
        paylinkBlocked: true,
      })
      expect(ticketSignupCommitted("paylink-frag")).toBe(true)
      expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toMatchObject({
        activation: { state: "blocked" },
      })

      // The same pending registration, resumed: still the refusal, never a paid deposit.
      await act(async () => root.unmount())
      root = createRoot(container)
      await render("/claim/taga")
      await settleReads()
      expect(container.textContent).toContain("did not waive the tag price")
      expect(container.textContent).not.toContain("Send 15 DAI")
      expect(button("Claim your payment")).toBeUndefined()
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
    })

    it("a marker left in the tab never turns another wizard into the ticket signup", async () => {
      screenProps = {}
      ticketStash()
      pendingClaim(TICKET_CLAIM)
      await render("/claim")
      await settleReads()
      // The ordinary invitation, not the three-step modal; the marker is left where it was.
      expect(container.textContent).not.toContain("Choose your")
      expect(container.querySelector("dialog")).toBeNull()
      expect(container.textContent).toContain("landing-signin")
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(TICKET_STASH_KEY)).not.toBeNull()
    })

    it("opens on the choose-tag step over the link, ignoring a leftover reservation", async () => {
      ticketStash()
      await seedRecord({ tag: "hmm2" })
      await render("/claim")
      await settleReads()
      expect(container.querySelector("dialog")).not.toBeNull()
      expect(container.textContent).toContain("Choose your")
      expect(container.textContent).not.toContain("@hmm2.zk.money")
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
    })

    it("refuses a paid NameClaim and drops the reservation, keeping the link", async () => {
      ticketStash()
      pendingClaim(CLAIM)
      await walkToPasskey()
      expect(container.textContent).toMatch(/did not waive the tag price/)
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(getPendingStore().current()).toBeNull()
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
      expect(sessionStorage.getItem(TICKET_STASH_KEY)).not.toBeNull()
    })

    it("reviews the full split before the claim, then claims into the SIPA and opens the wallet", async () => {
      ticketStash({ amount: 20n * ONE })
      pendingClaim(TICKET_CLAIM)
      await walkToPasskey()
      const text = container.textContent!
      expect(text).toContain("Someone sent you")
      expect(text).toContain("20 DAI")
      expect(text).toContain("Pizza dinner")
      expect(text).toContain("Tag priceWaived")
      // The mocked portal cut (0.25) is paid on both legs: 0.5 sweep + 0.25 + 0.25 + 0.1 relayer.
      expect(text).toContain("Network fee1.1 DAI")
      expect(text).toContain("Proving fee1 DAI")
      expect(text).toContain("Returned after registration0.01 DAI")
      // 20 - (0.5 + 0.25 + 0.01 to the SIPA, then 0.25 + 0.1 + 1 on the way there).
      expect(text).toContain("You'll receive17.89 DAI")
      expect(text).toContain("Unclaimed")
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(loadWalletIdentity()).toBeNull()
      expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })

      // The wizard handed its ticket in: the claim redeems it, not a marker read off the tab.
      expect(h.claimTag).toHaveBeenCalledWith(
        "taga",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.any(Function),
        false,
        undefined,
        undefined,
        expect.objectContaining({ fragment: "paylink-frag" }),
      )

      await click("Claim")
      expect(h.claimSponsoredLink).toHaveBeenCalledWith(
        expect.objectContaining({ wallet: true }),
        "paylink-frag",
        undefined,
        undefined,
        { fundRegistration: true },
      )
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBeNull()
      expect(sessionStorage.getItem(TICKET_STASH_KEY)).toBeNull()
      expect(container.textContent).toContain("all-set")
      expect(loadWalletIdentity()).toMatchObject({
        handle: "taga",
        address: L2_ADDRESS,
        pending: true,
      })
    })

    it("closing the review enters the wallet with the payment unclaimed and the link kept", async () => {
      ticketStash({ amount: 20n * ONE })
      pendingClaim(TICKET_CLAIM)
      await walkToPasskey()
      await click("Close")
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
      expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
    })

    it("proves a stashed email link using its resolved commitment before claiming", async () => {
      ticketStash({ fragment: "reduced-email-frag" })
      h.viewLink.mockResolvedValue({
        flavor: "email",
        commitment: "0x123",
        email: "recipient@example.com",
      })
      pendingClaim(TICKET_CLAIM)
      await walkToPasskey()
      await click("Claim")
      expect(h.obtainEmailClaimProof).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ commitment: "0x123", email: "recipient@example.com" }),
      )
      expect(h.claimSponsoredLink).toHaveBeenCalledWith(
        expect.anything(),
        "reduced-email-frag",
        undefined,
        { vkey: [], proof: [], public_inputs: [] },
        { fundRegistration: true },
      )
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBeNull()
    })

    it("keeps the stashed email link on the review when ownership verification fails", async () => {
      ticketStash({ fragment: "reduced-email-frag" })
      h.viewLink.mockResolvedValue({ flavor: "email", commitment: "0x123" })
      h.obtainEmailClaimProof.mockRejectedValueOnce(new Error("email ownership was not proved"))
      pendingClaim(TICKET_CLAIM)
      await walkToPasskey()
      await click("Claim")
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("reduced-email-frag")
      expect(container.textContent).toContain("email ownership was not proved")
      expect(button("Claim")).toBeTruthy()
    })

    it("holds the passkey step until the SIPA broadcast lands, then reviews the claim", async () => {
      ticketStash()
      let release!: (ok: boolean) => void
      h.claimTag.mockImplementation(async (tag: string) => {
        await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag, broadcast: false }))
        return {
          kind: "pending",
          claim: TICKET_CLAIM,
          oxideAccount: ACCOUNT,
          broadcastDone: new Promise<boolean>((r) => {
            release = r
          }),
        }
      })
      await walkToPasskey()
      expect(container.textContent).toContain("Publishing your deposit address")
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(loadWalletIdentity()).toBeNull()

      await act(async () => release(true))
      expect(container.textContent).toContain("Someone sent you")
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      await click("Claim")
      expect(h.claimSponsoredLink).toHaveBeenCalledWith(
        expect.objectContaining({ wallet: true }),
        "paylink-frag",
        undefined,
        undefined,
        { fundRegistration: true },
      )
      expect(container.textContent).toContain("all-set")
    })

    it("a failed SIPA broadcast lands on the pending step without claiming or entering", async () => {
      ticketStash()
      let release!: (ok: boolean) => void
      h.claimTag.mockImplementation(async (tag: string) => {
        await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag, broadcast: false }))
        return {
          kind: "pending",
          claim: TICKET_CLAIM,
          oxideAccount: ACCOUNT,
          broadcastDone: new Promise<boolean>((r) => {
            release = r
          }),
        }
      })
      await walkToPasskey()
      await act(async () => release(false))
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
      expect(container.textContent).not.toContain("all-set")
      expect(container.textContent).not.toContain("Deposit 0")
      expect(loadWalletIdentity()).toBeNull()
    })

    describe("inside the visitor page (the link opened with no account)", () => {
      const LINK = {
        url: "http://test/link#paylink-frag",
        fragment: "paylink-frag",
        amount: "20",
        status: "unclaimed",
        flavor: "direct",
      } as never
      const BURN_HASH = `0x${"11".repeat(32)}` as Hex
      const store = () => WithdrawalStorage.get(webStorage)
      /** The record `seedRegistrationBurn` writes for this link before its batch signs. */
      const seedBurn = (localId = "wdraw_burn") =>
        store().create({
          localId,
          operationId: "paylink-claim-1",
          recipient: "0x00000000000000000000000000000000000000c3",
          recipientProvenance: "saved-recipient",
          source: "paylink",
          intent: "registration",
          paylinkId: "id:paylink-frag",
          amount: "0.61",
          rawAmount: "1810000000000000000",
          tokenSymbol: "DAI",
          phase: "submitting",
          startTime: Date.now(),
        })
      const resetStore = () => {
        ;(WithdrawalStorage as unknown as { instance: unknown }).instance = null
      }
      beforeEach(resetStore)
      afterEach(resetStore)
      const renderVisitor = () =>
        act(async () => {
          root.render(
            <MemoryRouter initialEntries={["/link"]}>
              <PaylinkVisitorScreen link={LINK} />
            </MemoryRouter>,
          )
        })
      const clickContaining = (label: string) =>
        act(async () => {
          const target = buttons().find((b) => b.textContent?.includes(label))
          if (!target) throw new Error(`no button containing "${label}"`)
          target.click()
        })
      /** Account → tag → welcome → passkey → the review's Claim, held open with its burn seeded. */
      const walkToHeldClaim = async () => {
        const settle = {} as { resolve: (hash: string) => void; reject: (err: unknown) => void }
        h.claimSponsoredLink.mockImplementation(async () => {
          await seedBurn()
          return new Promise<string>((resolve, reject) =>
            Object.assign(settle, { resolve, reject }),
          )
        })
        pendingClaim(TICKET_CLAIM)
        await renderVisitor()
        await clickContaining("Receive to zk.money")
        expect(container.textContent).toContain("Choose your")
        await typeTag("taga")
        await click("Claim tag")
        await click("Create account with passkey")
        expect(container.textContent).toContain("Someone sent you")
        await click("Claim")
        await settleReads()
        expect(h.claimSponsoredLink).toHaveBeenCalledTimes(1)
        if (!settle.resolve) throw new Error("the claim is not held")
        expect(store().list()).toMatchObject([{ localId: "wdraw_burn", phase: "submitting" }])
        return settle
      }

      it("keeps the wizard up while its burn is pending, and completes the signup on it", async () => {
        const settle = await walkToHeldClaim()
        expect(container.textContent).toContain("Someone sent you")
        expect(container.textContent).not.toContain("You withdrew")
        await act(async () => settle.resolve("0xclaim"))
        expect(container.textContent).toContain("all-set")
        expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
        // The mined burn is the link's record from here on; the page is still the signup's.
        await act(async () => {
          await store().patch("wdraw_burn", { phase: "l2_mined", l2TxHash: BURN_HASH })
        })
        expect(container.textContent).toContain("all-set")
        expect(container.textContent).not.toContain("You withdrew")
      })

      it("a refused batch fails on the review with its Claim, and the retry completes", async () => {
        const settle = await walkToHeldClaim()
        // The burn's recovery fails its record before the error reaches the wizard.
        await act(async () => {
          await store().patch("wdraw_burn", { phase: "failed", error: "Simulation failed" })
          settle.reject(new Error("Simulation failed"))
        })
        expect(container.textContent).toContain("Simulation failed")
        expect(button("Claim")).toBeTruthy()
        expect(container.textContent).not.toContain("You withdrew")
        h.claimSponsoredLink.mockImplementation(async () => {
          await seedBurn("wdraw_burn_2")
          return "0xclaim"
        })
        await click("Claim")
        expect(h.claimSponsoredLink).toHaveBeenCalledTimes(2)
        expect(container.textContent).toContain("all-set")
      })

      it("a cancelled passkey drops the burn's record and leaves the review with its Claim", async () => {
        const settle = await walkToHeldClaim()
        await act(async () => {
          await store().remove("wdraw_burn")
          settle.reject(new Error("Cancelled"))
        })
        expect(container.textContent).toContain("Someone sent you")
        expect(button("Claim")).toBeTruthy()
        expect(loadWalletIdentity()).toBeNull()
        expect(store().list()).toHaveLength(0)
      })

      it("an ordinary cash-out of the link still shows its withdrawal page", async () => {
        await store().create({
          localId: "wdraw_cashout",
          recipient: `0x${"dd".repeat(20)}`,
          recipientProvenance: "saved-recipient",
          source: "paylink",
          paylinkId: "id:paylink-frag",
          amount: "19.65",
          tokenSymbol: "DAI",
          phase: "l2_mined",
          l2TxHash: BURN_HASH,
          startTime: Date.now(),
        })
        await renderVisitor()
        expect(container.textContent).toContain("You withdrew")
        expect(container.textContent).not.toContain("Receive to zk.money")
      })
    })
  })

  it("a campaign hand-off starts from the intro and asserts the existing passkey in one step", async () => {
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    // The intro, not a screen of its own: the campaign already took the name and the passkey.
    expect(container.textContent).toContain("@taga.zk.money")
    expect(container.textContent).not.toContain("Get instant access")
    // Only the attempt with no tap so far, and it found no material.
    expect(h.resolveHandoff).toHaveBeenCalledTimes(1)
    expect(h.claimTag).not.toHaveBeenCalled()

    await enterHandoff()
    expect(h.resolveHandoff).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      { service: true },
      h.config,
      { credentialId: "cred-1", pubkeyHex: "ab12" },
      expect.any(Function),
      expect.any(AbortSignal),
      false,
      expect.any(Function),
    )
    expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(h.claimTag).toHaveBeenCalledTimes(1)
    // The claim landed while the user was still reading: the slides stay, and what it decided
    // waits for the last tap.
    expect(h.navigate).not.toHaveBeenCalled()

    // The intro ends in the wallet. The deposit the reservation still owes is the activation
    // sheet's to ask for, on Home — never a step of the wizard.
    await leaveIntro()
    expect(h.navigate).toHaveBeenCalled()
    expect(container.textContent).not.toContain("@taga is reserved for you")
  })

  it("a hand-off leaves the wallet holding a pending name, which is what raises the activation sheet", async () => {
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await enterHandoff()
    await leaveIntro()

    // The two conditions `useAwaitingDepositRecord` reads on Home. Without the pending flag the
    // activation sheet never opens and the deposit is never asked for.
    expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
    expect(getPendingStore().current()).toMatchObject({ tag: "taga", phase: "awaiting_deposit" })
    expect(h.navigate).toHaveBeenCalled()
  })

  it("a wait that ends with no account falls back to the terms sheet, which carries the retry", async () => {
    let fail!: (err: Error) => void
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    h.resolveHandoff.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
    await enterHandoff()
    await leaveIntro()
    expect(container.querySelector('[data-testid="handoff-entering"]')).not.toBeNull()

    await act(async () => {
      fail(new Error("the prompt was closed"))
      await new Promise((r) => setTimeout(r, 0))
    })
    // Not stuck on the spinner, and not in the wallet: the sheet that can ask again.
    expect(container.querySelector('[data-testid="handoff-entering"]')).toBeNull()
    expect(h.navigate).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Get instant access")
  })

  it("a laptop's ceremony asks for its tap over the intro, which is the whole screen there", async () => {
    h.gateHook = () => ({
      gate: () => new Promise<{ signal: AbortSignal; reach: "unknown" }>(() => {}),
      state: { kind: "awaiting-action", proceed: () => {} },
      cancel: () => {},
      dismiss: () => {},
    })
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await enterHandoff()

    // Without this the hand-off begun on the first slide waits forever on a prompt the intro
    // never shows, and the last slide finds no account.
    expect(container.querySelector('[data-testid="phone-steps-continue"]')).not.toBeNull()
    // The slides are still underneath: the gate rides over the intro, it does not replace it.
    expect(container.querySelector('[data-testid="carousel-next"]')).not.toBeNull()
  })

  it("an intro finished before the claim waits for it, and never lands on a gate that bounces", async () => {
    let release!: () => void
    h.claimTag.mockImplementation(async (tag: string) => {
      await new Promise<void>((r) => (release = r))
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await enterHandoff()
    await leaveIntro()

    // The claim has saved no identity yet. Entering here is what sent the user back to /claim, so
    // the tap waits — on a spinner, not on a step of the wizard.
    expect(loadWalletIdentity()).toBeNull()
    expect(h.navigate).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="handoff-entering"]')).not.toBeNull()
    expect(container.textContent).not.toContain("Get instant access")

    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 0))
    })
    // The claim landed: the identity the gate reads is there, and the wait spends itself entering.
    expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
    expect(h.navigate).toHaveBeenCalled()
  })

  it("the hand-off's I'll do this later reserves the name and defers only the deposit", async () => {
    // The deployment's own earned schedule, which a claim signing none falls back to.
    h.amounts = { min: 44n * 10n ** 17n, fee: 5n * 10n ** 17n }
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    await render("/claim/taga?entry=passkey&rp=localhost&fee=waived&cred=cred-1&pk=ab12")
    expect(container.textContent).toContain("@taga.zk.money")

    await leaveIntro()
    await click("I'll do this later")

    // The campaign already made the passkey: assert it, never mint a second one.
    expect(h.resolveHandoff).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      { service: true },
      h.config,
      { credentialId: "cred-1", pubkeyHex: "ab12" },
      expect.any(Function),
      expect.any(AbortSignal),
      false,
      expect.any(Function),
    )
    expect(h.createAccount).not.toHaveBeenCalled()
    // The tag is claimed on both routes out of the terms; only the deposit is put off.
    expect(h.claimTag).toHaveBeenCalledTimes(1)
    expect(h.fireEvent).toHaveBeenCalledWith(
      "registration_terms_accepted",
      expect.objectContaining({ deposit_intent: false }),
    )
    // The name is reserved and the wallet opens on it; the deposit is the activation sheet's to
    // ask for once Home is up, so the wizard keeps no screen of its own.
    expect(container.textContent).toContain("all-set")
    expect(container.textContent).not.toContain("@taga is reserved for you")
  })
})
