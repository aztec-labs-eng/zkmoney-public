/**
 * The signup wizard's passkey attempts over the real ceremony gate: a create cancelled mid-request
 * stays the user's cancel even when the next attempt finishes first, and each way out of the
 * wizard marks the attempt it ends before the gate goes.
 */
import { PendingRegistrationStore } from "@obsidion/front-core"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OnboardingScreen } from "../src/features/onboarding/OnboardingScreen"
import { scopeOfStatus } from "../src/platform/auth/passkeyAttemptScope"
import { getPendingStore } from "../src/features/onboarding/webRegistration"
import { __resetPasskeyTelemetryForTests } from "../src/lib/passkeyTelemetry"
import {
  type HeldRequest,
  pageHide,
  passkeyEvents,
  passkeyTelemetryHarness,
} from "./support/passkeyTelemetryHarness"

vi.setConfig({ testTimeout: 30_000 })

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const L2_ADDRESS = `0x${"cd".repeat(32)}`

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  fireEvent: vi.fn(),
  getClaimStatus: vi.fn(),
  claimTag: vi.fn(),
  createAccount: vi.fn(),
  collectOnboardingKeys: vi.fn(),
  resolveHandoff: vi.fn(),
  adoptHandoff: vi.fn(),
  probePhoneReach: vi.fn(),
}))

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => h.navigate,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAccountContext: () => ({ createAccount: h.createAccount, setObsidionAccount: vi.fn() }),
  useAztecContext: () => ({ obsidionWallet: { wallet: true } }),
  useContractServiceContext: () => ({ contractService: { service: true } }),
  useConfigValue: () => ({ value: true, setValue: vi.fn() }),
}))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({
    network: "testnet",
    l1ChainId: 11155111,
    l1RpcUrl: "http://127.0.0.1:8545",
    rpId: "localhost",
    rpName: "zk.money",
    l1Chain: { name: "Sepolia" },
  }),
}))
vi.mock("../src/lib/analytics", () => ({
  fireEvent: h.fireEvent,
  lapTimer: () => () => 0,
  failureCode: () => "err",
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// A saved identity only counts as onboarded beside this browser's root-passkey breadcrumb.
vi.mock("../src/platform/auth/WebPasskeyIdentityMap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform/auth/WebPasskeyIdentityMap")>()),
  hasMskRootBreadcrumb: () => true,
}))
vi.mock("../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => ({ account: null, walletName: null, connect: vi.fn() }),
  getL1Clients: vi.fn(),
}))
vi.mock("../src/ui/screening", () => ({
  ScreeningNotice: () => null,
  useScreenedAddress: () => ({ verdict: null, cleared: true, rescreen: vi.fn() }),
}))
vi.mock("../src/platform/auth/useAuthenticator", () => {
  const auth = () => ({
    probePhoneReach: h.probePhoneReach,
    useLaptopRoute: () => {},
    recoverFromCache: async () => undefined,
    clear: () => {},
    lockOut: () => {},
  })
  return { getAuthService: auth, peekAuthService: auth }
})
// The DS drags in liquid-glass optics jsdom can't render; these tests are about wiring.
vi.mock("@obsidion/web-ds", () => ({
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
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label}
      {value}
    </div>
  ),
  GradientSpinner: () => <span>spinner</span>,
  Icon: () => null,
  NumberedStepRow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Spinner: () => null,
  TopNavIconButton: ({ onClick, ariaLabel }: { onClick?: () => void; ariaLabel?: string }) => (
    <button aria-label={ariaLabel} onClick={onClick}>
      x
    </button>
  ),
}))
vi.mock("../src/features/onboarding/AnalyticsConsentModal", () => ({
  AnalyticsConsentModal: () => null,
}))
vi.mock("../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
// The invitation page stays behind the sheets, so its button can start a claim while one runs.
vi.mock("../src/features/onboarding/steps/InvitationStep", () => ({
  InvitationStep: ({ onUnlock }: { onUnlock: (handle: string) => void }) => (
    <button onClick={() => onUnlock("taga")}>landing-signin</button>
  ),
}))
vi.mock("../src/features/onboarding/steps/ClaimTagModal", () => ({
  ClaimTagModal: ({ onClose }: { onClose: () => void }) => (
    <div>
      claim-modal
      <button onClick={onClose}>close-claim</button>
    </div>
  ),
  AllSetModal: () => <div>all-set</div>,
}))
// The real carousel spends the first "Next →" on the hand-off's prompt and ends on "Let's go!".
vi.mock("../src/features/onboarding/steps/OnboardingCarousel", () => ({
  OnboardingCarousel: ({ onDone, onStart }: { onDone: () => void; onStart?: () => void }) => (
    <>
      {onStart && (
        <button data-testid="carousel-next" onClick={onStart}>
          Next
        </button>
      )}
      <button onClick={onDone}>Let's go!</button>
    </>
  ),
}))
vi.mock("../src/features/onboarding/oxideOnboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/oxideOnboarding")>()),
  getClaimStatus: h.getClaimStatus,
  claimTag: h.claimTag,
  collectOnboardingKeys: h.collectOnboardingKeys,
  resolveHandoff: h.resolveHandoff,
  adoptHandoff: h.adoptHandoff,
}))
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ registry: "0x00000000000000000000000000000000000000e4" }),
  l1PublicClient: () => ({ readContract: async () => 0n }),
}))

