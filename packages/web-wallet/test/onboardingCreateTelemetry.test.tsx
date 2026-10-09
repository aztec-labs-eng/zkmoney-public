/**
 * The signup wizard's passkey attempts over the real ceremony gate: a create cancelled mid-request
 * stays the user's cancel even when the next attempt finishes first, and each way out of the
 * wizard marks the attempt it ends before the gate goes.
 */
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
import { nameClaim, resetRegistrationStores } from "./support/registrationFixtures"

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
  setObsidionAccount: vi.fn(),
  reportHandoffAdopted: vi.fn(),
  hasRootBreadcrumb: true,
}))

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => h.navigate,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAccountContext: () => ({
    createAccount: h.createAccount,
    setObsidionAccount: h.setObsidionAccount,
  }),
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
vi.mock("../src/lib/handoffHealth", () => ({ reportHandoffAdopted: h.reportHandoffAdopted }))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// A saved identity only counts as onboarded beside this browser's root-passkey breadcrumb, and an
// app's browser is told before any request only where there is none.
vi.mock("../src/platform/auth/WebPasskeyIdentityMap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform/auth/WebPasskeyIdentityMap")>()),
  hasMskRootBreadcrumb: () => h.hasRootBreadcrumb,
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
  claim: nameClaim(),
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
  resetRegistrationStores()
  await getPendingStore().load()
  // A fresh page load's tracker: attempt numbers and once-per-page events start over.
  __resetPasskeyTelemetryForTests()
  harness = await passkeyTelemetryHarness()
  h.getClaimStatus.mockResolvedValue("reserved")
  h.collectOnboardingKeys.mockResolvedValue(fakeKeys)
  h.claimTag.mockResolvedValue(CUSTODY)
  h.probePhoneReach.mockResolvedValue("unknown")
  h.hasRootBreadcrumb = true
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

  it("Cancel during the create's request ends the signal that request runs under", async () => {
    let signal: AbortSignal | undefined
    h.createAccount.mockImplementationOnce(async (...args: unknown[]) => {
      signal = (args[5] as { signal?: AbortSignal }).signal
      await harness.request("create").settled
      return fakeAccount
    })
    await pressLabel("landing-signin")
    await deposit()
    await continueAtSteps()
    expect(signal?.aborted).toBe(false)
    await pressLabel("Cancel")
    expect(signal?.aborted).toBe(true)
  })

  it("leaving while the create's request is open reports no failed create, whatever it then throws", async () => {
    // Not the abort itself: a browser that answers anyway can fail in its own way.
    h.createAccount.mockImplementationOnce(
      (...args: unknown[]) =>
        new Promise((_, reject) => {
          const { signal } = args[5] as { signal: AbortSignal }
          signal.addEventListener("abort", () => reject(new Error("unreadable answer")))
        }),
    )
    await pressLabel("landing-signin")
    await deposit()
    await continueAtSteps()
    await act(async () => root.unmount())
    root = createRoot(container)
    await flush()
    expect(h.fireEvent.mock.calls.filter(([e]) => e === "action_failed")).toEqual([])
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
    // The gate hands the phone check back only once a route is picked.
    expect(events()[0]).not.toHaveProperty("phone_reach")
  })

  it("a laptop create past the phone steps carries the phone check", async () => {
    h.probePhoneReach.mockResolvedValue("ok")
    const held = await toCreateRequest()
    await act(async () => held.answer())
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({ ceremony: "create", outcome: "succeeded", phone_reach: "ok" }),
    ])
  })

  it("a laptop create the browser closed carries what the check could not tell", async () => {
    const held = await toCreateRequest()
    await act(async () => held.reject(new DOMException("closed", "NotAllowedError")))
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({ reason: "prompt_closed", phone_reach: "unknown" }),
    ])
  })
})

