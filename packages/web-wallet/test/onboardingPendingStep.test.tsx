import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../src/platform/storage/walletStorage"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import type { SignInRoute } from "@obsidion/core/types"
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
import { testWalletDbs } from "./support/fakeWalletDb"
import {
  earnedTerms,
  nameClaim,
  pendingRecord,
  resetRegistrationStores,
} from "./support/registrationFixtures"

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const NAME_HASH = `0x${"77".repeat(32)}` as Hex
const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex

const h = vi.hoisted(() => ({
  /** The pending deposit's processing state, as the observer reports it; none unless a test sets one. */
  processing: { current: undefined as unknown },
  /** One observer object, like the production singleton. */
  observer: {
    stateFor: () => h.processing.current,
    capacityKeyFor: () => ({ status: "unknown", retryable: false }),
    subscribe: () => () => {},
    retry: async () => undefined,
    refreshForSweep: async () => undefined,
  },
  navigate: vi.fn(),
  reloadIfSessionSwitched: vi.fn(() => false),
  takeOnboardingResume: vi.fn(() => false),
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
  routeGrantIsCurrent: vi.fn(async () => true),
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
    gate: async (_options?: unknown) => ({
      signal: new AbortController().signal,
      reach: "unknown" as const,
    }),
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
  /** Holds balanceOf(sipa) until the test lands it. */
  balanceRead: undefined as Promise<bigint> | undefined,
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
  routeGrantIsCurrent: h.routeGrantIsCurrent,
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
vi.mock("../src/features/deposit/sipaProcessing", async (original) => ({
  ...(await original<object>()),
  useSipaProcessing: () => ({ state: h.processing.current, shown: h.processing.current }),
  sipaProcessingObserver: () => h.observer,
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
      gate: (options?: unknown) => {
        const pending = hook.gate(options)
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
    buttonStyle,
  }: {
    title: string
    testId?: string
    onClick?: () => void
    isDisabled?: boolean
    buttonStyle?: string
  }) => (
    <button data-testid={testId} data-style={buttonStyle} disabled={isDisabled} onClick={onClick}>
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
vi.mock("../src/features/onboarding/sessionReload", () => ({
  reloadIfSessionSwitched: h.reloadIfSessionSwitched,
  takeOnboardingResume: h.takeOnboardingResume,
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
/** The tip the split decides; its quote and decision have a suite of their own. */
const splitTip = vi.hoisted(() => ({ value: (10n ** 18n) as bigint | undefined }))
vi.mock("../src/features/paylink/registrationProverTip", async () => {
  const { useEffect } = await import("react")
  return {
    useRegistrationSpeed: ({
      active,
      onCommit,
    }: {
      active: boolean
      onCommit: (tip: bigint, speed: string) => void
    }) => {
      const tip = active ? splitTip.value : undefined
      useEffect(() => {
        if (tip !== undefined) onCommit(tip, "faster")
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tip])
      return {
        choice: {
          loading: false,
          speed: "faster",
          setSpeed: () => {},
          settled: false,
          pricedTip: 0n,
        },
        outcome: { proverTip: 0n },
        proverTip: tip,
      }
    },
  }
})
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
        : h.balanceRead ?? h.balance,
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
// Bound before a test resets modules, so it is the class the screen's refusal check knows.
const { PhoneRequiredError: ScreenPhoneRequiredError } = await import("@obsidion/passkey-web")
const realOxideOnboarding = await vi.importActual<
  typeof import("../src/features/onboarding/oxideOnboarding")
>("../src/features/onboarding/oxideOnboarding")
const { loadWalletIdentity, saveWalletIdentity } = await import(
  "../src/features/identity/walletIdentity"
)
const { clearNameGrant } = await import("../src/features/onboarding/nameGrant")
const { loadRegistrationTerms, saveRegistrationTerms } = await import(
  "../src/features/onboarding/registrationTerms"
)
const { GateCancelledError } = await import("../src/features/identity/ceremonyGate")
const { getBroadcastLedger, resetBroadcastsForTests } = await import(
  "../src/features/broadcasts/broadcasts"
)
const { userFlowActive } = await import("../src/features/provingGate")
const { isActivationPromptOpen, resetActivationPrompt } = await import(
  "../src/features/onboarding/activationPrompt"
)
const { CLAIM_STASH_KEY, TICKET_STASH_KEY, stashTicketSignup, updateTicketSignup } = await import(
  "../src/features/paylink/claimStash"
)
const { firstWalletEntry } = await import("../src/features/onboarding/walletEntry")
const { isClaimRunning } = await import("../src/features/paylink/runningClaims")
const { getOperationStore } = await import("../src/features/operations/operations")
const { provingProgress } = await import("@obsidion/proving-progress")

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
const CLAIM = nameClaim()
const WAIVED_CLAIM = nameClaim({ terms: earnedTerms({ minDeposit: "0" }) })

let container: HTMLDivElement
let root: Root

const baseRecord = (over: Partial<PendingRegistrationRecord> = {}) =>
  pendingRecord({ account: ACCOUNT, nameHash: NAME_HASH, l2Address: L2_ADDRESS, ...over })

const seedRecord = (over: Partial<PendingRegistrationRecord> = {}) =>
  getPendingStore().upsert(ACCOUNT, {}, baseRecord(over))

/** The reduced schedule an earned tag signs: the tag price waived, the relayer's 0.5 cut kept. */
const REDUCED_FEE = String(5n * 10n ** 17n)
/** The reduced schedule a waived claim carries. */
const TERMS = earnedTerms({ fee: REDUCED_FEE })

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
/** The hand-off's no-tap attempt settles; with no material the spinner gives way to the terms sheet. */
const settleHandoff = () => act(async () => new Promise((r) => setTimeout(r, 0)))
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
  h.processing.current = undefined
  vi.clearAllMocks()
  h.getAuthService.mockReset()
  h.reloadIfSessionSwitched.mockReset().mockReturnValue(false)
  h.takeOnboardingResume.mockReset().mockReturnValue(false)
  // The asked total must come from the constants here, never from a developer's .env.local.
  vi.stubEnv("VITE_REGISTRATION_ASK_DEPOSIT_TOTAL", "")
  resetRegistrationStores()
  h.prepareRefund.mockReset()
  h.recoverDeposit.mockReset()
  h.l1.account = null
  localStorage.clear()
  sessionStorage.clear()
  clearNameGrant()
  h.routeGrantIsCurrent.mockReset().mockResolvedValue(true)
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
  h.balanceRead = undefined
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

  it.each([
    ["NotAllowedError", () => Object.assign(new Error("closed"), { name: "NotAllowedError" })],
    ["no credential", () => new Error("Passkey assertion returned no credential")],
  ])(
    "a missing passkey (%s) renders inline copy, never the error modal",
    async (_name, missing) => {
      await seedRecord({ broadcast: false })
      await render()
      h.reusePasskeyAccount.mockRejectedValue(missing())

      await click("Retry")
      expect(container.textContent).toContain("Couldn't find your passkey")
      expect(h.showReportableError).not.toHaveBeenCalled()
      expect(h.runDetectionTick).not.toHaveBeenCalled()
    },
  )

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

describe("pending step — a resumed signup's wallet entry", () => {
  const entries = () => h.fireEvent.mock.calls.filter(([name]) => name === "wallet_entered")
  const confirmOnTick = () =>
    h.runDetectionTick.mockImplementation(async () => {
      await getPendingStore().close(ACCOUNT, "confirmed")
      return "confirmed"
    })

  it("reports the entry once when a reloaded registration confirms", async () => {
    await seedRecord({ broadcast: false })
    await render("/claim/taga?src=campaign")
    confirmOnTick()
    await click("Retry")

    expect(loadWalletIdentity()).toMatchObject({ handle: "taga", address: L2_ADDRESS })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(entries()).toEqual([["wallet_entered", { has_claim_link: true, entry: "campaign" }]])
  })

  it("a registration entered while pending sends no second entry when it confirms", async () => {
    vi.useFakeTimers()
    await seedRecord()
    await render("/claim/taga")
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, { phase: "funded", fundedAt: Date.now() })
    })
    expect(loadWalletIdentity()).toMatchObject({ address: L2_ADDRESS, pending: true })
    expect(entries()).toEqual([["wallet_entered", { has_claim_link: true, entry: "link" }]])

    h.navigate.mockClear()
    await act(async () => {
      await getPendingStore().close(ACCOUNT, "confirmed")
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600)
    })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(entries()).toHaveLength(1)
  })

  it("resuming a registration after logging out of it is a return, not a second entry", async () => {
    await seedRecord({ broadcast: false })
    waivedTerms()
    await render("/claim/taga")
    await click("Enter now, deposit later")
    expect(loadWalletIdentity()).toMatchObject({ address: L2_ADDRESS, pending: true })
    expect(entries()).toHaveLength(1)

    // Back on the pending sheet, logging out drops the identity and keeps the registration.
    await act(async () => root.unmount())
    root = createRoot(container)
    await render("/claim/taga")
    await click("Log out")
    expect(loadWalletIdentity()).toBeNull()

    await act(async () => root.unmount())
    root = createRoot(container)
    h.navigate.mockClear()
    await render("/claim/taga")
    confirmOnTick()
    await click("Retry")
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(entries()).toHaveLength(1)
  })

  it("another account's entry does not hold back this account's first", async () => {
    const OTHER_L2 = `0x${"aa".repeat(32)}`
    saveWalletIdentity({ address: OTHER_L2, claimedAt: 1 })
    expect(await firstWalletEntry(OTHER_L2)).toBe(true)
    await seedRecord({ broadcast: false })
    await render("/claim/taga")
    confirmOnTick()
    await click("Retry")

    expect(entries()).toEqual([["wallet_entered", { has_claim_link: true, entry: "link" }]])
  })

  it("overlapping entries for one account find one first", async () => {
    expect(await Promise.all([firstWalletEntry(L2_ADDRESS), firstWalletEntry(L2_ADDRESS)])).toEqual(
      [true, false],
    )
  })

  it("a funded registration its deposit admits enters from two effects at once, reporting once", async () => {
    await seedRecord({ phase: "funded", fundedAt: 1, broadcast: true })
    const { recordDepositAdmission } = await import("../src/features/identity/admission")
    expect(recordDepositAdmission(getPendingStore().current()!, 10n ** 20n)).toBe(true)
    await render("/claim/taga")

    expect(h.navigate.mock.calls.filter(([to]) => to === "/").length).toBeGreaterThan(1)
    expect(entries()).toEqual([["wallet_entered", { has_claim_link: true, entry: "link" }]])
  })

  it("a funded record whose identity save fails keeps a retry that enters once saving works", async () => {
    await seedRecord({ phase: "funded", fundedAt: 1, broadcast: true })
    let refuse = true
    let attempts = 0
    testWalletDbs().onApply = (_version, ops) => {
      if (!ops.some(([key]) => key === "webwallet.identity")) return
      attempts++
      if (refuse) throw new Error("disk")
    }
    await render("/claim/taga")
    await act(async () => {})
    expect(h.navigate).not.toHaveBeenCalledWith("/", { replace: true })
    expect(button("Retry entering wallet")).toBeDefined()
    // The failed entry is not tried again on its own.
    expect(attempts).toBe(1)

    refuse = false
    await click("Retry entering wallet")
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(loadWalletIdentity()?.handle).toBe("taga")
  })

  it("adds no consent prompt: the entry goes to the consent-gated sender", async () => {
    h.asked = false
    await seedRecord({ broadcast: false })
    await render("/claim/taga")
    confirmOnTick()
    await click("Retry")

    expect(button("Share anonymous data")).toBeUndefined()
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(entries()).toEqual([["wallet_entered", { has_claim_link: true, entry: "link" }]])
  })

  it("a registration that must recover its passkey signs in, reporting no entry", async () => {
    h.hasRootBreadcrumb = false
    await seedRecord({ broadcast: false })
    await render("/claim/taga")
    confirmOnTick()
    await click("Retry")

    expect(h.navigate).toHaveBeenCalledWith("/enter?handle=taga", { replace: true })
    expect(entries()).toEqual([])
  })
})

describe("pending step — the broadcast behind the shown address", () => {
  const SIPA = "0x00000000000000000000000000000000000000c3"
  beforeEach(() => resetBroadcastsForTests())
  const claimUnpublished = (claim = CLAIM) =>
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag, broadcast: false }))
      return { kind: "pending", claim, oxideAccount: ACCOUNT }
    })

  it("owes the broadcast once the pending step shows the address, and drops its status once it lands", async () => {
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    claimUnpublished()
    await render("/claim/taga")
    await click("landing-signin")
    // The terms sheet shows no address, so nothing is owed yet.
    expect(getBroadcastLedger().get(SIPA)).toBeNull()
    await act(async () =>
      buttons()
        .find((b) => b.textContent?.startsWith("Deposit"))!
        .click(),
    )
    expect(container.textContent).toContain("0x000000...0000c3")
    await vi.waitFor(() =>
      expect(getBroadcastLedger().get(SIPA)).toMatchObject({ kind: "registration" }),
    )
    expect(
      container.querySelector('[data-testid="registration-address-publishing"]'),
    ).not.toBeNull()
    await act(async () => void (await getPendingStore().upsert(ACCOUNT, { broadcast: true })))
    expect(container.textContent).toContain("0x000000...0000c3")
    expect(container.querySelector('[data-testid="registration-address-publishing"]')).toBeNull()
  })

  it("a free name entering first owes nothing from the wizard: the activation sheet does", async () => {
    resetActivationPrompt()
    claimUnpublished({ ...CLAIM, terms: TERMS })
    try {
      await render("/claim/taga?fee=waived")
      await click("landing-signin")
      await click("I'll do this later")
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_600))
      })
      expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
      expect(isActivationPromptOpen()).toBe(true)
      expect(getBroadcastLedger().get(SIPA)).toBeNull()
    } finally {
      resetActivationPrompt()
    }
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

  it("a failed check it runs by itself waits for the next one; a failed click still reports", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await seedRecord()
    await render()
    const failed = new Error("HTTP request failed.")
    h.runDetectionTick.mockRejectedValueOnce(failed)
    h.buildWebDetectionDeps.mockRejectedValueOnce(failed)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(48_050)
    })
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain("Last checked")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24_000)
    })
    expect(container.textContent).toContain("Last checked 0s ago")
    h.runDetectionTick.mockRejectedValueOnce(failed)
    await clickCheck()
    expect(h.showReportableError).toHaveBeenCalledWith(failed, "registration:deposit")
    warn.mockRestore()
  })

  it("a failed tick that a landed deposit nudges stays quiet", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await seedRecord()
    await render()
    h.runDetectionTick.mockRejectedValueOnce(new Error("HTTP request failed."))
    h.balance = 15n * 10n ** 18n
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500)
    })
    expect(h.runDetectionTick).toHaveBeenCalledTimes(1)
    expect(h.showReportableError).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("the paused notice carries the manual check as text, with no spinner", async () => {
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

describe("pending step: the waiting block under the address", () => {
  const block = () => container.querySelector(".ww-deposit-sheet__live")
  const pill = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="deposit-check-again"]')
  const line = () => container.querySelector('[data-testid="deposit-balance"]')?.textContent
  const blockButton = (label: string) =>
    Array.from(block()?.querySelectorAll("button") ?? []).find((b) => b.textContent === label)

  it("waits with the balance at the address, and the pill runs the step's check", async () => {
    vi.useFakeTimers()
    await seedRecord()
    await render()
    expect(block()!.textContent).toContain("Waiting for deposit")
    expect(line()).toBe(`Balance at this address: ${seen(0n)}`)
    expect(blockButton("Retry")).toBeUndefined()
    const calls = h.runDetectionTick.mock.calls.length
    await act(async () => pill()!.click())
    expect(pill()!.disabled).toBe(true)
    expect(h.runDetectionTick.mock.calls.length).toBe(calls + 1)
    expect(h.runDetectionTick.mock.calls[calls][1]).toMatchObject({ force: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(pill()!.textContent).toBe("Checked")
    expect(line()).toBe(`Balance at this address: ${seen(0n)} · Last checked 0s ago`)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(line()).toContain("Last checked 3s ago")
    expect(pill()!.textContent).toBe("Check again")
    expect(pill()!.disabled).toBe(false)
  })

  it("the pill stays busy until its read of the address lands, past the step's check", async () => {
    vi.useFakeTimers()
    await seedRecord()
    await render()
    let land!: (balance: bigint) => void
    h.balanceRead = new Promise((resolve) => (land = resolve))
    await act(async () => pill()!.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(pill()!.disabled).toBe(true)
    expect(pill()!.textContent).toContain("Check again")
    h.balanceRead = undefined
    await act(async () => {
      land(0n)
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(pill()!.disabled).toBe(false)
    expect(pill()!.textContent).toBe("Checked")
    expect(line()).toBe(`Balance at this address: ${seen(0n)} · Last checked 0s ago`)
  })

  it("a partial deposit puts the shortfall on the line", async () => {
    h.balance = 5n * 10n ** 18n
    await seedRecord()
    await render()
    await settleReads()
    // The landed deposit nudges a check, so the line also says when.
    expect(line()).toBe(
      `${seen(5n * 10n ** 18n)} of ${ask("standard")} received · Send at least ${due(
        askedTotal("standard") - 5n * 10n ** 18n,
      )} more · Last checked 0s ago`,
    )
  })

  it("a claim that needs a hand puts Retry beside the pill, and the click retries it", async () => {
    await seedRecord({ broadcast: false })
    await render("/claim/taga")
    expect(blockButton("Retry")).toBeDefined()
    expect(pill()).not.toBeNull()
    h.runDetectionTick.mockImplementation(async () => {
      await getPendingStore().close(ACCOUNT, "confirmed")
      return "confirmed"
    })
    await act(async () => blockButton("Retry")!.click())
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })
})

describe("pending step — the check control is the only affordance", () => {
  const states: [string, Partial<PendingRegistrationRecord>][] = [
    ["custody held", { fundedAt: Date.now() }],
    ["awaiting its deposit", {}],
    ["never broadcast", { broadcast: false }],
    ["escalated", { fundedAt: Date.now(), retries: 3 }],
  ]
  it.each(states)("a record %s offers the check and no register button", async (_, over) => {
    await seedRecord(over)
    await render()
    expect(checkControl()).toBeTruthy()
    expect(buttons().some((b) => b.textContent?.startsWith("Register @"))).toBe(false)
  })

  it.each([
    ["custody held", { fundedAt: Date.now() }],
    ["swept before any funded stamp", { sweptAt: Date.now() }],
    ["funded", { phase: "funded" as const, fundedAt: Date.now() }],
  ])("a record %s says the deposit is in and never asks for it again", async (_, over) => {
    await seedRecord(over)
    await render()
    expect(container.textContent).toContain("Deposit received")
    expect(container.textContent).toContain("Your deposit is in")
    expect(container.textContent).not.toContain("Send at least")
    expect(container.querySelector('[aria-label^="Copy deposit address"]')).toBeNull()
  })
})

describe("pending step — urgency and wrong-chain states", () => {
  it("a record awaiting its deposit says what to do, and never ages into urgency", async () => {
    await seedRecord({ startTime: Date.now() - 60 * 60_000 })
    await render()
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
  it("custody completes the signup: identity first, then All set! and the wallet", async () => {
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

    // Identity saved BEFORE "All set!": closing the tab on it loses nothing.
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
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a custody completion whose identity save fails offers a retry that finishes the signup", async () => {
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    let refuse = true
    testWalletDbs().onApply = (_version, ops) => {
      if (refuse && ops.some(([key]) => key === "webwallet.identity")) throw new Error("disk")
    }
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(loadWalletIdentity()).toBeNull()
    expect(container.textContent).not.toContain("all-set")
    // The create step has no sheet button for it, so the error itself carries the retry.
    const reported = h.showReportableError.mock.calls.find(
      ([, context]) => context === "onboarding:identity",
    )
    const options = reported?.[2] as { retry?: { label: string; run: () => void } } | undefined
    const retry = options?.retry
    expect(retry?.label).toBe("Retry entering wallet")

    refuse = false
    await act(async () => retry!.run())
    expect(loadWalletIdentity()).toMatchObject({ handle: "taga", address: L2_ADDRESS })
    expect(container.textContent).toContain("all-set")
  })

  it("a name the chain already holds for this account owes the campaign its claim notice", async () => {
    const owed = () =>
      JSON.parse(walletStorage.getItem("obsidion.obsidion_campaign_claim_notices") ?? "{}")
    h.config.campaignUrl = "https://launch.test.invalid"
    const real = window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...real, assign: vi.fn(), href: real.href, origin: real.origin, pathname: "/claim" },
    })
    try {
      h.claimTag.mockResolvedValue({ kind: "custody", confirmed: false, oxideAccount: ACCOUNT })
      await render("/claim/taga")
      await click("landing-signin")
      await clickDeposit()
      // Custody without confirmation owes nothing: the detection tick owes it once the name lands.
      expect(owed()).toEqual({})
      act(() => root.unmount())
      root = createRoot(container)

      h.claimTag.mockResolvedValue({ kind: "custody", confirmed: true, oxideAccount: ACCOUNT })
      await render("/claim/taga")
      await click("landing-signin")
      await clickDeposit()
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
      expect(owed()).toEqual({
        [L2_ADDRESS]: {
          l2Address: L2_ADDRESS,
          tag: "taga",
          owedAt: expect.any(Number),
          attempts: 0,
        },
      })
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: real })
      h.config.campaignUrl = ""
    }
  })

  it("All set! asks for analytics consent before entering the wallet", async () => {
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
    expect(h.navigate).not.toHaveBeenCalled()
    const started = () => h.fireEvent.mock.calls.filter(([name]) => name === "onboarding_started")
    const startsBeforeAnswer = started().length
    await click("Share anonymous data")
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // The answer comes at the end: the exit is reported as the wallet entry, never as a start.
    expect(h.fireEvent).toHaveBeenCalledWith("wallet_entered", {
      has_claim_link: true,
      entry: "link",
    })
    expect(started()).toHaveLength(startsBeforeAnswer)
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("reports the start and the exit of a signup in a browser that answered before it", async () => {
    h.asked = true
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga")
    const started = h.fireEvent.mock.calls.filter(([name]) => name === "onboarding_started")
    expect(started).toEqual([["onboarding_started", { has_claim_link: true, entry: "link" }]])
    await click("landing-signin")
    await clickDeposit()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600))
    })
    expect(h.fireEvent.mock.calls.filter(([name]) => name === "wallet_entered")).toEqual([
      ["wallet_entered", { has_claim_link: true, entry: "link" }],
    ])
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    // The exit marks the account, so resuming this registration later is no new entry.
    expect(await firstWalletEntry(L2_ADDRESS)).toBe(false)
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

  it("a create refused after the passkey was written links the cleanup entry", async () => {
    const { UnsupportedProviderError, markPasskeyWritten } = await import("@obsidion/passkey-web")
    h.createAccount.mockRejectedValueOnce(
      markPasskeyWritten(new UnsupportedProviderError("manager")),
    )
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    const refused = container.querySelector<HTMLElement>('[data-testid="create-refused"]')
    expect(refused?.dataset.reason).toBe("UnsupportedProviderError")
    const link = refused?.querySelector<HTMLAnchorElement>('[data-testid="passkey-leftover"] a')
    expect(link?.getAttribute("href")).toBe("https://docs.zk.money/docs/passkeys#leftover-passkey")
  })

  it("a policy refusal on create shows the refusal in the modal with a retry", async () => {
    const { PhoneRequiredError } = await import("@obsidion/passkey-web")
    const refusal = new PhoneRequiredError({ providerName: "Windows Hello" })
    h.createAccount.mockRejectedValueOnce(refusal)
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    const refused = container.querySelector<HTMLElement>('[data-testid="create-refused"]')
    expect(refused?.dataset.reason).toBe("PhoneRequiredError")
    expect(container.textContent).toContain("Use your phone")
    expect(refused?.querySelector('[role="alert"]')?.textContent).toBe(refusal.message)
    expect(container.textContent).not.toContain("passkey prompt was closed")
    // Refused before any passkey was written: nothing to clean up.
    expect(refused?.querySelector('[data-testid="passkey-leftover"]')).toBeNull()
    expect(h.showReportableError).not.toHaveBeenCalled()
    // The card's retry is the only way to try again: the sheet's own button steps aside.
    expect(buttons().some((b) => b.textContent?.startsWith("Deposit"))).toBe(false)

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
    // The campaign's sign-up sheet, mirrored: what to do with the QR code, not the sign-in copy.
    expect(container.textContent).toContain("Scan QR code to save the key on your phone")
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

describe("signup in an app's built-in browser", () => {
  const UA = {
    android:
      "Mozilla/5.0 (Linux; Android 16; Pixel 9 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.0.0 Mobile Safari/537.36",
    // Chrome itself: a browser the in-app rule misses, so a request runs and can fail there.
    androidChrome:
      "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
    iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
    laptop:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  }
  const startUrl = window.location.href
  const unsupported = () =>
    new DOMException("Error connecting to Web Authentication service", "NotSupportedError")
  const closed = () => new DOMException("closed", "NotAllowedError")
  // jsdom's DOMException is not an Error, and the closed-prompt line is shown only for an Error.
  const closedError = () => Object.assign(new Error("closed"), { name: "NotAllowedError" })
  const refused = () => container.querySelector<HTMLElement>('[data-testid="create-refused"]')
  const cta = () => buttons().find((b) => b.textContent?.startsWith("Deposit"))
  const events = (name: string) =>
    h.fireEvent.mock.calls.filter(([event]) => event === name).map(([, props]) => props)

  const notice = () => container.querySelector<HTMLElement>('[data-testid="create-in-app-notice"]')
  const escape = () => container.querySelector<HTMLElement>('[data-testid="open-in-browser"]')

  let ua: { mockReturnValue: (value: string) => unknown; mockRestore: () => void } | undefined
  /** The sheet as a visitor in this user agent first sees it, before any tap on it. */
  const toSheet = async (userAgent: string, path = "/claim/taga") => {
    ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
    window.history.replaceState(null, "", path)
    await render(path)
    await click("landing-signin")
  }
  /** A signup at `path` in a browser with this user agent, up to its passkey request. */
  const toCreate = async (userAgent: string, path = "/claim/taga") => {
    await toSheet(userAgent, path)
    await clickDeposit()
  }
  /** A granted-tag link with the campaign configured, so Back has somewhere real to go. */
  const onGrantLink = async (run: (assign: ReturnType<typeof vi.fn>) => Promise<void>) => {
    sessionStorage.setItem("obsidion.name-grant", "grant-token")
    sessionStorage.setItem("obsidion.name-grant-handle", "taga")
    h.config.campaignUrl = "https://launch.test.invalid"
    const assign = vi.fn()
    const real = window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...real, assign, href: real.href, origin: real.origin, pathname: "/claim/taga" },
    })
    try {
      await run(assign)
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: real })
      h.config.campaignUrl = ""
    }
  }

  beforeEach(() => {
    // A visitor who has never made a passkey here: the card's case. The fixtures otherwise
    // record one by default, and every case that means an account is here says so.
    h.hasRootBreadcrumb = false
  })

  afterEach(() => {
    ua?.mockRestore()
    ua = undefined
    window.history.replaceState(null, "", startUrl)
  })

  it("in an iPhone app, the sheet opens on the card: no passkey button, no terms, a Back", async () => {
    await onGrantLink(async (assign) => {
      await toSheet(UA.iosX)
      expect(notice()?.textContent).toContain("Passkeys don't work in this app's browser")
      expect(cta()).toBeUndefined()
      expect(container.textContent).not.toContain("Deposit")
      // X's app drops the link: Copy link leads, the app's own menu follows.
      expect(container.querySelector('[data-testid="open-in-browser-link"]')).toBeNull()
      expect(escape()?.textContent).toContain("Copy link")
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(container.querySelector('[data-testid="create-in-app-back"]')).not.toBeNull()
      await click("Back")
      expect(assign).not.toHaveBeenCalled()
      expect(h.navigate).toHaveBeenCalledWith("/claim/taga", { replace: true })
    })
  })

  it("the card's report carries the user agent", async () => {
    await toSheet(UA.iosX)
    await act(async () =>
      notice()!.querySelector<HTMLElement>('[data-testid="passkey-report"]')!.click(),
    )
    expect(h.showReportableError).toHaveBeenCalledWith(
      expect.objectContaining({ message: UA.iosX }),
      "onboarding",
      { title: "In-app browser notice" },
    )
  })

  it("in an Android web view, the sheet opens on the card too: no terms, no button, no way to try", async () => {
    await toSheet(UA.android)
    expect(notice()?.textContent).toContain("Passkeys don't work in this app's browser")
    expect(cta()).toBeUndefined()
    expect(container.textContent).not.toContain("Deposit")
    expect(container.querySelector('[data-testid="open-in-browser-link"]')).not.toBeNull()
    expect(h.createAccount).not.toHaveBeenCalled()
  })

  it("a fresh visit gets the card whatever the address claims: a resume, or a hand-off with no material", async () => {
    await toSheet(UA.iosX, "/claim/taga?resume=1")
    expect(notice()).not.toBeNull()
    expect(cta()).toBeUndefined()

    act(() => root.unmount())
    root = createRoot(container)
    ua?.mockRestore()
    ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(UA.iosX)
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await settleHandoff()
    expect(notice()).not.toBeNull()
    expect(cta()).toBeUndefined()
  })

  it.each([
    ["a laptop", UA.laptop],
    [
      "iPhone Safari",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
    ],
  ])("%s opens on the terms and the button, with no card", async (_name, userAgent) => {
    await toSheet(userAgent)
    expect(notice()).toBeNull()
    expect(cta()).toBeDefined()
  })

  it("a silent hand-off still running keeps the setup spinner: no card, no button", async () => {
    // The bridge left material, so the silent attempt claims behind the spinner; the claim hangs.
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    let settle!: () => void
    h.claimTag.mockImplementation(
      (tag: string) =>
        new Promise<unknown>((resolve) => {
          settle = () => {
            void getPendingStore()
              .upsert(ACCOUNT, {}, baseRecord({ tag }))
              .then(() => resolve({ kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }))
          }
        }),
    )
    ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(UA.iosX)
    vi.useFakeTimers()
    try {
      await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_001)
      })
      expect(container.querySelector('[data-testid="handoff-entering"]')).not.toBeNull()
      expect(notice()).toBeNull()
      expect(cta()).toBeUndefined()
      expect(h.createAccount).not.toHaveBeenCalled()

      await act(async () => {
        settle()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it("a browser with a root passkey record and no wallet identity still gets the after-failure card on a closed iPhone sheet", async () => {
    h.hasRootBreadcrumb = true
    h.createAccount.mockRejectedValueOnce(closed())
    await toCreate(UA.iosX)
    expect(notice()).toBeNull()
    expect(refused()?.dataset.reason).toBe("InAppBrowser")
    expect(container.querySelector('[data-testid="create-retry"]')).toBeNull()
    expect(cta()).toBeUndefined()
    expect(container.querySelector('[data-testid="create-start-over"]')).not.toBeNull()
  })

  it("the credential the session was entered with exempts on its own", async () => {
    setActiveCredentialId("cred-held")
    await toSheet(UA.android)
    expect(notice()).toBeNull()
    expect(cta()).toBeDefined()
  })

  it("a create refused as not supported shows the card and Chrome, and the sheet's own button stays the retry", async () => {
    h.createAccount.mockRejectedValueOnce(unsupported())
    await toCreate(UA.androidChrome)
    expect(refused()?.dataset.reason).toBe("NotSupportedError")
    expect(container.textContent).toContain("open it in your phone's browser")
    expect(
      container.querySelector('[data-testid="open-in-browser-link"]')!.getAttribute("href"),
    ).toBe(
      `intent://${window.location.host}/claim/taga#Intent;scheme=http;package=com.android.chrome;end`,
    )
    expect(container.querySelector('[data-testid="create-retry"]')).toBeNull()
    expect(container.querySelector('[data-testid="create-start-over"]')).not.toBeNull()
    expect(container.textContent).not.toContain("Couldn't create your passkey")
    expect(cta()?.dataset.style).toBe("dark")
    expect(refused()?.querySelector('[data-testid="passkey-leftover"]')).toBeNull()
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(events("action_failed")).toEqual([{ action: "create_account", code: "err" }])

    h.fireEvent.mockClear()
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: false,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await clickDeposit()
    expect(h.createAccount).toHaveBeenCalledTimes(2)
    expect(events("registration_terms_accepted")).toHaveLength(1)
  })

  it("a not-supported failure after the passkey was written links the cleanup entry beside the way out", async () => {
    const { markPasskeyWritten } = await import("@obsidion/passkey-web")
    h.createAccount.mockRejectedValueOnce(markPasskeyWritten(unsupported()))
    await toCreate(UA.androidChrome)
    expect(refused()?.dataset.reason).toBe("NotSupportedError")
    expect(escape()).not.toBeNull()
    expect(
      refused()?.querySelector('[data-testid="passkey-leftover"] a')?.getAttribute("href"),
    ).toBe("https://docs.zk.money/docs/passkeys#leftover-passkey")
  })

  it("a reuse attempt's refusal on the create step gets no cleanup line: it wrote nothing", async () => {
    const { PhoneRequiredError } = await import("@obsidion/passkey-web")
    h.hasRootBreadcrumb = true
    saveWalletIdentity({ address: `0x${"aa".repeat(32)}`, claimedAt: 1 })
    h.reusePasskeyAccount.mockRejectedValueOnce(new PhoneRequiredError())
    await toSheet(UA.laptop)
    await clickDeposit()
    expect(h.reusePasskeyAccount).toHaveBeenCalledTimes(1)
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(refused()?.dataset.reason).toBe("PhoneRequiredError")
    expect(refused()?.querySelector('[data-testid="passkey-leftover"]')).toBeNull()
  })

  it("the same failure on a laptop has no way out, and the sheet's button keeps its usual look", async () => {
    h.createAccount.mockRejectedValueOnce(unsupported())
    await toCreate(UA.laptop)
    expect(refused()?.dataset.reason).toBe("NotSupportedError")
    expect(container.querySelector('[data-testid="open-in-browser"]')).toBeNull()
    expect(cta()?.dataset.style).toBe("gradient")
  })

  it("a closed prompt on a laptop keeps the closed-prompt line and button", async () => {
    h.createAccount.mockRejectedValueOnce(closedError())
    await toCreate(UA.laptop)
    expect(refused()).toBeNull()
    expect(container.textContent).toContain("The passkey prompt was closed before it finished")
    expect(container.textContent).toContain("Nothing was created.")
    expect(cta()).toBeDefined()
  })

  it("a closed follow-up prompt, after the passkey was written, gets the card with the cleanup link", async () => {
    const { markPasskeyWritten } = await import("@obsidion/passkey-web")
    h.createAccount.mockRejectedValueOnce(markPasskeyWritten(closedError()))
    await toCreate(UA.laptop)
    expect(refused()?.dataset.reason).toBe("NotAllowedError")
    expect(refused()?.querySelector("h2")?.textContent).toBe("The passkey prompt was closed")
    expect(refused()?.querySelector('[role="alert"]')?.textContent).toBe(
      "The passkey prompt was closed before it finished. Try again when you're ready.",
    )
    expect(
      refused()?.querySelector('[data-testid="passkey-leftover"] a')?.getAttribute("href"),
    ).toBe("https://docs.zk.money/docs/passkeys#leftover-passkey")
    expect(container.querySelector('[data-testid="create-retry"]')).not.toBeNull()
  })

  it("any other failure after the passkey was written gets the same card", async () => {
    const { markPasskeyWritten } = await import("@obsidion/passkey-web")
    h.createAccount.mockRejectedValueOnce(markPasskeyWritten(new Error("challenge fetch failed")))
    await toCreate(UA.laptop)
    expect(refused()?.dataset.reason).toBe("Error")
    expect(refused()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't create your passkey. challenge fetch failed. Try again.",
    )
    expect(refused()?.querySelector('[data-testid="passkey-leftover"]')).not.toBeNull()
  })

  it("a browser that already holds an account gets no card and keeps the create error: that account can't travel", async () => {
    h.hasRootBreadcrumb = true
    saveWalletIdentity({ handle: "alice", address: `0x${"aa".repeat(32)}`, claimedAt: 1 })
    h.createAccount.mockRejectedValueOnce(unsupported())
    await toSheet(UA.android)
    expect(notice()).toBeNull()
    await clickDeposit()
    expect(h.createAccount).toHaveBeenCalledTimes(1)
    expect(refused()).toBeNull()
    expect(container.textContent).toContain("Couldn't create your passkey")
  })

  it("a reuse of the key this session holds, with no account stored, gets no card and keeps the create error", async () => {
    // Recovering cached material needs the root record and the session's credential.
    h.hasRootBreadcrumb = true
    setActiveCredentialId("cred-held")
    h.getAuthService.mockReturnValue({
      recoverFromCache: async () => ({ credentialId: "cred-held", expectedAddress: L2_ADDRESS }),
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.reusePasskeyAccount.mockRejectedValueOnce(unsupported())
    await toSheet(UA.android)
    expect(notice()).toBeNull()
    await clickDeposit()
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(h.reusePasskeyAccount).toHaveBeenCalledTimes(1)
    expect(refused()).toBeNull()
    expect(container.querySelector('[data-testid="open-in-browser"]')).toBeNull()
    expect(container.textContent).toContain("Couldn't create your passkey")
  })

  it("a reuse of this browser's nameless account gets no card and keeps the create error and the way on", async () => {
    h.hasRootBreadcrumb = true
    saveWalletIdentity({ address: `0x${"aa".repeat(32)}`, claimedAt: 1 })
    h.reusePasskeyAccount.mockRejectedValueOnce(unsupported())
    await toSheet(UA.android)
    expect(notice()).toBeNull()
    await clickDeposit()
    expect(h.reusePasskeyAccount).toHaveBeenCalledTimes(1)
    expect(refused()).toBeNull()
    expect(container.querySelector('[data-testid="open-in-browser"]')).toBeNull()
    expect(container.textContent).toContain("Couldn't create your passkey")

    h.reusePasskeyAccount.mockRejectedValueOnce(closedError())
    ua!.mockReturnValue(UA.iosX)
    await clickDeposit()
    expect(refused()).toBeNull()
    expect(container.textContent).toContain("The passkey prompt was closed before it finished")
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

describe("buildRetrySignDeps — the rebuild's sign half", () => {
  // The install's credential id is read from the stored passkey record.
  const storedCredential = () =>
    vi.spyOn(AccountStorage, "get").mockReturnValue({
      getWebAuthnDataForCurrentAccount: async () => ({ credentialId: "cred-alice" }),
    } as never)
  afterEach(() => vi.restoreAllMocks())

  it("arms on any deployment (bootstrap-key gated), with the deriver wired", async () => {
    storedCredential()
    const deps = await realOxideOnboarding.buildRetrySignDeps(
      "alice",
      fakeKeys as never,
      h.config as never,
    )
    expect(typeof deps.deriveRegistrationSipa).toBe("function")
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
        claim: { ...CLAIM, terms: TERMS },
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
        claim: { ...CLAIM, terms: TERMS },
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

    // Confirmed short capacity holds the action and says so beside it, not "choose Sweep manually".
    h.processing.current = {
      reason: {
        kind: "capacity",
        availableAtomic: 0n,
        refill: { status: "unknown" },
        decimals: 18,
        observedAt: Date.now(),
      },
      blocker: { kind: "capacity", observedAt: Date.now(), zeroCapacity: true },
    }
    await click("Check again")
    expect(container.textContent).toContain(
      "Sweep manually finishes registration once network capacity is available.",
    )
    expect(container.textContent).not.toContain("Choose Sweep manually")
    expect(button("Sweep manually")?.disabled).toBe(true)
    expect(
      container.querySelector('[data-testid="deposit-pending-reason"]')?.textContent,
    ).toContain("Waiting for network capacity")
  })

  it("offers the earned-price restart after a sign-out cleared the admission receipt", async () => {
    await seedRecord({ fee: "10000000000000000000", broadcast: true, retries: 3 })
    const original = getPendingStore().current()!
    const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")
    const { recordDepositAdmission, hasDepositAdmission } = await import(
      "../src/features/identity/admission"
    )
    const { signOut } = await import("../src/features/identity/signOut")
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
    await signOut()
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
        claim: { ...CLAIM, terms: TERMS },
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
    let ledgerHeld: boolean | undefined
    h.claimTag.mockImplementation(async () => {
      // No broadcast of the old address may start while the replacement decides on the rail.
      ledgerHeld = userFlowActive()
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
        claim: { ...CLAIM, terms: TERMS },
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
    expect(ledgerHeld).toBe(true)
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

  it("owes nothing for an old-price address a payment link would fund, while it is to be replaced", async () => {
    resetBroadcastsForTests()
    await seedRecord({ fee: "10000000000000000000", broadcast: false, retries: 3 })
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
      paylinkFunded: true,
      paylinkId: "id:paylink-frag",
    })
    stashTicketSignup({
      fragment: "paylink-frag",
      threshold: (2n * 10n ** 18n).toString(),
      schedule: { fee: (10n ** 18n / 2n).toString(), minDeposit: "0" },
      amount: (20n * 10n ** 18n).toString(),
    })
    await render("/claim/taga?fee=waived")
    await settleReads()
    expect(button("Register at earned price")).toBeDefined()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(getBroadcastLedger().get(original.sipaAddress)).toBeNull()
  })

  it("stops a replacement whose old address has a broadcast still undecided, to be asked for again", async () => {
    resetBroadcastsForTests()
    await seedRecord({ fee: "10000000000000000000", broadcast: false, retries: 3 })
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
    // An earlier page sent the old address's broadcast; the chain has not decided it.
    await getBroadcastLedger().enqueue({
      address: original.sipaAddress,
      kind: "registration",
      scope: null,
      source: { type: "registration", account: ACCOUNT },
      txHash: `0x${"aa".repeat(32)}`,
    })
    await render("/claim/taga?fee=waived")
    await settleReads()
    vi.useFakeTimers()
    try {
      await act(async () => {
        button("Register at earned price")!.click()
        await vi.advanceTimersByTimeAsync(60_001)
      })
      expect(container.textContent).toContain("The original address is still being published")
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(userFlowActive()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
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
    // Never broadcast, yet shown: only a manual sweep registers it.
    expect(container.querySelector('[aria-label^="Copy deposit address"]')).not.toBeNull()
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
    // A claim carrying no schedule names no kind.
    expect(loadRegistrationTerms(ACCOUNT)?.feeWaived).toBeUndefined()
  })

  it("a waived reload totals the relay fee it signed and can enter now, deposit later", async () => {
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

  it("says the same, holding the name, where the schedule's fee sits under the relayer's sweep fee", async () => {
    // Nothing at the address could fund the sweep, so the deposit is never asked for.
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n ** 17n }
    await seedRecord()
    unsignedTerms()
    await render("/claim/taga")
    await settleReads()
    expect(paused()).toContain(REGISTRATIONS_PAUSED_NOTICE)
    expect(termsValue("total")).toBeUndefined()
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
      accountService: { signDomain: vi.fn(async () => nameClaim({ deadline: freshDeadline })) },
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
        signDomain: vi.fn(async () =>
          nameClaim({ deadline: freshDeadline, terms: earnedTerms({ deadline: freshDeadline }) }),
        ),
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

describe("the setup spinner applies what the hand-off decides", () => {
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

  it("a Cancel while the wallet still boots keeps the hand-off from starting once it boots", async () => {
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    const wallet = h.aztec.obsidionWallet
    h.aztec.obsidionWallet = undefined
    vi.useFakeTimers()
    try {
      await render(HANDOFF)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_001)
      })
      await act(async () => {
        button("Cancel")!.click()
        await vi.advanceTimersByTimeAsync(0)
      })
      h.aztec.obsidionWallet = wallet
      await render(HANDOFF)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(h.resolveHandoff).not.toHaveBeenCalled()
      expect(container.textContent).toContain("Get instant access")
    } finally {
      h.aztec.obsidionWallet = wallet
      vi.useRealTimers()
    }
  })

  it("offers Cancel on the spinner once the hold passes, which falls back to the terms sheet", async () => {
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    deferredClaim()
    vi.useFakeTimers()
    try {
      await render(HANDOFF)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(button("Cancel")).toBeUndefined()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_001)
      })
      expect(container.querySelector('[data-testid="handoff-entering"]')).not.toBeNull()
      await act(async () => {
        button("Cancel")!.click()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(container.querySelector('[data-testid="handoff-entering"]')).toBeNull()
      expect(container.textContent).toContain("Get instant access")
    } finally {
      vi.useRealTimers()
    }
  })

  it("waits out a slow claim on the spinner, with no sheet between it and the wallet", async () => {
    // The bridge left material, so the silent attempt runs the claim behind the spinner.
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    const claim = deferredClaim()
    vi.useFakeTimers()
    try {
      await render(HANDOFF)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(container.querySelector('[data-testid="handoff-entering"]')).not.toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(container.querySelector('[data-testid="handoff-entering"]')).not.toBeNull()
      expect(container.textContent).not.toContain("Get instant access")

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

  it("lands a hand-off that must deposit to enter on the deposit step, with its address", async () => {
    h.config.admissionGate = true
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n * 10n ** 18n }
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    const claim = deferredClaim()
    await render(HANDOFF)
    await act(async () => {
      claim().resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="handoff-entering"]')).toBeNull(),
    )
    expect(container.textContent).toContain("Send to")
    expect(container.textContent).toContain("0x000000...0000c3")
    expect(loadWalletIdentity()).toBeNull()
  })

  it("a hand-off that commits another account than this page loaded reloads before the claim", async () => {
    // This browser's stores loaded under an earlier account; the material names a new one.
    setActiveStorageId("account-a")
    await walletStorage.flush()
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    h.adoptHandoff.mockImplementationOnce(async () => {
      setActiveStorageId("account-b")
      await walletStorage.flush()
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

  it("a session-switch reload resumes in the setup spinner", async () => {
    h.takeOnboardingResume.mockReturnValueOnce(true)
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    const claim = deferredClaim()
    await render(HANDOFF)
    expect(container.querySelector('[data-testid="handoff-entering"]')).not.toBeNull()
    await act(async () => {
      claim().resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
    expect(h.navigate).toHaveBeenCalled()
  })

  it("a claim refused behind the spinner shows its error, not the terms sheet", async () => {
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    const claim = deferredClaim()
    await render(HANDOFF)
    await settleHandoff()
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

  it("a slow claim that is refused shows its error over the terms sheet", async () => {
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    const claim = deferredClaim()
    vi.useFakeTimers()
    try {
      await render(HANDOFF)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_001)
      })
      expect(container.querySelector('[data-testid="handoff-entering"]')).not.toBeNull()

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
})

describe("the setup spinner holds until there is something to enter on", () => {
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
    await settleHandoff()
    // The deposit address is good before the claim publishes, so nothing is gained by holding it.
    expect(h.navigate).toHaveBeenCalled()
  })

  it("waits for a wallet that is still booting, rather than asking for the tag again", async () => {
    h.aztec = { obsidionWallet: undefined }
    try {
      await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
      await settleHandoff()
      expect(h.resolveHandoff).not.toHaveBeenCalled()
      expect(container.querySelector('[data-testid="handoff-entering"]')).not.toBeNull()
      expect(container.textContent).not.toContain("Get instant access")
    } finally {
      h.aztec = { obsidionWallet: { wallet: true } }
    }
  })

  it("a claim still running holds the spinner, and never lands on a gate that bounces", async () => {
    let release!: () => void
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    h.claimTag.mockImplementation(async (tag: string) => {
      await new Promise<void>((r) => (release = r))
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await settleHandoff()

    // The claim has saved no identity yet. Entering here is what sent the user back to /claim, so
    // the wait holds — on a spinner, not on a step of the wizard.
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

  it("a name grant stays in the wallet, including after closing the terms sheet", async () => {
    sessionStorage.setItem("obsidion.name-grant", "grant-token")
    sessionStorage.setItem("obsidion.name-grant-handle", "taga")
    await withStubbedAssign(async (assign) => {
      await render("/claim/taga")
      await settleReads()
      expect(assign).not.toHaveBeenCalled()
      expect(h.routeGrantIsCurrent).toHaveBeenCalledWith("taga", "grant-token")
      expect(container.querySelector('[data-testid="invite-probe"]')?.textContent).toBe("true")

      await click("landing-signin")
      const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
      expect(close).not.toBeNull()
      await act(async () => close!.click())

      expect(assign).not.toHaveBeenCalled()
      expect(h.navigate).toHaveBeenCalledWith("/claim/taga", { replace: true })
    })
  })

  it("clears a revoked grant and sends the visitor back to the campaign", async () => {
    sessionStorage.setItem("obsidion.name-grant", "revoked-token")
    sessionStorage.setItem("obsidion.name-grant-handle", "taga")
    h.routeGrantIsCurrent.mockResolvedValue(false)
    await withStubbedAssign(async (assign) => {
      await render("/claim/taga")
      await settleReads()
      expect(h.routeGrantIsCurrent).toHaveBeenCalledWith("taga", "revoked-token")
      expect(sessionStorage.getItem("obsidion.name-grant")).toBeNull()
      expect(assign).toHaveBeenCalledWith("https://launch.test.invalid")
    })
  })

  it("keeps the grant when the validation request fails", async () => {
    sessionStorage.setItem("obsidion.name-grant", "grant-token")
    sessionStorage.setItem("obsidion.name-grant-handle", "taga")
    h.routeGrantIsCurrent.mockRejectedValue(new Error("offline"))
    await withStubbedAssign(async (assign) => {
      await render("/claim/taga")
      await settleReads()
      expect(assign).not.toHaveBeenCalled()
      expect(sessionStorage.getItem("obsidion.name-grant")).toBe("grant-token")
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
      expect(container.textContent).toContain("Get instant access")
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
  it("material in place enters the wallet with no tap", async () => {
    h.resolveHandoff.mockResolvedValue(fakeResolved)
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await settleHandoff()
    expect(h.resolveHandoff).toHaveBeenCalledTimes(1)
    expect(h.resolveHandoff.mock.calls[0][6]).toBe(true)
    expect(h.claimTag).toHaveBeenCalledTimes(1)
    expect(h.navigate).toHaveBeenCalled()
  })

  it("material that needs a prompt falls to the terms sheet, whose Deposit asks", async () => {
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await settleHandoff()
    expect(h.resolveHandoff).toHaveBeenCalledTimes(1)
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Get instant access")

    await clickDeposit()
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

  it.each([
    [
      "`choose=1` asks for any passkey, whatever else it names",
      "&choose=1",
      { discover: true, chooser: true },
    ],
    [
      "without `choose=1` the link's passkey is the one asked for",
      "",
      {
        credentialId: "bob-cred",
        pubkeyHex: "bb",
        expectedL2Address: undefined,
        policyVersion: undefined,
      },
    ],
  ])("a claim link: %s, on every attempt", async (_, choose, hints) => {
    await render(
      `/claim/newtag?entry=passkey&src=campaign&rp=localhost&cred=bob-cred&pk=bb${choose}`,
    )
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    await settleHandoff()
    await clickDeposit()
    // Once with no tap, refused; once on the tap.
    expect(h.resolveHandoff.mock.calls.map((call) => call[3])).toEqual([hints, hints])
  })

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
    await settleHandoff()
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

      await settleHandoff()
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

    await settleHandoff()
    await clickDeposit()
    expect(loadWalletIdentity()?.handle).not.toBe("someoneelse")
  })

  it("a hand-off that resolves to no wallet leaves the local session untouched", async () => {
    saveWalletIdentity({ handle: "someoneelse", address: L2_ADDRESS, claimedAt: 1 })
    await seedRecord({ tag: "oldtag" })
    await render("/claim/newtag?entry=passkey&rp=localhost&cred=c1&pk=ab")
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    h.resolveHandoff.mockRejectedValueOnce(new Error("No wallet was found for this passkey"))
    await settleHandoff()
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
    await settleHandoff()
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
    await settleHandoff()
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
    await settleHandoff()
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
    await render("/claim/taga?fee=waived&until=4102444800")
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
    /** The visitor page stashes the note's amount with every new ticket signup; `null` omits it. */
    const ticketStash = (
      over: { fragment?: string; amount?: bigint | null; threshold?: bigint } = {},
    ) =>
      stashTicketSignup({
        fragment: over.fragment ?? "paylink-frag",
        threshold: (over.threshold ?? 2n * ONE).toString(),
        schedule: { fee: (ONE / 2n).toString(), minDeposit: "0" },
        memo: "Pizza dinner",
        ...(over.amount !== null ? { amount: (over.amount ?? 20n * ONE).toString() } : {}),
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
    /** The welcome step: the card's welcome on a phone, the creation sheet on a laptop. */
    const expectWelcomeStep = () =>
      expect(
        container.textContent!.includes("Welcome taga!") ||
          container.querySelector('[data-testid="phone-steps"]') !== null,
      ).toBe(true)
    /** Tag step → welcome step → the ceremony's CTA. */
    const walkToPasskey = async () => {
      await render("/claim")
      if (container.querySelector('input[aria-label="Your tag"]')) {
        await typeTag("taga")
        await click("Claim tag")
        expectWelcomeStep()
      }
      expect(container.textContent).not.toContain("Deposit")
      await click(
        button("Continue with your passkey")
          ? "Continue with your passkey"
          : button("Show QR Code")
          ? "Show QR Code"
          : "Create account with passkey",
      )
    }
    const pendingClaim = (claim: unknown, recordOver: Partial<PendingRegistrationRecord> = {}) =>
      h.claimTag.mockImplementation(async (tag: string) => {
        await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag, ...recordOver }))
        return { kind: "pending", claim, oxideAccount: ACCOUNT }
      })

    it("shows the payment's split with the passkey: what the account costs and what is kept", async () => {
      ticketStash({ amount: 20n * ONE })
      const skim = h.skim
      h.skim = ONE / 2n
      try {
        await render("/claim")
        await typeTag("taga")
        await click("Claim tag")
        await settleReads()
        expectWelcomeStep()
        const split = (id: string) =>
          container.querySelector(`[data-testid="paylink-signup-${id}"]`)?.textContent
        expect(split("paylink")).toBe("20 DAI")
        expect(split("tag-price")).toBe("Waived")
        const kept = parseFloat(split("you-receive") ?? "")
        expect(kept).toBeGreaterThan(15)
        expect(kept).toBeLessThan(20)
        expect(container.textContent).not.toContain(DEPOSIT_TERMS_PENDING)
      } finally {
        h.skim = skim
      }
    })

    it("prices the split at the tip it commits, keeps that tip for the terms, and holds while it is quoted", async () => {
      ticketStash({ amount: 20n * ONE })
      const split = (id: string) =>
        container.querySelector(`[data-testid="paylink-signup-${id}"]`)?.textContent ?? ""
      try {
        splitTip.value = 0n
        await render("/claim")
        await typeTag("taga")
        await click("Claim tag")
        await settleReads()
        const kept = parseFloat(split("you-receive"))
        const fee = parseFloat(split("network-fee"))
        expect(JSON.parse(sessionStorage.getItem(TICKET_STASH_KEY)!).proverTip).toBe("0")

        splitTip.value = 10n ** 18n
        await render("/claim")
        expect(parseFloat(split("you-receive"))).toBeCloseTo(kept - 1)
        expect(parseFloat(split("network-fee"))).toBeCloseTo(fee + 1)
        expect(JSON.parse(sessionStorage.getItem(TICKET_STASH_KEY)!).proverTip).toBe(
          (10n ** 18n).toString(),
        )

        splitTip.value = undefined
        await render("/claim")
        expect(split("network-fee")).toBe(DEPOSIT_TERMS_PENDING)
      } finally {
        splitTip.value = 10n ** 18n
      }
    })

    describe("the threshold, before any passkey", () => {
      /** The CTA on either posture: a laptop's creation sheet, a phone's card. */
      const passkeyCta = () =>
        button("Show QR Code") ??
        button("Create account with passkey") ??
        button("Create another passkey")
      const walkToWelcome = async () => {
        await render("/claim")
        await typeTag("taga")
        await click("Claim tag")
        await settleReads()
        expectWelcomeStep()
      }
      const PHONE_UA =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

      it.each(["laptop", "phone"])(
        "a note below the threshold that covers the deposit opens no passkey (%s)",
        async (posture) => {
          const ua =
            posture === "phone"
              ? vi.spyOn(navigator, "userAgent", "get").mockReturnValue(PHONE_UA)
              : undefined
          try {
            // 4 covers the 2.61 burn at the 0.5 cut; the threshold asks for 5.
            ticketStash({ amount: 4n * ONE, threshold: 5n * ONE })
            pendingClaim(TICKET_CLAIM)
            await walkToWelcome()
            expect(container.querySelector('[data-testid="phone-steps"]') !== null).toBe(
              posture === "laptop",
            )
            expect(container.textContent).toContain(
              "This payment is below the 5 DAI minimum for a new account.",
            )
            expect(container.textContent).not.toContain("cannot cover the account deposit")
            expect(passkeyCta()?.disabled).toBe(true)
            await act(async () => passkeyCta()!.click())
            expect(h.createAccount).not.toHaveBeenCalled()
            expect(h.claimTag).not.toHaveBeenCalled()
            expect(loadTicketSignupAttempt("localhost", "id:paylink-frag")).toBeNull()
          } finally {
            ua?.mockRestore()
          }
        },
      )

      it("a note exactly at the threshold opens the passkey", async () => {
        ticketStash({ amount: 5n * ONE, threshold: 5n * ONE })
        pendingClaim(TICKET_CLAIM)
        await walkToWelcome()
        expect(container.textContent).not.toContain("minimum for a new account")
        expect(passkeyCta()?.disabled).toBe(false)
        await act(async () => passkeyCta()!.click())
        expect(h.createAccount).toHaveBeenCalledTimes(1)
        expect(h.claimTag).toHaveBeenCalledTimes(1)
      })

      it("an unread amount opens no passkey", async () => {
        ticketStash({ amount: null })
        await walkToWelcome()
        expect(container.textContent).toContain("Couldn't check this payment's amount")
        expect(passkeyCta()?.disabled).toBe(true)
        await act(async () => passkeyCta()!.click())
        expect(h.createAccount).not.toHaveBeenCalled()
      })

      it("a retry checks the threshold again instead of trusting the button it came from", async () => {
        // The first attempt is refused at the gate, before any attempt is saved, and the note
        // read since then no longer clears the threshold.
        const gate = vi.fn(async () => {
          updateTicketSignup({ amount: (4n * ONE).toString() })
          throw new ScreenPhoneRequiredError()
        })
        h.gateHook = () => ({ gate, state: { kind: "idle" }, cancel: () => {}, dismiss: () => {} })
        ticketStash({ amount: 20n * ONE, threshold: 5n * ONE })
        await walkToWelcome()
        await act(async () => passkeyCta()!.click())
        await settleReads()
        expect(gate).toHaveBeenCalledTimes(1)
        expect(container.querySelector('[data-testid="create-refused"]')).not.toBeNull()
        expect(container.textContent).toContain("below the 5 DAI minimum")
        expect(container.textContent).not.toContain("cannot cover the account deposit")
        await act(async () =>
          container.querySelector<HTMLButtonElement>('[data-testid="create-retry"]')!.click(),
        )
        expect(gate).toHaveBeenCalledTimes(1)
        expect(h.createAccount).not.toHaveBeenCalled()
        expect(loadTicketSignupAttempt("localhost", "id:paylink-frag")).toBeNull()
      })

      it("an interrupted attempt below the threshold is not restarted", async () => {
        ticketStash({ amount: 4n * ONE, threshold: 5n * ONE })
        const first = await beginTicketSignupAccount("localhost", "id:paylink-frag", "taga")
        await render("/claim")
        await settleReads()
        expect(button("Create another passkey")?.disabled).toBe(true)
        await click("Create another passkey")
        expect(loadTicketSignupAttempt("localhost", "id:paylink-frag")).toEqual(first)
        expect(h.createAccount).not.toHaveBeenCalled()
      })

      it("an account the ticket already bound resumes after the threshold rose past the note", async () => {
        ticketStash({ amount: 4n * ONE, threshold: 5n * ONE })
        saveTicketSignupAccount("localhost", "id:paylink-frag", {
          credentialId: "ticket-a",
          l2Address: L2_ADDRESS,
          tag: "taga",
        })
        pendingClaim(TICKET_CLAIM)
        await render("/claim")
        await settleReads()
        expect(container.textContent).not.toContain("minimum for a new account")
        expect(button("Continue with your passkey")?.disabled).toBe(false)
        await click("Continue with your passkey")
        expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
          h.aztec.obsidionWallet,
          L2_ADDRESS,
          { credentialId: "ticket-a" },
          expect.any(Function),
          expect.any(AbortSignal),
          expect.any(Function),
        )
        expect(h.createAccount).not.toHaveBeenCalled()
      })

      it("a registration the ticket already bought resumes after the threshold rose past the note", async () => {
        ticketStash({ amount: ONE, threshold: 5n * ONE })
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
        expect(container.textContent).toContain("@taga")
        expect(container.textContent).not.toContain("minimum for a new account")
        expect(h.createAccount).not.toHaveBeenCalled()
      })

      it("an ordinary signup ignores a below-threshold marker left in the tab", async () => {
        screenProps = {}
        ticketStash({ amount: ONE, threshold: 5n * ONE })
        await render("/claim/taga")
        await click("landing-signin")
        await settleReads()
        expect(container.textContent).not.toContain("minimum for a new account")
        await clickDeposit()
        expect(h.createAccount).toHaveBeenCalledTimes(1)
      })
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
      testWalletDbs().onApply = (_version, ops) => {
        if (ops.some(([key]) => key.startsWith("obsidion.ticket-signup.account:")))
          throw new DOMException("full", "QuotaExceededError")
      }
      await walkToPasskey()
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
    })

    it("a failed binding write preserves the incomplete attempt and requires an explicit restart", async () => {
      ticketStash()
      let refuse = true
      testWalletDbs().onApply = async (_version, ops) => {
        const binding = ops.some(
          ([key, value]) =>
            key.startsWith("obsidion.ticket-signup.account:") &&
            JSON.parse(value ?? "{}").credentialId,
        )
        if (refuse && binding) {
          // A real transaction fails after the flow has moved on, not within a microtask.
          await new Promise((resolve) => setTimeout(resolve, 20))
          throw new DOMException("full", "QuotaExceededError")
        }
      }
      await walkToPasskey()
      // Let the refused write settle.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
      refuse = false
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

    it("in a phone browser the in-app rule misses, a refused create points back to the payment link, and its retry restarts the attempt", async () => {
      const startUrl = window.location.href
      const ua = vi
        .spyOn(navigator, "userAgent", "get")
        .mockReturnValue(
          "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
        )
      window.history.replaceState(null, "", "/link#paylink-frag")
      try {
        h.hasRootBreadcrumb = false
        ticketStash()
        h.createAccount.mockRejectedValueOnce(
          new DOMException("Error connecting to Web Authentication service", "NotSupportedError"),
        )
        await render("/claim")
        await typeTag("taga")
        await click("Claim tag")
        expect(container.querySelector('[data-testid="create-in-app-notice"]')).toBeNull()
        await click("Create account with passkey")
        const card = container.querySelector<HTMLElement>('[data-testid="create-refused"]')
        expect(card?.dataset.reason).toBe("NotSupportedError")
        const escape = container.querySelector<HTMLElement>('[data-testid="open-in-browser"]')
        expect(escape?.dataset.escape).toBe("hint")
        expect(container.querySelector('[data-testid="open-in-browser-link"]')).toBeNull()
        expect(container.innerHTML).not.toContain("paylink-frag")
        expect(container.textContent).toContain("No ticket was redeemed")
        expect(container.querySelector('[data-testid="create-retry"]')).toBeNull()
        expect(button("Create another passkey")?.dataset.style).toBe("dark")

        pendingClaim(TICKET_CLAIM)
        await click("Create another passkey")
        expect(h.createAccount).toHaveBeenCalledTimes(2)
        expect(h.claimTag).toHaveBeenCalledTimes(1)
      } finally {
        ua.mockRestore()
        window.history.replaceState(null, "", startUrl)
      }
    })

    it("in an iPhone app's browser with a root record here, the closed prompt shows the card alone, with nothing to create", async () => {
      const startUrl = window.location.href
      const ua = vi
        .spyOn(navigator, "userAgent", "get")
        .mockReturnValue(
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
        )
      window.history.replaceState(null, "", "/link#paylink-frag")
      try {
        ticketStash()
        h.createAccount.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
        await walkToPasskey()
        const card = container.querySelector<HTMLElement>('[data-testid="create-refused"]')
        expect(card?.dataset.reason).toBe("InAppBrowser")
        expect(container.textContent).not.toContain("Creating another passkey")
        expect(button("Create another passkey")).toBeUndefined()
        expect(h.claimTag).not.toHaveBeenCalled()
      } finally {
        ua.mockRestore()
        window.history.replaceState(null, "", startUrl)
      }
    })

    it("in an iPhone app's browser, the sheet shows the card alone before any request, with nothing to create", async () => {
      const startUrl = window.location.href
      const ua = vi
        .spyOn(navigator, "userAgent", "get")
        .mockReturnValue(
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
        )
      window.history.replaceState(null, "", "/link#paylink-frag")
      try {
        h.hasRootBreadcrumb = false
        ticketStash()
        await render("/claim")
        await typeTag("taga")
        await click("Claim tag")
        await settleReads()
        expect(container.querySelector('[data-testid="create-in-app-notice"]')).not.toBeNull()
        // The payment lives in the address's fragment, which no link can carry: the app's menu.
        const escape = container.querySelector<HTMLElement>('[data-testid="open-in-browser"]')
        expect(escape?.dataset.escape).toBe("hint")
        expect(container.querySelector('[data-testid="open-in-browser-link"]')).toBeNull()
        expect(container.textContent).not.toContain("Welcome taga!")
        expect(container.textContent).not.toContain("Pizza dinner")
        expect(button("Create account with passkey")).toBeUndefined()
        expect(h.createAccount).not.toHaveBeenCalled()
        expect(h.claimTag).not.toHaveBeenCalled()
      } finally {
        ua.mockRestore()
        window.history.replaceState(null, "", startUrl)
      }
    })

    it("an interrupted creation cannot silently create again on reopening", async () => {
      ticketStash()
      await beginTicketSignupAccount("localhost", "id:paylink-frag", "taga")
      await render("/claim")
      await settleReads()
      expect(container.textContent).toContain("No ticket was redeemed")
      expect(button("Create another passkey")).toBeTruthy()
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
    })

    it("a stale tab cannot restart an attempt another tab already restarted", async () => {
      ticketStash()
      const first = await beginTicketSignupAccount("localhost", "id:paylink-frag", "taga")
      await render("/claim")
      await settleReads()
      expect(button("Create another passkey")).toBeTruthy()
      // Another tab restarts the same attempt and opens its own ceremony.
      restartTicketSignupAccount("localhost", "id:paylink-frag", first.attemptId)
      const second = await beginTicketSignupAccount("localhost", "id:paylink-frag", "taga")
      await click("Create another passkey")
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(loadTicketSignupAttempt("localhost", "id:paylink-frag")).toEqual(second)
      expect(container.textContent).toContain("restarted in another tab")
      expect(button("Create another passkey")).toBeTruthy()
      // The other tab's ceremony completes and binds the account this link continues with.
      await completeTicketSignupAccount("localhost", "id:paylink-frag", second.attemptId, {
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
      await walletStorage.flush()
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
      await walletStorage.flush()
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
        await walletStorage.flush()
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

    it("a ticket signup refused for its route names what answered, then restarts with another passkey", async () => {
      ticketStash({ amount: 20n * ONE })
      const refusal = new ScreenPhoneRequiredError({ providerName: "Bitwarden" })
      h.createAccount.mockRejectedValueOnce(refusal)
      await walkToPasskey()
      const refused = container.querySelector<HTMLElement>('[data-testid="create-refused"]')
      expect(refused?.querySelector('[role="alert"]')?.textContent).toBe(refusal.message)
      pendingClaim(TICKET_CLAIM)
      await click("Create another passkey")
      expect(h.createAccount).toHaveBeenCalledTimes(2)
    })

    /** The route a gate call was handed by the screen's own sheet. */
    const pickOf = (options: unknown) => (options as { unheld?: SignInRoute } | undefined)?.unheld
    /** A gate that resolves on the route the sheet picked, as the real one does where a phone is reachable. */
    const pickingGate = () =>
      vi.fn(async (options?: unknown) => ({
        signal: new AbortController().signal,
        reach: "unknown" as const,
        route: pickOf(options),
      }))

    it.each([
      ["Show QR Code", "phone"],
      ["Have a security key? Use it instead", "security-key"],
    ] as const)("the ticket sheet's %s creates the account on its route", async (label, route) => {
      ticketStash({ amount: 20n * ONE })
      h.getAuthService.mockReturnValue({ recoverFromCache: async () => undefined })
      pendingClaim(TICKET_CLAIM)
      const gate = pickingGate()
      h.gateHook = () => ({ gate, state: { kind: "idle" }, cancel: () => {}, dismiss: () => {} })
      await render("/claim")
      await typeTag("taga")
      await click("Claim tag")
      await settleReads()
      await click(label)
      if (route === "security-key") {
        // The link only swaps the sheet to its key variant; that variant's button creates.
        expect(gate).not.toHaveBeenCalled()
        await click("Create account with my security key")
      }
      expect(gate.mock.calls[0]?.[0]).toMatchObject({ purpose: "create", unheld: route })
      expect(h.createAccount.mock.calls[0]?.[5]).toMatchObject({ route })
    })

    it("the ticket sheet holds both routes until the browser says whether it reaches a phone", async () => {
      ticketStash({ amount: 20n * ONE })
      let answer!: (reach: string) => void
      h.getAuthService.mockReturnValue({
        recoverFromCache: async () => undefined,
        probePhoneReach: () => new Promise((resolve) => (answer = resolve)),
      })
      await render("/claim")
      await typeTag("taga")
      await click("Claim tag")
      await settleReads()
      const phone = () =>
        container.querySelector<HTMLButtonElement>('[data-testid="phone-steps-continue"]')!
      const key = () =>
        container.querySelector<HTMLButtonElement>('[data-testid="phone-steps-security-key"]')
      expect(phone().disabled).toBe(true)
      expect(key()?.disabled).toBe(true)
      // A laptop reads the loss line on the sheet itself, never as a second notice above it.
      expect(container.querySelector('[data-testid="passkey-loss-notice"]')).toBeNull()
      // A browser that reaches no phone is offered its key alone, never a phone it cannot use.
      await act(async () => answer("no-hybrid"))
      expect(phone().disabled).toBe(false)
      expect(phone().textContent).toBe("Create account with my security key")
      expect(key()).toBeNull()
      expect(h.createAccount).not.toHaveBeenCalled()
    })

    it("a phone's own card warns of loss, then starts the creation with no pick of its own", async () => {
      const ua = vi
        .spyOn(navigator, "userAgent", "get")
        .mockReturnValue(
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1",
        )
      try {
        ticketStash({ amount: 20n * ONE })
        h.getAuthService.mockReturnValue({ recoverFromCache: async () => undefined })
        pendingClaim(TICKET_CLAIM)
        const gate = pickingGate()
        h.gateHook = () => ({ gate, state: { kind: "idle" }, cancel: () => {}, dismiss: () => {} })
        await render("/claim")
        await typeTag("taga")
        await click("Claim tag")
        await settleReads()
        expectWelcomeStep()
        // A phone has no sheet, so the loss line sits with its button, before any tap.
        expect(container.querySelectorAll('[data-testid="passkey-loss-notice"]')).toHaveLength(1)
        expect(container.querySelector('[data-testid="phone-steps"]')).toBeNull()
        expect(h.createAccount).not.toHaveBeenCalled()
        await click("Create account with passkey")
        expect(pickOf(gate.mock.calls[0]?.[0])).toBeUndefined()
      } finally {
        ua.mockRestore()
      }
    })

    it("a laptop retry after a key pick holds the sheet again instead of reusing the pick", async () => {
      ticketStash({ amount: 20n * ONE })
      h.getAuthService.mockReturnValue({ recoverFromCache: async () => undefined })
      h.createAccount.mockRejectedValueOnce(new ScreenPhoneRequiredError({ ceremony: "create" }))
      const signal = new AbortController().signal
      let proceedHeld!: (route?: SignInRoute) => void
      type Opened = { signal: AbortSignal; reach: "unknown"; route?: SignInRoute }
      const gate = vi.fn(
        (options?: unknown): Promise<Opened> =>
          gate.mock.calls.length === 1
            ? Promise.resolve({ signal, reach: "unknown", route: pickOf(options) })
            : new Promise((resolve) => {
                proceedHeld = (route) => resolve({ signal, reach: "unknown", route })
              }),
      )
      h.gateHook = () => ({
        gate,
        state:
          gate.mock.calls.length > 1
            ? {
                kind: "awaiting-action",
                prompt: "phone-steps",
                reach: "ok",
                proceed: (route?: SignInRoute) => proceedHeld(route),
              }
            : { kind: "idle" },
        cancel: () => {},
        dismiss: () => {},
      })
      await render("/claim")
      await typeTag("taga")
      await click("Claim tag")
      await settleReads()
      await click("Have a security key? Use it instead")
      await click("Create account with my security key")
      await settleReads()
      expect(gate.mock.calls[0]?.[0]).toMatchObject({ purpose: "create", unheld: "security-key" })
      expect(container.querySelector('[data-testid="create-refused"]')).not.toBeNull()
      // The refused attempt stays saved, so the way on is a restart: the sheet asks again.
      pendingClaim(TICKET_CLAIM)
      await click("Create another passkey")
      await settleReads()
      expect(gate.mock.calls[1]?.[0]).toMatchObject({ purpose: "create" })
      expect(pickOf(gate.mock.calls[1]?.[0])).toBeUndefined()
      expect(container.querySelector('[data-testid="phone-steps"]')).not.toBeNull()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      await click("Show QR Code")
      await settleReads()
      expect(h.createAccount.mock.calls[1]?.[5]).toMatchObject({ route: "phone" })
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
      walletStorage.setItem("obsidion.ticket-signup.account:localhost:id:paylink-frag", "broken")
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
      const PAID_CLAIM = nameClaim({
        terms: earnedTerms({
          fee: "4900000000000000000",
          minDeposit: "9500000000000000000",
          reduced: false,
        }),
      })
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
      expect(container.textContent).toContain("all-set")
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
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

    it("holds the claim of a bound link while the address is unpublished, and owes its broadcast", async () => {
      resetBroadcastsForTests()
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
      // The claim it holds needs the address published, so the step owes its broadcast.
      await vi.waitFor(() =>
        expect(getBroadcastLedger().get(getPendingStore().current()!.sipaAddress)).toMatchObject({
          kind: "registration",
        }),
      )
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

    it("claims from the pending step on the working beat, and enters once it is sent", async () => {
      screenProps = {}
      // No burn left in the store by an earlier case: this one's claim is ready.
      ;(WithdrawalStorage as unknown as { instance: unknown }).instance = null
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
      const controller = new AbortController()
      h.gateHook = () => ({
        gate: async () => ({ signal: controller.signal, reach: "unknown" as const }),
        state: { kind: "idle" },
        cancel: () => controller.abort(),
        dismiss: () => {},
      })
      const settle = {} as { resolve: (hash: string) => void }
      h.claimSponsoredLink.mockImplementation(async () => {
        await getOperationStore().begin({
          operationId: "pending-claim-op",
          flow: "paylink-claim",
          summary: "$20",
          scope: null,
        })
        return new Promise<string>((resolve) => Object.assign(settle, { resolve }))
      })
      await render("/claim")
      await settleReads()
      await click("Claim your payment")
      await settleReads()
      expect(h.claimSponsoredLink).toHaveBeenCalledOnce()
      expect(container.textContent).toContain("Keep this tab open")
      expect(loadWalletIdentity()).toBeNull()

      // The proof runs in this page: the beat holds until it is sent.
      await act(async () => {
        provingProgress.emitStageStart("proving", "pending-claim-op")
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(container.textContent).toContain("Proving privately")
      expect(loadWalletIdentity()).toBeNull()

      await act(async () => {
        provingProgress.emitTxHashSaved("pending-claim-op", `0x${"cd".repeat(32)}`)
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(loadWalletIdentity()).toMatchObject({ handle: "taga" })
      expect(container.textContent).not.toContain("Keep this tab open")
      expect(isClaimRunning("paylink-frag")).toBe(true)

      await act(async () => settle.resolve("0xclaim"))
      expect(isClaimRunning("paylink-frag")).toBe(false)
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBeNull()
      getOperationStore().release("pending-claim-op")
      await getOperationStore().remove("pending-claim-op")
    })

    it("a status check on the pending step is no claim: the Claim stays, held, with no working beat", async () => {
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
      let tick!: () => void
      h.runDetectionTick.mockImplementation(
        () => new Promise<string>((resolve) => (tick = () => resolve("pending"))),
      )
      await render("/claim")
      await settleReads()
      await click("Check again")
      expect(button("Claim your payment")?.disabled).toBe(true)
      expect(container.textContent).not.toContain("Keep this tab open")
      await act(async () => tick())
      await settleReads()
      expect(button("Claim your payment")?.disabled).toBe(false)
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
      const signDomain = vi.fn(async (_req: unknown) =>
        nameClaim({
          deadline: String(deadline),
          terms: earnedTerms({
            fee: quote.fee.toString(),
            minDeposit: quote.minDeposit.toString(),
            reduced: quote.reduced,
            ticket: quote.reduced,
          }),
        }),
      )
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

    it("enters the wallet as soon as the name is reserved, and leaves the link's claim to Home", async () => {
      ticketStash({ amount: 20n * ONE })
      pendingClaim(TICKET_CLAIM)
      await walkToPasskey()
      expect(container.textContent).toContain("all-set")
      expect(container.textContent).not.toContain("Someone sent you")
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(loadWalletIdentity()).toMatchObject({
        handle: "taga",
        address: L2_ADDRESS,
        pending: true,
      })
      // The tip the split showed before the passkey is the one the terms carry to the claim.
      expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
        proverTip: (10n ** 18n).toString(),
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

      // The link stays stashed for Home's claim; nothing here spends it.
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
      expect(sessionStorage.getItem(TICKET_STASH_KEY)).not.toBeNull()
      expect(isClaimRunning("paylink-frag")).toBe(false)
    })

    it("enters before the SIPA broadcast lands: Home waits for the address, not the wizard", async () => {
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
      expect(container.textContent).toContain("all-set")
      expect(container.textContent).not.toContain("Publishing your deposit address")
      expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()

      await act(async () => release(true))
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
    })

    it("a failed SIPA broadcast leaves the wallet entered and the link stashed, with no claim", async () => {
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
      await settleReads()
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
      expect(container.textContent).not.toContain("Deposit 0")
      expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
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
      const resetStore = () => {
        ;(WithdrawalStorage as unknown as { instance: unknown }).instance = null
      }
      beforeEach(resetStore)
      afterEach(resetStore)
      const renderVisitor = (link = LINK) =>
        act(async () => {
          root.render(
            <MemoryRouter initialEntries={["/link"]}>
              <PaylinkVisitorScreen link={link} onRetryStatus={vi.fn()} />
            </MemoryRouter>,
          )
        })
      const clickContaining = (label: string) =>
        act(async () => {
          const target = buttons().find((b) => b.textContent?.includes(label))
          if (!target) throw new Error(`no button containing "${label}"`)
          target.click()
        })
      /** Account → tag → welcome → passkey: the wizard enters, and Home owns the link's claim. */
      it("enters the wallet as soon as the name is reserved, and never claims the link itself", async () => {
        pendingClaim(TICKET_CLAIM)
        await renderVisitor()
        await clickContaining("Receive to zk.money")
        expect(container.textContent).toContain("Choose your")
        await typeTag("taga")
        await click("Claim tag")
        await click(button("Show QR Code") ? "Show QR Code" : "Create account with passkey")
        await settleReads()
        expect(container.textContent).toContain("all-set")
        expect(container.textContent).not.toContain("Keep this tab open")
        expect(h.claimSponsoredLink).not.toHaveBeenCalled()
        expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
        // No burn of the wizard's own: the batch is Home's to send.
        expect(store().list()).toHaveLength(0)
        expect(isClaimRunning("paylink-frag")).toBe(false)
        expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
        expect(sessionStorage.getItem(TICKET_STASH_KEY)).not.toBeNull()
      })

      it("a link one wei below the threshold keeps the account option shut", async () => {
        await renderVisitor({ ...(LINK as object), amount: "1.999999999999999999" } as never)
        const account = buttons().find((b) => b.textContent?.includes("Receive to zk.money"))!
        expect(account.disabled).toBe(true)
        expect(account.textContent).toContain(
          "This payment is below the $2 minimum for a new account.",
        )
        await clickContaining("Receive to zk.money")
        expect(container.textContent).not.toContain("Choose your")
        expect(sessionStorage.getItem(TICKET_STASH_KEY)).toBeNull()
        expect(h.createAccount).not.toHaveBeenCalled()
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

  it("a campaign hand-off with no material opens on the terms sheet and asserts the existing passkey in one step", async () => {
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await settleHandoff()
    expect(container.textContent).toContain("@taga.zk.money")
    expect(container.textContent).toContain("Get instant access")
    // Only the attempt with no tap so far, and it found no material.
    expect(h.resolveHandoff).toHaveBeenCalledTimes(1)
    expect(h.claimTag).not.toHaveBeenCalled()

    await clickDeposit()
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

    // "All set!", then the wallet. The deposit the reservation still owes is the activation
    // sheet's to ask for, on Home — never a step of the wizard.
    expect(container.textContent).toContain("all-set")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600))
    })
    expect(h.navigate).toHaveBeenCalled()
    expect(container.textContent).not.toContain("@taga is reserved for you")
  })

  it("a hand-off leaves the wallet holding a pending name, which is what raises the activation sheet", async () => {
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    await render("/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12")
    await settleHandoff()
    await clickDeposit()

    // The two conditions `openRegistration` reads on Home. Without the pending flag the
    // activation sheet never opens and the deposit is never asked for.
    expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
    expect(getPendingStore().current()).toMatchObject({ tag: "taga", phase: "awaiting_deposit" })
  })

  it("the hand-off's I'll do this later reserves the name and defers only the deposit", async () => {
    // The deployment's own earned schedule, which a claim signing none falls back to.
    h.amounts = { min: 44n * 10n ** 17n, fee: 5n * 10n ** 17n }
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: CLAIM, oxideAccount: ACCOUNT }
    })
    await render("/claim/taga?entry=passkey&rp=localhost&fee=waived&cred=cred-1&pk=ab12")
    await settleHandoff()
    expect(container.textContent).toContain("@taga.zk.money")
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

describe("the loss line on an ordinary sign-up", () => {
  const PHONE_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1"
  const notices = () => container.querySelectorAll('[data-testid="passkey-loss-notice"]').length

  it("a phone reads it on the terms sheet before Deposit, which then starts the creation", async () => {
    const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(PHONE_UA)
    try {
      await render("/claim/taga")
      await click("landing-signin")
      expect(notices()).toBe(1)
      expect(container.textContent).toContain("Lose your passkey, lose the wallet.")
      expect(h.createAccount).not.toHaveBeenCalled()
      await clickDeposit()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
    } finally {
      ua.mockRestore()
    }
  })

  it("a laptop has no notice on the terms sheet: its creation sheet carries the line", async () => {
    await render("/claim/taga")
    await click("landing-signin")
    expect(buttons().some((b) => b.textContent?.startsWith("Deposit"))).toBe(true)
    expect(notices()).toBe(0)
  })
})
