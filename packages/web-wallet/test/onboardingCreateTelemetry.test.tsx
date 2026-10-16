/**
 * The signup wizard's passkey attempts over the real ceremony gate: a create cancelled mid-request
 * stays the user's cancel even when the next attempt finishes first, and each way out of the
 * wizard marks the attempt it ends before the gate goes.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { APPLE_ICLOUD_AAGUID, GPM_AAGUID, ONEPASSWORD_AAGUID } from "@obsidion/core/constants"
import {
  CHROME_REFUSAL_COPY,
  SAFARI_REFUSAL_COPY,
  EXTENSION_ADVICE_COPY,
  LaptopPasskeyRefusedError,
  NoPrfError,
  PHONE_STEPS_COPY,
  PhoneRequiredError,
  UnsupportedProviderError,
  markPasskeyWritten,
  type LaptopCreation,
} from "@obsidion/passkey-web"
import { OnboardingScreen } from "../src/features/onboarding/OnboardingScreen"
import { LOCAL_REFUSAL_LIMIT, noteLocalRefusal } from "../src/platform/auth/localRefusals"
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
  probePhoneReach: vi.fn(),
  probeLaptopCreation: vi.fn(),
  useLaptopCreation: vi.fn(),
  setObsidionAccount: vi.fn(),
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
  fireOnboardingEvent: h.fireEvent,
  lapTimer: () => () => 0,
  failureCode: () => "err",
}))
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
    probeLaptopCreation: h.probeLaptopCreation,
    useLaptopCreation: h.useLaptopCreation,
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
  TopNavIconButton: ({
    onClick,
    ariaLabel,
    testId,
    disabled,
  }: {
    onClick?: () => void
    ariaLabel?: string
    testId?: string
    disabled?: boolean
  }) => (
    <button aria-label={ariaLabel} data-testid={testId} disabled={disabled} onClick={onClick}>
      x
    </button>
  ),
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
/** The sheet's X, its only way out: there is no Cancel. */
const closeButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
const closeSheet = () => press(closeButton)