/**
 * The campaign hand-off as it ships: a silent attempt on mount, and the terms sheet's Deposit
 * spending a prompt when the bridge material was not enough. A run that asks nothing reports
 * nothing — a prompt-free success is no ceremony.
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

  it("the terms sheet's Deposit spends the hand-off's one prompt and reports it", async () => {
    await silentRefuses()
    await openHandoff()
    handoffAsks()
    await deposit()
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
    // The identity the claim saved is what the wallet's gate reads: the spinner enters on it.
    expect(h.navigate).toHaveBeenCalled()
    expect(events()).toEqual([])
  })

  it("a prompt the user closes is reported as the browser's close, once", async () => {
    await silentRefuses()
    await openHandoff()
    handoffAsks(() => {
      throw new DOMException("closed", "NotAllowedError")
    })
    await deposit()
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
    await deposit()
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
      await deposit()
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

  it("leaving while the hand-off's prompt is still asking sends nothing", async () => {
    await silentRefuses()
    await openHandoff()
    const held: { request?: HeldRequest } = {}
    h.resolveHandoff.mockImplementationOnce(async (...args: unknown[]) => {
      held.request = harness.request("assert", undefined, args[7] as never)
      await held.request.settled
      return RESOLVED
    })
    await deposit()
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

describe("signup hand-off — health report", () => {
  const CAMPAIGN_HANDOFF = `${HANDOFF}&src=campaign`
  const resolvedFrom = (keySource: string) => ({ ...RESOLVED, keySource })
  const open = async (path = CAMPAIGN_HANDOFF) => {
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(path)
  }

  beforeEach(() => {
    h.adoptHandoff.mockResolvedValue(fakeKeys)
  })

  it("reports the key source of a campaign hand-off's adoption, once", async () => {
    h.resolveHandoff.mockResolvedValueOnce(resolvedFrom("handoff"))
    await open()
    expect(h.reportHandoffAdopted.mock.calls).toEqual([["handoff"]])
  })

  it("reports nothing for a passkey link the campaign did not send", async () => {
    h.resolveHandoff.mockResolvedValueOnce(resolvedFrom("handoff"))
    await open(HANDOFF)
    expect(h.adoptHandoff).toHaveBeenCalledTimes(1)
    expect(h.reportHandoffAdopted).not.toHaveBeenCalled()
  })

  it("reports nothing for a silent run that needs a prompt, then once for the Deposit's ceremony", async () => {
    const { CeremonyRequiredError } = await import("../src/features/onboarding/oxideOnboarding")
    h.resolveHandoff.mockRejectedValueOnce(new CeremonyRequiredError())
    await open()
    expect(h.reportHandoffAdopted).not.toHaveBeenCalled()
    h.resolveHandoff.mockResolvedValueOnce(resolvedFrom("ceremony"))
    await deposit()
    expect(h.reportHandoffAdopted.mock.calls).toEqual([["ceremony"]])
  })

  it("an adoption that lands after its screen left still adopts, and reports nothing", async () => {
    h.resolveHandoff.mockResolvedValueOnce(resolvedFrom("handoff"))
    let land!: (keys: typeof fakeKeys) => void
    h.adoptHandoff.mockImplementationOnce(
      () => new Promise<typeof fakeKeys>((resolve) => (land = resolve)),
    )
    await open()
    expect(h.adoptHandoff).toHaveBeenCalledTimes(1)
    // The op goes stale while the adoption is past its point of no return.
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => land(fakeKeys))
    await flush()
    expect(h.setObsidionAccount).toHaveBeenCalledWith(fakeKeys.account)
    expect(h.reportHandoffAdopted).not.toHaveBeenCalled()
  })

  it("reports nothing for the op StrictMode's repeated effects ended, however it lands", async () => {
    h.resolveHandoff.mockResolvedValue(resolvedFrom("cache"))
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => {
      root.render(
        <React.StrictMode>
          <MemoryRouter initialEntries={[CAMPAIGN_HANDOFF]}>
            <Routes>
              <Route path="/claim/:handle?" element={<OnboardingScreen />} />
            </Routes>
          </MemoryRouter>
        </React.StrictMode>,
      )
    })
    await flush()
    // The simulated unmount runs the screen's cleanup, which ends the silent op's scope; its
    // adoption still lands, but for an op that is no longer the screen's.
    expect(h.adoptHandoff).toHaveBeenCalledTimes(1)
    expect(h.reportHandoffAdopted).not.toHaveBeenCalled()
  })
})

/** A reminder-email hand-off opened inside an app: its passkey fails, the card follows it. */
describe("signup hand-off in an app's built-in browser", () => {
  const REMINDER = "/claim/taga?entry=passkey&rp=localhost&choose=1"
  const UA = {
    android:
      "Mozilla/5.0 (Linux; Android 16; Pixel 9 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.0.0 Mobile Safari/537.36",
    iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
    iosInstagram:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 370.0.0.0.0 (iPhone15,2; iOS 18_5; en_US; en; scale=3.00; 1179x2556; 000000000)",
  }
  const startUrl = window.location.href
  let ua: { mockRestore: () => void } | undefined
  const refused = () => byTestId("create-refused")
  const failures = () =>
    h.fireEvent.mock.calls.filter(([event]) => event === "action_failed").map(([, props]) => props)

  type Gate = (options: { anchor: boolean }) => Promise<{ signal: AbortSignal }>
  /**
   * The silent attempt finds no material; the Deposit's attempt waits at the gate's sheet, then asks
   * `asks` times, each request held for the test.
   */
  const handoffAsks = (asks = 1) => {
    const requests: HeldRequest[] = []
    h.resolveHandoff.mockImplementation(async (...args: unknown[]) => {
      const { CeremonyRequiredError } = await import("../src/features/onboarding/oxideOnboarding")
      if (args[6]) throw new CeremonyRequiredError()
      const { signal } = await (args[4] as Gate)({ anchor: true })
      for (let i = 0; i < asks; i++) {
        const request = harness.request("assert", signal, args[7] as never)
        requests.push(request)
        await request.settled
      }
      return RESOLVED
    })
    return requests
  }
  const open = async (userAgent: string, strict = false) => {
    ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
    window.history.replaceState(null, "", REMINDER)
    await act(async () => root.unmount())
    root = createRoot(container)
    const tree = (
      <MemoryRouter initialEntries={[REMINDER]}>
        <Routes>
          <Route path="/claim/:handle?" element={<OnboardingScreen />} />
        </Routes>
      </MemoryRouter>
    )
    await act(async () => root.render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree))
    await flush()
  }
  /** The terms sheet's Deposit, then Continue on the gate's sheet: the request is now in the browser. */
  const tapThroughSheet = async () => {
    await deposit()
    expect(byTestId("sign-in-continue")).not.toBeNull()
    await press(() => byTestId("sign-in-continue"))
  }

  beforeEach(() => {
    h.adoptHandoff.mockResolvedValue(fakeKeys)
  })
  afterEach(() => {
    ua?.mockRestore()
    ua = undefined
    window.history.replaceState(null, "", startUrl)
    h.resolveHandoff.mockReset()
  })

  it("with no passkey record here, an iPhone app's browser is told before any request, and nothing is reported", async () => {
    h.hasRootBreadcrumb = false
    const requests = handoffAsks()
    await open(UA.iosInstagram, true)
    // The silent attempt found no material; the sheet now shows the card, not the terms.
    expect(byTestId("create-in-app-notice")).not.toBeNull()
    expect(byTestId("open-in-browser-link")!.getAttribute("href")).toBe(
      `x-safari-http://${window.location.host}${REMINDER}`,
    )
    expect(buttons().some((b) => b.textContent?.startsWith("Deposit"))).toBe(false)
    expect(requests).toHaveLength(0)
    expect(failures()).toEqual([])
    expect(events()).toEqual([])
  })

  // The cases below hold a root passkey record: a passkey worked here once, so the sheet asks,
  // and the card follows the failure.
  it.each([false, true])(
    "an iPhone app browser's instant close lands on the card, not the terms (strict: %s)",
    async (strict) => {
      const requests = handoffAsks()
      await open(UA.iosInstagram, strict)
      await tapThroughSheet()
      await act(async () => requests.at(-1)!.reject(new DOMException("closed", "NotAllowedError")))
      await flush()
      expect(refused()?.dataset.reason).toBe("InAppBrowser")
      expect(byTestId("open-in-browser-link")!.getAttribute("href")).toBe(
        `x-safari-http://${window.location.host}${REMINDER}`,
      )
      expect(byTestId("create-start-over")).not.toBeNull()
      expect(buttons().some((b) => b.textContent?.startsWith("Deposit"))).toBe(false)
      expect(failures()).toEqual([{ action: "enter_passkey", code: "err" }])
      expect(events()).toEqual([
        expect.objectContaining({ flow: "handoff", outcome: "cancelled", reason: "prompt_closed" }),
      ])
    },
  )

  it("a not-supported second approval lands on the card with its retry on the sheet", async () => {
    const requests = handoffAsks(2)
    await open(UA.android)
    await tapThroughSheet()
    await act(async () => requests[0]!.answer())
    await flush()
    await act(async () =>
      requests[1]!.reject(
        new DOMException("Error connecting to Web Authentication service", "NotSupportedError"),
      ),
    )
    await flush()
    expect(refused()?.dataset.reason).toBe("NotSupportedError")
    expect(byTestId("open-in-browser-link")!.getAttribute("href")).toContain("intent://")
    expect(buttons().some((b) => b.textContent?.startsWith("Deposit"))).toBe(true)
    expect(events()).toEqual([
      expect.objectContaining({ flow: "handoff", outcome: "failed", reason: "not_supported" }),
    ])

    // The sheet's button runs the hand-off again, never a create, and lands on the same card.
    const calls = h.resolveHandoff.mock.calls.length
    h.fireEvent.mockClear()
    await deposit()
    expect(byTestId("sign-in-continue")).not.toBeNull()
    await press(() => byTestId("sign-in-continue"))
    expect(h.resolveHandoff).toHaveBeenCalledTimes(calls + 1)
    await act(async () => requests.at(-1)!.reject(new DOMException("again", "NotSupportedError")))
    await flush()
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(refused()?.dataset.reason).toBe("NotSupportedError")
    expect(
      h.fireEvent.mock.calls.filter(([e]) => e === "registration_terms_accepted"),
    ).toHaveLength(1)
    expect(failures()).toEqual([{ action: "enter_passkey", code: "err" }])
  })
})