const fakeAccount = { getAddress: () => ({ toString: () => L2_ADDRESS }) }
const fakeKeys = {
  account: fakeAccount,
  secretKey: { toString: () => `0x${"11".repeat(32)}` },
  authProvider: {},
  pubkeyHex: `0x${"22".repeat(64)}`,
}
const CUSTODY = {
  kind: "custody",
  confirmed: false,
  oxideAccount: ACCOUNT,
  claim: { signature: "0x", nonce: "1", deadline: "4102444800" },
}

let container: HTMLDivElement
let root: Root
let harness: Awaited<ReturnType<typeof passkeyTelemetryHarness>>

const events = () => passkeyEvents(h.fireEvent)
const buttons = () => Array.from(container.querySelectorAll("button"))
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
const press = async (find: () => HTMLElement | undefined | null) => {
  await act(async () => find()!.click())
  await flush()
}
const pressLabel = (label: string) => press(() => buttons().find((b) => b.textContent === label))
const deposit = () => press(() => buttons().find((b) => b.textContent?.startsWith("Deposit")))
const continueAtSteps = () => press(() => byTestId("phone-steps-continue"))
/** The intro's first tap, which is what a hand-off's prompt rides on. */
const startHandoff = () => press(() => byTestId("carousel-next"))
const leaveIntro = () => pressLabel("Let's go!")

const HANDOFF = "/claim/taga?entry=passkey&rp=localhost&cred=cred-1&pk=ab12"
const RESOLVED = { recovered: {}, msk: fakeKeys.secretKey, slot: "first" }
/** Inside the window where this browser calls another device's answer the laptop's own. */
const MAC_SAFARI_18_6 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.6 Safari/605.1.15"

async function render(path = "/claim/taga") {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/claim/:handle?" element={<OnboardingScreen />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await flush()
}

/** The next create asks the browser once through the tracker and waits for the test. */
function heldCreate() {
  const held: { request?: HeldRequest } = {}
  h.createAccount.mockImplementationOnce(async () => {
    held.request = harness.request("create")
    await held.request.settled
    return fakeAccount
  })
  return held
}

/** From the landing, through the terms and the phone steps, to a create waiting on its request. */
async function toCreateRequest() {
  const held = heldCreate()
  await pressLabel("landing-signin")
  await deposit()
  await continueAtSteps()
  expect(held.request).toBeDefined()
  return held.request!
}

beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
  await getPendingStore().load()
  // A fresh page load's tracker: attempt numbers and once-per-page events start over.
  __resetPasskeyTelemetryForTests()
  harness = await passkeyTelemetryHarness()
  h.getClaimStatus.mockResolvedValue("reserved")
  h.collectOnboardingKeys.mockResolvedValue(fakeKeys)
  h.claimTag.mockResolvedValue(CUSTODY)
  h.probePhoneReach.mockResolvedValue("unknown")
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await render()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  // An attempt a test left open ends with its page, before the next test counts anything.
  pageHide()
})