const PHONE_ONLY: LaptopCreation = { local: false, chromeTip: false }
const MAC: LaptopCreation = {
  local: true,
  os: "macos",
  row: "macChrome",
  managers: ["apple", "gpm"],
  withdrawn: [],
}
const WINDOWS: LaptopCreation = {
  local: true,
  os: "windows",
  row: "windowsChrome",
  managers: ["gpm", "1password"],
  withdrawn: [],
}
const GPM_ANSWER = {
  authenticatorAttachment: "platform",
  backupEligible: true,
  aaguid: GPM_AAGUID,
} as const
const APPLE_ANSWER = { ...GPM_ANSWER, aaguid: APPLE_ICLOUD_AAGUID } as const
const ONEPASSWORD_ANSWER = { ...GPM_ANSWER, aaguid: ONEPASSWORD_AAGUID } as const

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
  h.probeLaptopCreation.mockResolvedValue(PHONE_ONLY)
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
    await closeSheet()

    const second = heldCreate()
    await pressLabel("landing-signin")
    await deposit()
    await continueAtSteps()
    await act(async () => second.request!.answer())
    await flush()

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

  it("closing during the create's request ends the signal that request runs under", async () => {
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
    await closeSheet()
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

  it("closing during the create's request, then leaving at once, sends one cancel", async () => {
    await toCreateRequest()
    act(() => {
      closeButton()!.click()
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
    await closeSheet()

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
      closeButton()!.click()
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

  it("closing at the phone steps, then leaving at once, sends one in-app cancel that asked nothing", async () => {
    await pressLabel("landing-signin")
    await deposit()
    act(() => {
      closeButton()!.click()
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
 * A laptop allowed to create on its own password manager: the sheet opens on this computer, the
 * answer names the manager, and every way back from a refusal or a closed prompt is the sheet.
 */
describe("signup create on this computer — passkey telemetry", () => {
  const variant = () => byTestId("phone-steps")?.dataset.variant
  const createRoute = (call: number) =>
    (h.createAccount.mock.calls[call]?.[5] as { route?: string } | undefined)?.route
  /** The next create asks once, is answered as `evidence` says, then fails as `error` says. */
  const refusedCreate = (evidence: object, error: () => unknown) =>
    h.createAccount.mockImplementationOnce(async () => {
      const request = harness.request("create")
      request.answer(evidence as never)
      await request.settled
      throw error()
    })
  /** The next create's prompt closes with nothing made. */
  const closedCreate = () =>
    h.createAccount.mockImplementationOnce(async () => {
      const request = harness.request("create")
      request.reject(new DOMException("closed", "NotAllowedError"))
      await request.settled
    })
  const toLocalSheet = async () => {
    await pressLabel("landing-signin")
    await deposit()
    expect(variant()).toBe("local")
  }

  beforeEach(() => {
    // A create a failed test never reached must not answer the next test's.
    h.createAccount.mockReset()
    h.probePhoneReach.mockResolvedValue("ok")
    h.probeLaptopCreation.mockResolvedValue(MAC)
  })

  it("creates on this computer and reports the manager that answered", async () => {
    const held = heldCreate()
    await toLocalSheet()
    await press(() => byTestId("phone-steps-local"))
    expect(h.useLaptopCreation).toHaveBeenCalledWith(MAC)
    expect(createRoute(0)).toBe("this-device")
    await act(async () => held.request!.answer(GPM_ANSWER))
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "create",
        outcome: "succeeded",
        route: "same_device",
        provider: "google_password_manager",
        phone_reach: "ok",
        credential_created: "yes",
      }),
    ])
  })

  it("a passkey saved on this computer is pointed at Chrome where the sheet said Chrome could keep it", async () => {
    h.probeLaptopCreation.mockResolvedValue({ local: false, chromeTip: "gpm" })
    refusedCreate(GPM_ANSWER, () =>
      markPasskeyWritten(
        new PhoneRequiredError({ providerName: "Windows Hello", ceremony: "create" }),
      ),
    )
    await pressLabel("landing-signin")
    await deposit()
    expect(variant()).toBe("phone")
    await press(() => byTestId("phone-steps-continue"))
    expect(byTestId("create-refused")!.dataset.reason).toBe("PhoneRequiredError")
    expect(byTestId("passkey-chrome-advice")!.textContent).toBe(CHROME_REFUSAL_COPY)
  })

  it.each([
    ["Google Password Manager", "windowsEdgeBrave", "windows", "gpm", true],
    ["Apple Passwords", "macSafari", "macos", "apple", false],
  ] as const)(
    "a row with 1Password alone that opened on the phone points at Chrome only where Chrome has %s",
    async (_, row, os, chromeTip, named) => {
      h.probeLaptopCreation.mockResolvedValue({
        local: true,
        os,
        row,
        managers: ["1password"],
        withdrawn: [],
        chromeTip,
      })
      refusedCreate(GPM_ANSWER, () =>
        markPasskeyWritten(
          new PhoneRequiredError({ providerName: "Windows Hello", ceremony: "create" }),
        ),
      )
      await pressLabel("landing-signin")
      await deposit()
      expect(variant()).toBe("phone")
      await press(() => byTestId("phone-steps-continue"))
      expect(byTestId("create-refused")!.dataset.reason).toBe("PhoneRequiredError")
      expect(byTestId("passkey-chrome-advice")?.textContent ?? null).toBe(
        named ? CHROME_REFUSAL_COPY : null,
      )
    },
  )

  it("an Apple answer below the floor is refused on a card that leads back to the sheet", async () => {
    refusedCreate(APPLE_ANSWER, () =>
      markPasskeyWritten(new LaptopPasskeyRefusedError("apple", ["gpm"])),
    )
    await toLocalSheet()
    await press(() => byTestId("phone-steps-local"))
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "create",
        outcome: "refused",
        reason: "apple_below_floor",
        provider: "icloud_keychain",
        credential_created: "yes",
      }),
    ])
    const card = byTestId("create-refused")!
    expect(card.dataset.reason).toBe("LaptopPasskeyRefusedError")
    expect(byTestId("passkey-apple-floor")).not.toBeNull()
    expect(byTestId("passkey-safari-advice")).toBeNull()
    expect(byTestId("passkey-chrome-advice")).toBeNull()
    expect(byTestId("passkey-leftover")).not.toBeNull()
    expect(byTestId("passkey-phone")!.className).not.toContain("ww-invite-pill")
    expect(byTestId("create-retry")!.className).toContain("ww-invite-pill")
    // Try again: the sheet, on this computer, not the browser's prompt.
    const next = heldCreate()
    await press(() => byTestId("create-retry"))
    expect(byTestId("create-refused")).toBeNull()
    expect(variant()).toBe("local")
    expect(byTestId("phone-steps-unfinished")).toBeNull()
    expect(h.createAccount).toHaveBeenCalledTimes(1)
    await press(() => byTestId("phone-steps-local"))
    expect(createRoute(1)).toBe("this-device")
    await act(async () => next.request!.answer(GPM_ANSWER))
    await flush()
    expect(events()).toContainEqual(
      expect.objectContaining({ ceremony: "create", outcome: "succeeded" }),
    )
  })

  it.each([
    ["names Chrome while Mac Chrome admits Apple", "apple", "chrome"],
    ["names only the unread version once Apple is withdrawn from Mac Chrome", undefined, "version"],
  ] as const)(
    "an Apple answer on Safari's row gets the Safari line, which %s",
    async (_, chromeTip, wording) => {
      h.probeLaptopCreation.mockResolvedValue({
        local: true,
        os: "macos",
        row: "macSafari",
        managers: ["1password"],
        withdrawn: [],
        ...(chromeTip ? { chromeTip } : {}),
      })
      refusedCreate(APPLE_ANSWER, () =>
        markPasskeyWritten(new LaptopPasskeyRefusedError("apple", ["1password"])),
      )
      await pressLabel("landing-signin")
      await deposit()
      expect(variant()).toBe("phone")
      await press(() => byTestId("phone-steps-switch-local"))
      await press(() => byTestId("phone-steps-local"))
      expect(byTestId("create-refused")!.dataset.reason).toBe("LaptopPasskeyRefusedError")
      expect(byTestId("passkey-apple-floor")).not.toBeNull()
      expect(byTestId("passkey-safari-advice")!.textContent).toBe(SAFARI_REFUSAL_COPY[wording])
      // Try again asks for this computer, which the sheet honours whatever the count.
      await press(() => byTestId("create-retry"))
      expect(variant()).toBe("local")
    },
  )

  describe("the 1Password advice", () => {
    const credentials = Object.getOwnPropertyDescriptor(navigator, "credentials")
    const install = (value: unknown) =>
      Object.defineProperty(navigator, "credentials", { value, configurable: true })
    const advice = () => byTestId("passkey-extension-advice")
    /** The refusal as the creation driver raises it: naming the manager that answered. */
    const noKey = (manager: "1password" | "gpm" = "1password") =>
      markPasskeyWritten(new NoPrfError({ localManagers: ["gpm", "1password"], manager }))
    afterEach(() => {
      if (credentials) Object.defineProperty(navigator, "credentials", credentials)
      else delete (navigator as { credentials?: unknown }).credentials
    })

    it.each([
      ["names the extension's pop-up where a script answers", { create: async () => null }, "use"],
      [
        "says to install the extension where the browser's own prompt answers",
        { create: Promise.resolve.bind(Promise) },
        "install",
      ],
    ] as const)("on a Windows row that admits 1Password, %s", async (_n, calls, wording) => {
      h.probeLaptopCreation.mockResolvedValue(WINDOWS)
      install(calls)
      refusedCreate(ONEPASSWORD_ANSWER, () => noKey())
      await toLocalSheet()
      await press(() => byTestId("phone-steps-local"))
      expect(byTestId("create-refused")!.dataset.reason).toBe("NoPrfError")
      expect(advice()?.textContent).toBe(EXTENSION_ADVICE_COPY[wording])
      expect(byTestId("passkey-leftover")).not.toBeNull()
      expect(byTestId("passkey-phone")).not.toBeNull()
    })

    it("stays off when another manager answered without key material, and for another refusal", async () => {
      h.probeLaptopCreation.mockResolvedValue(WINDOWS)
      install({ create: async () => null })
      refusedCreate(GPM_ANSWER, () => noKey("gpm"))
      await toLocalSheet()
      await press(() => byTestId("phone-steps-local"))
      expect(byTestId("create-refused")!.dataset.reason).toBe("NoPrfError")
      expect(advice()).toBeNull()

      refusedCreate(ONEPASSWORD_ANSWER, () =>
        markPasskeyWritten(new LaptopPasskeyRefusedError("unnamed", ["gpm", "1password"])),
      )
      await press(() => byTestId("create-retry"))
      await press(() => byTestId("phone-steps-local"))
      expect(byTestId("create-refused")!.dataset.reason).toBe("LaptopPasskeyRefusedError")
      expect(advice()).toBeNull()
    })

    it("stays off on a Mac row, and on a Windows row that does not admit 1Password", async () => {
      install({ create: async () => null })
      refusedCreate(ONEPASSWORD_ANSWER, () => noKey())
      await toLocalSheet()
      await press(() => byTestId("phone-steps-local"))
      expect(byTestId("create-refused")!.dataset.reason).toBe("NoPrfError")
      expect(advice()).toBeNull()

      h.probeLaptopCreation.mockResolvedValue({
        ...WINDOWS,
        managers: ["gpm"],
        withdrawn: ["1password"],
      })
      refusedCreate(ONEPASSWORD_ANSWER, () => noKey())
      await press(() => byTestId("create-retry"))
      await press(() => byTestId("phone-steps-local"))
      expect(byTestId("create-refused")!.dataset.reason).toBe("NoPrfError")
      expect(advice()).toBeNull()
    })

    it("stays off on the phone route", async () => {
      h.probeLaptopCreation.mockResolvedValue(WINDOWS)
      install({ create: async () => null })
      refusedCreate(ONEPASSWORD_ANSWER, () => noKey())
      await toLocalSheet()
      await press(() => byTestId("phone-steps-phone"))
      await press(() => byTestId("phone-steps-continue"))
      expect(createRoute(0)).toBe("phone")
      expect(byTestId("create-refused")!.dataset.reason).toBe("NoPrfError")
      expect(advice()).toBeNull()
    })
  })

  describe("once a manager the row cannot use kept answering", () => {
    const credentials = Object.getOwnPropertyDescriptor(navigator, "credentials")
    const ONEPASSWORD_ONLY: LaptopCreation = {
      local: true,
      os: "windows",
      row: "windowsEdgeBrave",
      managers: ["1password"],
      withdrawn: [],
      chromeTip: "gpm",
    }
    const otherManager = () =>
      markPasskeyWritten(
        new UnsupportedProviderError("manager", {
          providerName: "Bitwarden",
          localManagers: ["1password"],
        }),
      )
    beforeEach(() => {
      h.probeLaptopCreation.mockResolvedValue(ONEPASSWORD_ONLY)
      Object.defineProperty(navigator, "credentials", {
        value: { create: async () => null },
        configurable: true,
      })
    })
    afterEach(() => {
      if (credentials) Object.defineProperty(navigator, "credentials", credentials)
      else delete (navigator as { credentials?: unknown }).credentials
    })

    it("on a row with 1Password alone, the card's Try again opens the sheet on the phone", async () => {
      refusedCreate({ ...GPM_ANSWER, aaguid: undefined }, otherManager)
      await toLocalSheet()
      await press(() => byTestId("phone-steps-local"))
      expect(byTestId("create-refused")!.dataset.reason).toBe("UnsupportedProviderError")
      for (let i = 0; i <= LOCAL_REFUSAL_LIMIT; i++) noteLocalRefusal()
      const next = heldCreate()
      await press(() => byTestId("create-retry"))
      expect(variant()).toBe("phone")
      expect(byTestId("phone-steps-steered")!.textContent).toBe(
        PHONE_STEPS_COPY.local.steered.phone,
      )
      expect(byTestId("phone-steps-switch-local")).not.toBeNull()
      await continueAtSteps()
      expect(createRoute(1)).toBe("phone")
      await act(async () => next.request!.answer())
      await flush()
    })

    it("at the limit, Try again still opens on this computer", async () => {
      refusedCreate({ ...GPM_ANSWER, aaguid: undefined }, otherManager)
      await toLocalSheet()
      await press(() => byTestId("phone-steps-local"))
      for (let i = 0; i < LOCAL_REFUSAL_LIMIT; i++) noteLocalRefusal()
      await press(() => byTestId("create-retry"))
      expect(variant()).toBe("local")
      expect(byTestId("phone-steps-steered")).toBeNull()
    })
  })

  it("the refusal's phone exit re-opens the sheet on the phone, with Back to this computer", async () => {
    refusedCreate(APPLE_ANSWER, () =>
      markPasskeyWritten(new LaptopPasskeyRefusedError("apple", ["gpm"])),
    )
    await toLocalSheet()
    await press(() => byTestId("phone-steps-local"))
    const next = heldCreate()
    await press(() => byTestId("passkey-phone"))
    expect(variant()).toBe("phone")
    expect(byTestId("phone-steps-back")).not.toBeNull()
    await continueAtSteps()
    expect(createRoute(1)).toBe("phone")
    await act(async () => next.request!.answer())
    await flush()
    expect(events()).toHaveLength(2)
  })

  it("no phone exit where the browser reaches none", async () => {
    h.probePhoneReach.mockResolvedValue("no-hybrid")
    refusedCreate(APPLE_ANSWER, () =>
      markPasskeyWritten(new LaptopPasskeyRefusedError("apple", ["gpm"])),
    )
    await toLocalSheet()
    expect(byTestId("phone-steps-phone")).toBeNull()
    await press(() => byTestId("phone-steps-local"))
    expect(byTestId("create-refused")).not.toBeNull()
    expect(byTestId("passkey-phone")).toBeNull()
  })

  it("a prompt closed on this computer with nothing made re-opens the sheet, saying so", async () => {
    closedCreate()
    await toLocalSheet()
    await press(() => byTestId("phone-steps-local"))
    // No card, no error line: the sheet again, on this computer, with the unfinished line.
    expect(byTestId("create-refused")).toBeNull()
    expect(container.textContent).not.toContain("Nothing was created")
    expect(variant()).toBe("local")
    expect(byTestId("phone-steps-unfinished")).not.toBeNull()
    expect(events()).toEqual([
      expect.objectContaining({ ceremony: "create", reason: "prompt_closed", prompts: "1" }),
    ])
    // The next pick is a new attempt.
    const next = heldCreate()
    await press(() => byTestId("phone-steps-local"))
    expect(h.createAccount).toHaveBeenCalledTimes(2)
    await act(async () => next.request!.answer(GPM_ANSWER))
    await flush()
    expect(events()).toHaveLength(2)
    expect(events()[1]).toMatchObject({ outcome: "succeeded", attempt: "2" })
  })

  it("a closed prompt on the phone route goes back to the phone variant, with no error", async () => {
    closedCreate()
    await toLocalSheet()
    await press(() => byTestId("phone-steps-phone"))
    await continueAtSteps()
    expect(container.querySelector(".ww-invite-modal-error")).toBeNull()
    expect(variant()).toBe("phone")
    expect(byTestId("create-refused")).toBeNull()
  })

  it("a follow-up prompt closed after the passkey was made lands on the card, with the phone exit", async () => {
    refusedCreate(GPM_ANSWER, () =>
      markPasskeyWritten(new DOMException("closed", "NotAllowedError")),
    )
    await toLocalSheet()
    await press(() => byTestId("phone-steps-local"))
    // A passkey exists, so the sheet's unfinished line would mislead: the card says where it is.
    expect(byTestId("phone-steps")).toBeNull()
    const card = byTestId("create-refused")!
    expect(card.dataset.reason).toBe("NotAllowedError")
    expect(byTestId("passkey-leftover")).not.toBeNull()
    expect(byTestId("passkey-phone")).not.toBeNull()
    await press(() => byTestId("create-retry"))
    expect(variant()).toBe("local")
    expect(byTestId("phone-steps-unfinished")).toBeNull()
  })

  it.each(["ok", "no-hybrid"] as const)(
    "a refused key attempt's Try again re-opens the key variant, whose Back returns where it came from (reach %s)",
    async (reach) => {
      h.probePhoneReach.mockResolvedValue(reach)
      refusedCreate({ authenticatorAttachment: "cross-platform", backupEligible: false }, () =>
        markPasskeyWritten(new NoPrfError()),
      )
      await toLocalSheet()
      await press(() => byTestId("phone-steps-security-key"))
      expect(variant()).toBe("key")
      await continueAtSteps()
      expect(createRoute(0)).toBe("security-key")
      expect(byTestId("create-refused")).not.toBeNull()
      expect(byTestId("passkey-phone")).toBeNull()
      await press(() => byTestId("create-retry"))
      expect(variant()).toBe("key")
      expect(byTestId("phone-steps-back")!.getAttribute("aria-label")).toBe("Back")
      await press(() => byTestId("phone-steps-back"))
      expect(variant()).toBe("local")
    },
  )
})

/**
 * The campaign hand-off as it ships: a silent attempt on mount, and the terms sheet's Deposit
 * spending a prompt when the bridge material was not enough. A run that asks nothing reports
 * nothing — a prompt-free success is no ceremony.
 */
describe("signup create in an app's built-in browser", () => {
  it("a create the user closed shows nothing when it then fails as not supported", async () => {
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
      await closeSheet()
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