describe("signup create in an app's built-in browser", () => {
  it("a create Cancel ended shows nothing when it then fails as not supported", async () => {
    const ua = vi
      .spyOn(navigator, "userAgent", "get")
      .mockReturnValue(
        "Mozilla/5.0 (Linux; Android 16; Pixel 9 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.0.0 Mobile Safari/537.36",
      )
    try {
      const held = heldCreate()
      await pressLabel("landing-signin")
      // A phone has no steps to pass: Deposit asks the browser.
      await deposit()
      expect(held.request).toBeDefined()
      await pressLabel("Cancel")
      await act(async () => held.request!.reject(new DOMException("late", "NotSupportedError")))
      await flush()
      expect(byTestId("create-refused")).toBeNull()
      expect(h.fireEvent.mock.calls.filter(([e]) => e === "action_failed")).toEqual([])
    } finally {
      ua.mockRestore()
    }
  })
})

/** Saving endpoints reloads the page, so the pill waits out "Unlock access" wherever it renders. */
describe("the endpoints hold", () => {
  const renderEmbedded = async () => {
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/claim/taga"]}>
          <Routes>
            <Route path="/claim/:handle?" element={<OnboardingScreen embedded />} />
          </Routes>
        </MemoryRouter>,
      )
    })
    await flush()
  }

  it.each([false, true])(
    "holds while Unlock access reads the claim status (embedded: %s)",
    async (embedded) => {
      if (embedded) await renderEmbedded()
      const { endpointsHeld } = await import("../src/ui/endpointsHold")
      let settle!: (status: string) => void
      h.getClaimStatus.mockImplementationOnce(() => new Promise((resolve) => (settle = resolve)))
      expect(endpointsHeld()).toBe(false)
      await pressLabel("landing-signin")
      expect(endpointsHeld()).toBe(true)
      await act(async () => settle("claimed"))
      await flush()
      expect(endpointsHeld()).toBe(false)
    },
  )
})