describe("signup create step — passkey telemetry", () => {
  it("a create cancelled mid-request stays the user's cancel when the next create finishes first", async () => {
    const first = await toCreateRequest()
    await pressLabel("Cancel")

    const second = heldCreate()
    await deposit()
    await continueAtSteps()
    await act(async () => second.request!.answer())
    await flush()
    expect(container.textContent).toContain("all-set")

    await act(async () => first.reject(new DOMException("closed", "NotAllowedError")))
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "create",
        flow: "onboarding",
        outcome: "succeeded",
        credential_created: "yes",
        attempt: "2",
      }),
      expect.objectContaining({
        ceremony: "create",
        outcome: "cancelled",
        reason: "in_app_cancel",
        credential_created: "no",
        attempt: "1",
      }),
    ])
  })

  it("Cancel during the create's request, then leaving at once, sends one cancel", async () => {
    await toCreateRequest()
    act(() => {
      buttons()
        .find((b) => b.textContent === "Cancel")!
        .click()
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({ outcome: "cancelled", reason: "in_app_cancel", prompts: "1" }),
    ])
  })

  it("closing the claim modal says nothing for the create a second attempt replaced", async () => {
    const earlier = heldCreate()
    await pressLabel("landing-signin")
    await deposit()
    await continueAtSteps()
    expect(earlier.request).toBeDefined()
    // The landing behind the sheet starts the terms again; this create finishes and its claim fails.
    await pressLabel("landing-signin")
    h.claimTag.mockRejectedValueOnce(new Error("down"))
    const later = heldCreate()
    await deposit()
    await continueAtSteps()
    await act(async () => later.request!.answer())
    await flush()
    expect(container.textContent).toContain("claim-modal")
    h.fireEvent.mockClear()

    act(() => {
      buttons()
        .find((b) => b.textContent === "close-claim")!
        .click()
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([])
  })

  it("keeps a cancelled create's chained assertion out of the retry that replaced it", async () => {
    let chain!: () => void
    const chained = new Promise<void>((resolve) => (chain = resolve))
    // A creation whose provider answers no key material, so the driver asks a second time — here
    // only once the retry has begun.
    h.createAccount.mockImplementationOnce(
      async (_import: boolean, _type: unknown, status: (value: string) => void) => {
        const own = scopeOfStatus(status)
        await harness.answered("create", own)
        await chained
        await harness.answered("assert", own)
        return fakeAccount
      },
    )
    await pressLabel("landing-signin")
    await deposit()
    await continueAtSteps()
    await pressLabel("Cancel")

    // The retry holds at its phone steps and asks the browser for nothing.
    await pressLabel("landing-signin")
    await deposit()
    expect(byTestId("phone-steps")).not.toBeNull()
    chain()
    await flush()

    // Both prompts are the cancelled creation's, which the browser answered in the end.
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "create",
        flow: "onboarding",
        outcome: "succeeded",
        credential_created: "yes",
        prompts: "2+",
        attempt: "1",
      }),
    ])
  })

  it("closing the terms sheet while an earlier create still waits on its request is the user's cancel", async () => {
    await toCreateRequest()
    // The landing behind the sheet opens the terms again over the waiting create.
    await pressLabel("landing-signin")
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "create",
        outcome: "cancelled",
        reason: "in_app_cancel",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("leaving while the gate probes, or at its phone steps, sends nothing", async () => {
    h.probePhoneReach.mockImplementationOnce(() => new Promise(() => {}))
    await pressLabel("landing-signin")
    await deposit()
    expect(byTestId("phone-steps")).toBeNull()
    await act(async () => root.unmount())

    root = createRoot(container)
    await render()
    await pressLabel("landing-signin")
    await deposit()
    expect(byTestId("phone-steps")).not.toBeNull()
    await act(async () => root.unmount())
    root = createRoot(container)
    act(() => pageHide())
    await flush()
    expect(events()).toEqual([])
  })

  it("a second create at the gate replaces the first quietly, and the user's cancel still lands", async () => {
    await pressLabel("landing-signin")
    await deposit()
    expect(byTestId("phone-steps")).not.toBeNull()
    // The landing behind the sheet starts a second create; its gate ends the first one's wait.
    await pressLabel("landing-signin")
    await deposit()
    expect(byTestId("phone-steps")).not.toBeNull()
    expect(events()).toEqual([])

    act(() => {
      byTestId("phone-steps-cancel")!.click()
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "create",
        outcome: "cancelled",
        reason: "in_app_cancel",
        prompts: "0",
      }),
    ])
  })

  it("Cancel at the phone steps, then leaving at once, sends one in-app cancel that asked nothing", async () => {
    await pressLabel("landing-signin")
    await deposit()
    act(() => {
      byTestId("phone-steps-cancel")!.click()
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "create",
        outcome: "cancelled",
        reason: "in_app_cancel",
        prompts: "0",
      }),
    ])
  })
})

/**
 * The campaign hand-off as it ships: a silent attempt on mount, the intro's first tap spending a
 * prompt when the bridge material was not enough, and the terms sheet as the fallback that can ask
 * again. A run that asks nothing reports nothing — a prompt-free success is no ceremony.
 */
describe("signup hand-off — passkey telemetry", () => {
  /** A fresh page for a hand-off URL, since the silent attempt fires on mount. */
  const openHandoff = async () => {
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(HANDOFF)
  }
  /** The next hand-off asks the browser once and settles it. */
  const handoffAsks = (settle: () => unknown = () => RESOLVED) =>
    h.resolveHandoff.mockImplementationOnce(async (...args: unknown[]) => {
      await harness.answered("assert", args[7] as never)
      return settle()
    })
  const silentRefuses = async () => {
    const { CeremonyRequiredError } = await import("../src/features/onboarding/oxideOnboarding")
    h.resolveHandoff.mockRejectedValueOnce(new CeremonyRequiredError())
  }

  beforeEach(() => {
    h.adoptHandoff.mockResolvedValue(fakeKeys)
  })

  it("the silent attempt takes the bridge material without asking, and reports nothing", async () => {
    h.resolveHandoff.mockResolvedValueOnce(RESOLVED)
    await openHandoff()
    expect(h.resolveHandoff).toHaveBeenCalledTimes(1)
    // Silent: the call itself refuses rather than prompting.
    expect(h.resolveHandoff.mock.calls[0][6]).toBe(true)
    expect(h.claimTag).toHaveBeenCalledTimes(1)
    expect(events()).toEqual([])
  })

  it("a silent attempt that needs a prompt reports nothing: nothing was asked", async () => {
    await silentRefuses()
    await openHandoff()
    expect(h.resolveHandoff).toHaveBeenCalledTimes(1)
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(events()).toEqual([])
  })

  it("the intro's first tap spends the hand-off's one prompt and reports it", async () => {
    await silentRefuses()
    await openHandoff()
    handoffAsks()
    await startHandoff()
    expect(h.resolveHandoff).toHaveBeenCalledTimes(2)
    expect(h.resolveHandoff.mock.calls[1][6]).toBeFalsy()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "handoff",
        outcome: "succeeded",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("entering the wallet on a claim the silent attempt won sends no passkey event at all", async () => {
    h.resolveHandoff.mockResolvedValueOnce(RESOLVED)
    await openHandoff()
    await leaveIntro()
    // The identity the claim saved is what the wallet's gate reads: the intro ends inside it.
    expect(h.navigate).toHaveBeenCalled()
    expect(events()).toEqual([])
  })

  it("the terms sheet is the fallback, and its Deposit is a second hand-off attempt", async () => {
    await silentRefuses()
    await openHandoff()
    // The intro ends with no account, so the sheet that can ask again takes over.
    await leaveIntro()
    handoffAsks()
    await deposit()
    expect(h.resolveHandoff).toHaveBeenCalledTimes(2)
    expect(events()).toEqual([
      expect.objectContaining({ ceremony: "sign_in", flow: "handoff", outcome: "succeeded" }),
    ])
  })

  it("a prompt the user closes is reported as the browser's close, once", async () => {
    await silentRefuses()
    await openHandoff()
    handoffAsks(() => {
      throw new DOMException("closed", "NotAllowedError")
    })
    await startHandoff()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "handoff",
        outcome: "cancelled",
        reason: "prompt_closed",
        prompts: "1",
      }),
    ])
  })

  it("Cancel at the hand-off's sheet is the user's cancel, and asked nothing", async () => {
    await silentRefuses()
    await openHandoff()
    h.resolveHandoff.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[4] as () => Promise<unknown>)()
      return RESOLVED
    })
    await startHandoff()
    expect(byTestId("sign-in-cancel")).not.toBeNull()
    act(() => {
      byTestId("sign-in-cancel")!.click()
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "handoff",
        outcome: "cancelled",
        reason: "in_app_cancel",
        prompts: "0",
      }),
    ])
  })

  /**
   * The route correction lives in the tracker, so it has to reach the events this screen sends:
   * the wallet's own tracker reads the live browser, not an injected environment.
   */
  it("reports a laptop answer this browser mislabels as the phone that gave it", async () => {
    const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_SAFARI_18_6)
    try {
      // The tracker reads the browser once, when it is built.
      __resetPasskeyTelemetryForTests()
      harness = await passkeyTelemetryHarness()
      await silentRefuses()
      await openHandoff()
      handoffAsks()
      await startHandoff()
      expect(events()).toEqual([
        expect.objectContaining({
          ceremony: "sign_in",
          flow: "handoff",
          outcome: "succeeded",
          prompts: "1",
          // The answer says `platform`; inside the window that is the phone, not this laptop.
          route: "phone_qr",
          device_class: "laptop",
          browser: "safari",
        }),
      ])
    } finally {
      ua.mockRestore()
    }
  })

  it("leaving the intro while the tap's hand-off is still asking sends nothing", async () => {
    await silentRefuses()
    await openHandoff()
    const held: { request?: HeldRequest } = {}
    h.resolveHandoff.mockImplementationOnce(async (...args: unknown[]) => {
      held.request = harness.request("assert", undefined, args[7] as never)
      await held.request.settled
      return RESOLVED
    })
    await startHandoff()
    expect(held.request).toBeDefined()
    act(() => {
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([])
  })
})
