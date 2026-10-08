/**
 * The sign-in screen on /enter: the arrival probe that shows it only when a ceremony is needed, the
 * tag field that resolves as it is typed, the remembered accounts one click each, Login pinned to
 * what resolved, Show passkeys for the browser's full chooser, every failure on its own card with
 * Back to the screen, one analytics event per outcome with the real code table, and a cancel that
 * ends the operation down to the writes that follow entry.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../src/platform/storage/walletStorage"
import type { SignInStart } from "../src/features/onboarding/steps/ConfirmTagModal"

vi.setConfig({ testTimeout: 30_000 })

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  enterWithPasskey: vi.fn(),
  confirmTag: vi.fn(),
  lookup: vi.fn(),
  probe: vi.fn(),
  getOxideTuple: vi.fn(async () => ({})),
  recoverFromCache: vi.fn(async () => undefined),
  showReportableError: vi.fn(),
  fireEvent: vi.fn(),
  getConfig: vi.fn(),
  reservedNameHashes: vi.fn(),
  nameGrantToken: vi.fn(),
  boundNameGrantOwner: vi.fn(),
  claimTag: vi.fn(),
  collectOnboardingKeys: vi.fn(async () => ({})),
  saveTerms: vi.fn(),
  openActivationPrompt: vi.fn(),
  bridge: null as unknown,
}))

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => h.navigate,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAccountContext: () => ({ setObsidionAccount: vi.fn() }),
  useAztecContext: () => ({ obsidionWallet: { wallet: true } }),
  useContractServiceContext: () => ({ contractService: { service: true } }),
}))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: h.getConfig,
}))
vi.mock("../src/config/oxideTuple", () => ({ getOxideTuple: h.getOxideTuple }))
vi.mock("../src/features/contacts/registryResolution", () => ({
  resolveTagViaRegistry: vi.fn(),
  resolveTagForCommit: vi.fn(),
}))
vi.mock("../src/features/onboarding/oxideOnboarding", async () => {
  const { matchWireNameHash } = await import("@obsidion/front-core")
  return {
    enterWithPasskey: h.enterWithPasskey,
    nameGrantToken: h.nameGrantToken,
    confirmTag: h.confirmTag,
    claimTag: h.claimTag,
    collectOnboardingKeys: h.collectOnboardingKeys,
    checkpointRegistrationTerms: (account: string, tag: string, claim: { deadline: string }) => ({
      account,
      tag,
      deadline: Number(claim.deadline),
    }),
    isCommittedFailure: (err: unknown) =>
      typeof err === "object" &&
      err !== null &&
      (err as { committed?: boolean }).committed === true,
    // The real matching, without the module that drags the Aztec stack in.
    reservedTagMatch: (hashes: `0x${string}`[], ensDomain: string, handle: string) =>
      hashes.map((hash) => matchWireNameHash(handle, ensDomain, hash)).find(Boolean) ?? null,
    // The class the screen matches by instanceof; the real one drags the Aztec stack in.
    PasskeyMismatchError: class PasskeyMismatchError extends Error {
      name = "PasskeyMismatchError"
      constructor() {
        super("that isn't the passkey this claim was started with")
      }
    },
  }
})
vi.mock("../src/features/onboarding/recoveryProbes", () => ({
  reservedNameHashes: h.reservedNameHashes,
  boundNameGrantOwner: h.boundNameGrantOwner,
}))
vi.mock("../src/features/onboarding/registrationTerms", () => ({
  saveRegistrationTerms: h.saveTerms,
}))
vi.mock("../src/features/onboarding/activationPrompt", () => ({
  openActivationPrompt: h.openActivationPrompt,
}))
// The lookup is the only stand-in: the diagnosis and the code table are the real ones.
vi.mock("../src/features/onboarding/findPasskeyByTag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/findPasskeyByTag")>()),
  lookupPasskeyByTag: h.lookup,
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    probePhoneReach: async () => "unknown",
    recoverFromCache: h.recoverFromCache,
  }),
  peekAuthService: () => undefined,
}))
vi.mock("../src/features/onboarding/webRegistration", () => ({
  getPendingStore: () => ({ list: () => [] }),
}))
vi.mock("../src/features/paylink/claimStash", () => ({ peekClaimStash: () => undefined }))
vi.mock("../src/features/paylink/sponsoredPaylink", () => ({ decodeLink: vi.fn() }))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
// `failureCode` stays real, so the codes asserted below are the ones that reach the wire.
vi.mock("../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/analytics")>()),
  fireEvent: h.fireEvent,
}))
vi.mock("../src/features/onboarding/nameAvailability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/nameAvailability")>()),
  probeNameAvailability: h.probe,
}))
vi.mock("../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("../src/platform/desktopBridge", () => ({ getDesktopL1Bridge: () => h.bridge }))
vi.mock("../src/ui/EndpointsModal", () => ({
  EndpointsModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="endpoints-modal">
      <button data-testid="endpoints-close" onClick={onClose} />
    </div>
  ),
}))
vi.mock("../src/features/onboarding/OnboardingCard", () => ({
  OnboardingSpinnerBody: ({
    label,
    cancelLabel,
    onCancel,
  }: {
    label: string
    cancelLabel?: string
    onCancel?: () => void
  }) => (
    <div data-testid="spinner">
      {label}
      <button data-testid="spinner-cancel" onClick={onCancel}>
        {cancelLabel}
      </button>
    </div>
  ),
}))
// The card's two roles, with the start role's wiring exposed; the real card has its own suite.
vi.mock("../src/features/onboarding/steps/ConfirmTagModal", () => ({
  ConfirmTagModal: ({
    initialHandle,
    start,
    onConfirm,
    onShowPasskeys,
    onBack,
    onClose,
  }: {
    initialHandle?: string
    start?: SignInStart
    onConfirm: (handle: string) => void
    onShowPasskeys?: () => void
    onBack?: () => void
    onClose: () => void
  }) => {
    if (!start) {
      return (
        <div data-testid="confirm-tag" data-handle={initialHandle}>
          <button data-testid="confirm-tag-submit" onClick={() => onConfirm(initialHandle ?? "")} />
          <button data-testid="confirm-back" onClick={onBack} />
          <button data-testid="confirm-tag-close" onClick={onClose} />
        </div>
      )
    }
    const live = start.prepared === "ready" && !start.busy
    return (
      <form
        data-testid="sign-in-start"
        data-prepared={start.prepared}
        data-resolving={String(start.resolving)}
        data-chooser-first={String(start.chooserFirst)}
        onSubmit={(e) => {
          e.preventDefault()
          if (start.submitReady && live) onConfirm(start.value)
        }}
      >
        {start.candidates.map((candidate) => (
          <button
            key={candidate.credentialId}
            type="button"
            data-testid="sign-in-account"
            data-tag={candidate.usertag}
            disabled={!live}
            onClick={() => start.onCandidate(candidate)}
          />
        ))}
        <input
          aria-label="Your tag"
          value={start.value}
          onChange={(e) => start.onTagChange(e.target.value)}
          onBlur={start.onTagBlur}
        />
        {start.notice && <p data-testid={`by-tag-${start.notice.kind}`}>{start.notice.tag}</p>}
        {start.prepared === "failed" && (
          <button
            type="button"
            data-testid="sign-in-prepare-again"
            onClick={start.onPrepareAgain}
          />
        )}
        <button
          type="button"
          data-testid="sign-in-login"
          disabled={!(start.submitReady && live)}
          onClick={() => onConfirm(start.value)}
        />
        <button
          type="button"
          data-testid="sign-in-show-passkeys"
          disabled={!live}
          onClick={onShowPasskeys}
        />
        <button type="button" data-testid="sign-in-close" onClick={onClose} />
        {start.onEndpoints && (
          <button type="button" data-testid="sign-in-endpoints" onClick={start.onEndpoints} />
        )}
      </form>
    )
  },
}))
vi.mock("../src/features/onboarding/steps/InvitationStep", () => ({ InvitationStep: () => null }))
vi.mock("@obsidion/web-ds", () => ({
  PrimaryGradientButton: ({
    title,
    testId,
    isDisabled,
    isLoading,
    onClick,
  }: {
    title: string
    testId?: string
    isDisabled?: boolean
    isLoading?: boolean
    onClick?: () => void
  }) => (
    <button type="button" data-testid={testId} disabled={isDisabled || isLoading} onClick={onClick}>
      {title}
    </button>
  ),
  NumberedStepRow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Icon: () => <i />,
}))

let container: HTMLDivElement
let root: Root

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))

const policyErrors = () => import("@obsidion/passkey-web")

async function render(path = "/enter", strictMode = false) {
  const { EnterAppScreen } = await import("../src/features/onboarding/EnterAppScreen")
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <EnterAppScreen />
    </MemoryRouter>
  )
  await act(async () => {
    root.render(strictMode ? <React.StrictMode>{tree}</React.StrictMode> : tree)
  })
  await flush()
}

type EnterOptions = {
  gate: () => Promise<{ signal: AbortSignal; route?: string; reach: string }>
  hints?: { credentialId: string; pubkeyHex: string }
  strictTag?: boolean
  signal?: AbortSignal
  chooser?: boolean
  cacheOnly?: boolean
  restoreCache?: boolean
}
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const click = async (id: string) => {
  await act(async () => byTestId(id)!.click())
  await flush()
}
const refused = () => byTestId("enter-refused")
const screen = () => byTestId("sign-in-start")
const login = () => byTestId("sign-in-login") as HTMLButtonElement
const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Your tag"]')!
const type = async (value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input(), value)
    input().dispatchEvent(new Event("input", { bubbles: true }))
  })
  await flush()
}
/** Leaving the field runs a pending read at once — the way a Login click blurs it. */
const blur = async () => {
  await act(async () => input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
  await flush()
}
const submitField = async () => {
  await act(async () =>
    screen()!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  )
  await flush()
}
const navigatedTo = (route: string) =>
  h.navigate.mock.calls.some((call) => (call as unknown[])[0] === route)
const leaveAssign = vi.fn()
/** Cancelling hands back to the campaign, which ends its own session on arrival. */
const leftForCampaign = () =>
  leaveAssign.mock.calls.some((call) => call[0] === "https://launch.test.invalid/?signedout=1")
const lastOptions = () => {
  const calls = h.enterWithPasskey.mock.calls
  return calls[calls.length - 1][3] as EnterOptions
}
/** Every action_failed emitted, as (action, code) pairs, plus the resolved lookups. */
const failures = () =>
  h.fireEvent.mock.calls
    .filter((c) => c[0] === "action_failed")
    .map((c) => [(c[1] as { action: string }).action, (c[1] as { code: string }).code])
const resolvedEvents = () =>
  h.fireEvent.mock.calls.filter((c) => c[0] === "passkey_by_tag_lookup_resolved")

const L2 = `0x${"ac".repeat(32)}`
const OTHER = `0x${"bd".repeat(32)}`
const CANDIDATE = { credentialId: "cred-alice", pubkeyHex: "ab".repeat(64) }
const closed = () => new DOMException("closed", "NotAllowedError")
const named = (handle = "alice") => ({ entered: true, handle, address: L2, account: {} })
const needsCeremony = () =>
  h.enterWithPasskey.mockResolvedValueOnce({ entered: false, reason: "ceremony-required" })
const resolvedLookup = (tag = "alice", moreKeys = false) =>
  h.lookup.mockResolvedValueOnce({
    kind: "resolved",
    tag,
    candidate: CANDIDATE,
    l2Address: L2,
    moreKeys,
  })
const nameless = () => ({
  entered: false,
  reason: "unclaimed",
  account: { getAddress: () => ({ toString: () => L2 }) },
  bootstrap: {
    address: "0xE0A0000000000000000000000000000000000001",
    signMessage: async () => "0xsig",
  },
  ensDomain: "zk.money",
})

const MAP_KEY = "obsidion.obsidion_web_passkey_identity_map"
/** The campaign claim notices owed on this browser (front-core CampaignClaimNotices). */
const owedClaimNotices = () =>
  JSON.parse(walletStorage.getItem("obsidion.obsidion_campaign_claim_notices") ?? "{}")
/** This browser's root record for an account, with the tag it claimed. */
function remember(credentialId: string, usertag: string, createdAt = 1) {
  const raw = walletStorage.getItem(MAP_KEY)
  const map = raw ? JSON.parse(raw) : { version: 1, entries: {} }
  map.entries[credentialId] = {
    credentialId,
    rpId: "localhost",
    l2Address: L2,
    pubkey: `0x${"AB".repeat(64)}`,
    isMskRoot: true,
    createdAt,
    usertag,
  }
  walletStorage.setItem(MAP_KEY, JSON.stringify(map))
}

const IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1"
const userAgent = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent")!
const onPhone = () =>
  Object.defineProperty(navigator, "userAgent", { value: IOS, configurable: true })

/** A probe that finds no cached key, so the screen shows. */
async function arrive(path = "/enter", strictMode = false) {
  needsCeremony()
  await render(path, strictMode)
  expect(screen()).not.toBeNull()
}

/** The whole way to the Login tap: the screen, the arrival tag resolved. */
async function reachFound(path = "/enter?handle=alice") {
  resolvedLookup()
  await arrive(path)
  expect(login().disabled).toBe(false)
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.resetModules()
  leaveAssign.mockClear()
  vi.stubGlobal("location", { assign: leaveAssign, origin: "https://wallet.test" })
  h.navigate.mockClear()
  h.enterWithPasskey.mockReset()
  h.confirmTag.mockReset()
  h.lookup.mockReset().mockResolvedValue({ kind: "notFound" })
  h.probe.mockReset().mockResolvedValue({ status: "unknown", grantValid: false, grantBound: false })
  h.getOxideTuple.mockReset().mockResolvedValue({})
  h.recoverFromCache.mockReset().mockResolvedValue(undefined)
  h.showReportableError.mockClear()
  h.fireEvent.mockClear()
  h.reservedNameHashes.mockReset().mockResolvedValue([])
  h.nameGrantToken.mockReset().mockReturnValue(undefined)
  h.boundNameGrantOwner.mockReset().mockResolvedValue(false)
  h.claimTag.mockReset().mockResolvedValue({
    kind: "pending",
    oxideAccount: "0xacc0000000000000000000000000000000000001",
    claim: { deadline: "4102444800" },
    startBroadcast: vi.fn(async () => true),
  })
  h.saveTerms.mockClear()
  h.openActivationPrompt.mockClear()
  h.bridge = null
  h.getConfig.mockReturnValue({
    rpId: "localhost",
    campaignUrl: "https://launch.test.invalid",
    admissionGate: true,
    accountServiceTestMode: false,
  })
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  localStorage.clear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  Object.defineProperty(navigator, "userAgent", userAgent)
  vi.unstubAllGlobals()
})

describe("the arrival", () => {
  it("probes the ceremony-free sources first; with none the screen shows, prepared, with no prompt", async () => {
    await arrive()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    expect(lastOptions().cacheOnly).toBe(true)
    expect(lastOptions().restoreCache).toBeUndefined()
    // The probe fetched the manifest and made the one cache proof: nothing more to prepare.
    expect(screen()!.dataset.prepared).toBe("ready")
    expect(h.getOxideTuple).not.toHaveBeenCalled()
    expect(login().disabled).toBe(true)
    expect(byTestId("sign-in-show-passkeys")).toHaveProperty("disabled", false)
    expect(refused()).toBeNull()
  })

  it.each([
    ["laptop", () => {}],
    ["phone", onPhone],
  ])("a cached key enters with no screen and no prompt on a %s", async (_p, posture) => {
    posture()
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await render()
    expect(screen()).toBeNull()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("an entry with a name owes the campaign its claim notice", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await render()
    await flush()
    expect(owedClaimNotices()).toEqual({
      [L2]: { l2Address: L2, tag: "alice", owedAt: expect.any(Number), attempts: 0 },
    })
  })

  it("the arrival handle seeds the field and resolves it once; Login is then one click", async () => {
    resolvedLookup()
    await arrive("/enter?handle=Alice")
    expect(input().value).toBe("alice")
    expect(h.lookup).toHaveBeenCalledTimes(1)
    expect(h.lookup).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({ resolveTag: expect.any(Function) }),
    )
    expect(login().disabled).toBe(false)
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("sign-in-login")
    expect(h.enterWithPasskey).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      "alice",
      expect.objectContaining({
        hints: CANDIDATE,
        restoreCache: false,
        signal: expect.any(AbortSignal),
      }),
    )
    expect(resolvedEvents()).toEqual([["passkey_by_tag_lookup_resolved", { more_keys: false }]])
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("hot cache with the post-switch reload's handle enters silently; the tag is never read", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(named("bob"))
    await render("/enter?handle=bob&strict=1")
    expect(lastOptions().strictTag).toBe(true)
    expect(h.lookup).not.toHaveBeenCalled()
    expect(screen()).toBeNull()
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a read that failed before anything was asked or written shows the screen, which prepares itself", async () => {
    h.enterWithPasskey.mockRejectedValueOnce(new Error("rpc down"))
    await render()
    expect(screen()).not.toBeNull()
    expect(screen()!.dataset.prepared).toBe("ready")
    expect(h.getOxideTuple).toHaveBeenCalledTimes(1)
    expect(h.recoverFromCache).toHaveBeenCalledTimes(1)
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(failures()).toEqual([["enter", "unknown"]])
    expect(navigatedTo("/claim")).toBe(false)
  })

  it("a write that failed after the probe committed shows its own card: Retry re-probes, Cancel, no signup", async () => {
    h.enterWithPasskey.mockRejectedValueOnce(
      Object.assign(new Error("disk full"), { committed: true }),
    )
    await render()
    expect(screen()).toBeNull()
    expect(refused()?.dataset.reason).toBe("error")
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    expect(byTestId("enter-back")).toBeNull()
    expect(byTestId("enter-continue")).toBeNull()
    expect(h.showReportableError).toHaveBeenCalledTimes(1)
    needsCeremony()
    await click("enter-retry")
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    expect(lastOptions().cacheOnly).toBe(true)
    expect(screen()).not.toBeNull()
  })

  it("?choose=1 skips the probe, prepares the screen and leads with Show passkeys", async () => {
    let warm!: (value: object) => void
    h.getOxideTuple.mockReturnValueOnce(new Promise<object>((r) => (warm = r)))
    await render("/enter?choose=1")
    expect(h.enterWithPasskey).not.toHaveBeenCalled()
    expect(screen()!.dataset.prepared).toBe("pending")
    expect(screen()!.dataset.chooserFirst).toBe("true")
    expect(byTestId("sign-in-show-passkeys")).toHaveProperty("disabled", true)
    await act(async () => warm({}))
    await flush()
    expect(screen()!.dataset.prepared).toBe("ready")
    expect(h.recoverFromCache).toHaveBeenCalledTimes(1)
    // Preparation completing opened nothing.
    expect(h.enterWithPasskey).not.toHaveBeenCalled()
  })

  it("the actions wait for a held cache proof too, and a failed preparation offers only a re-prepare", async () => {
    let proved!: (value: undefined) => void
    h.recoverFromCache.mockReturnValueOnce(new Promise<undefined>((r) => (proved = r)))
    remember("cred-alice", "alice")
    await render("/enter?choose=1")
    expect(screen()!.dataset.prepared).toBe("pending")
    expect(byTestId("sign-in-account")).toHaveProperty("disabled", true)
    await act(async () => proved(undefined))
    await flush()
    expect(byTestId("sign-in-account")).toHaveProperty("disabled", false)

    act(() => root.unmount())
    root = createRoot(container)
    h.getOxideTuple.mockRejectedValueOnce(new Error("offline"))
    await render("/enter?choose=1")
    expect(screen()!.dataset.prepared).toBe("failed")
    expect(byTestId("sign-in-show-passkeys")).toHaveProperty("disabled", true)
    await click("sign-in-prepare-again")
    expect(screen()!.dataset.prepared).toBe("ready")
    expect(h.enterWithPasskey).not.toHaveBeenCalled()
  })

  it("a cancelled probe whose read ends needing a ceremony shows no screen and reads nothing", async () => {
    let release!: (value: unknown) => void
    h.enterWithPasskey.mockReturnValueOnce(new Promise((r) => (release = r)))
    await render("/enter?handle=alice")
    await click("spinner-cancel")
    await act(async () => release({ entered: false, reason: "ceremony-required" }))
    await flush()
    expect(screen()).toBeNull()
    expect(h.lookup).not.toHaveBeenCalled()
  })

  it("under StrictMode the chooser arrival seeds the handle on the replay, and it resolves", async () => {
    resolvedLookup()
    resolvedLookup()
    await render("/enter?choose=1&handle=alice", true)
    expect(input().value).toBe("alice")
    expect(h.lookup).toHaveBeenCalledTimes(2)
    expect(login().disabled).toBe(false)
  })

  it("under StrictMode only the replayed probe shows the screen", async () => {
    const { GateCancelledError } = await import("../src/features/identity/ceremonyGate")
    h.enterWithPasskey.mockImplementation(async (_w, _c, _h, options: EnterOptions) => {
      await new Promise((r) => setTimeout(r, 0))
      if (options.signal?.aborted) throw new GateCancelledError()
      return { entered: false, reason: "ceremony-required" }
    })
    await render("/enter", true)
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    const [first, second] = h.enterWithPasskey.mock.calls.map((c) => (c[3] as EnterOptions).signal!)
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)
    expect(container.querySelectorAll('[data-testid="sign-in-start"]')).toHaveLength(1)
  })
})

describe("the field", () => {
  it("a pause in typing reads the tag; Login enables only while the field still holds the resolved tag", async () => {
    await arrive()
    resolvedLookup("bob")
    await type("@Bob")
    expect(h.lookup).not.toHaveBeenCalled()
    await blur()
    expect(h.lookup).toHaveBeenCalledWith("bob", expect.anything())
    expect(login().disabled).toBe(false)
    await type("bobb")
    // The edit disables Login at once, before any read.
    expect(login().disabled).toBe(true)
    expect(h.lookup).toHaveBeenCalledTimes(1)
    resolvedLookup("bobb")
    await blur()
    expect(h.lookup).toHaveBeenLastCalledWith("bobb", expect.anything())
    expect(login().disabled).toBe(false)
  })

  it("Enter submits only once the tag resolved, and then pins exactly once", async () => {
    await arrive()
    await type("bob")
    await submitField()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    resolvedLookup("bob")
    await blur()
    h.enterWithPasskey.mockResolvedValueOnce(named("bob"))
    await submitField()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    expect(h.enterWithPasskey.mock.calls.at(-1)![2]).toBe("bob")
  })

  it("a tag the list shows is not read: the notice names the row, Login stays off, an edit reads again", async () => {
    remember("cred-alice", "alice")
    await arrive()
    await type("@Alice")
    await blur()
    expect(h.lookup).not.toHaveBeenCalled()
    expect(byTestId("by-tag-listed")?.textContent).toBe("alice")
    expect(login().disabled).toBe(true)
    expect(failures()).toEqual([])
    // Leaving the field again asks nothing; the row is live.
    await blur()
    expect(h.lookup).not.toHaveBeenCalled()
    expect(byTestId("sign-in-account")).toHaveProperty("disabled", false)

    resolvedLookup("alicia")
    await type("alicia")
    await blur()
    expect(byTestId("by-tag-listed")).toBeNull()
    expect(h.lookup).toHaveBeenCalledWith("alicia", expect.anything())
    expect(login().disabled).toBe(false)
  })

  it("an arrival handle the list shows seeds the field with that notice and no read", async () => {
    remember("cred-alice", "alice")
    await arrive("/enter?handle=alice")
    expect(input().value).toBe("alice")
    expect(h.lookup).not.toHaveBeenCalled()
    expect(byTestId("by-tag-listed")).not.toBeNull()
    expect(login().disabled).toBe(true)
  })

  it("an invalid tag runs no read", async () => {
    await arrive()
    await type("a b")
    await blur()
    expect(h.lookup).not.toHaveBeenCalled()
    expect(login().disabled).toBe(true)
  })

  it.each([
    ["notFound", "bytag_tag_not_found"],
    ["staleRollup", "bytag_stale_rollup"],
    ["noKeyInstalled", "bytag_no_key_installed"],
    ["unreadable", "bytag_key_unreadable"],
  ] as const)(
    "%s stays inline with the field editable and Show passkeys live",
    async (kind, code) => {
      await arrive()
      h.lookup.mockResolvedValueOnce({ kind, account: `0x${"11".repeat(20)}`, complete: true })
      await type("alice")
      await blur()
      expect(byTestId(`by-tag-${kind}`)?.textContent).toBe("alice")
      expect(login().disabled).toBe(true)
      expect(byTestId("sign-in-show-passkeys")).toHaveProperty("disabled", false)
      expect(refused()).toBeNull()
      expect(failures().at(-1)).toEqual(["enter:by-tag", code])
      // Editing clears the notice; the next read is the new tag's.
      await type("bob")
      expect(byTestId(`by-tag-${kind}`)).toBeNull()
    },
  )

  it("a pause in typing reads the tag without leaving the field", async () => {
    const { RESOLVE_DEBOUNCE_MS } = await import("../src/features/onboarding/EnterAppScreen")
    await arrive()
    resolvedLookup("bob")
    await type("bob")
    expect(h.lookup).not.toHaveBeenCalled()
    await act(async () => new Promise((r) => setTimeout(r, RESOLVE_DEBOUNCE_MS + 20)))
    await flush()
    expect(h.lookup).toHaveBeenCalledWith("bob", expect.anything())
    expect(login().disabled).toBe(false)
  })

  it("a read that could not reach the network says so inline and reports nothing; leaving the field asks again", async () => {
    await arrive()
    h.lookup.mockRejectedValueOnce(new Error("rpc down"))
    await type("alice")
    await blur()
    expect(byTestId("by-tag-lookupFailed")).not.toBeNull()
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(failures().at(-1)).toEqual(["enter:by-tag", "bytag_lookup_failed"])
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    resolvedLookup("alice")
    await blur()
    expect(h.lookup).toHaveBeenCalledTimes(2)
    expect(byTestId("by-tag-lookupFailed")).toBeNull()
    expect(login().disabled).toBe(false)
  })

  it.each([
    ["reserved", "reserved", "true"],
    ["blocked-reserved", "reserved", "true"],
    ["available", "notFound", "false"],
    ["unknown", "notFound", "false"],
  ])(
    "a tag the network has no account for, with the name %s, reads as %s",
    async (status, kind, chooserFirst) => {
      h.probe.mockResolvedValue({ status, grantValid: false, grantBound: false })
      await arrive()
      await type("alice")
      await blur()
      expect(byTestId(`by-tag-${kind}`)?.textContent).toBe("alice")
      expect(screen()!.dataset.chooserFirst).toBe(chooserFirst)
      expect(screen()!.dataset.resolving).toBe("false")
    },
  )

  it("only the current read lands: an older answer neither repopulates the field nor overwrites a newer notice", async () => {
    await arrive()
    let releaseA!: (value: unknown) => void
    h.lookup.mockReturnValueOnce(new Promise((r) => (releaseA = r)))
    await type("alice")
    await blur()
    expect(screen()!.dataset.resolving).toBe("true")
    h.lookup.mockResolvedValueOnce({ kind: "notFound" })
    await type("alicex")
    await blur()
    expect(byTestId("by-tag-notFound")?.textContent).toBe("alicex")
    await act(async () =>
      releaseA({ kind: "resolved", tag: "alice", candidate: CANDIDATE, l2Address: L2 }),
    )
    await flush()
    expect(login().disabled).toBe(true)
    expect(byTestId("by-tag-notFound")).not.toBeNull()
  })

  it("a blur after a resolved tag reads nothing again, so the click that blurred the field lands", async () => {
    await reachFound()
    await blur()
    expect(h.lookup).toHaveBeenCalledTimes(1)
    expect(login().disabled).toBe(false)
  })
})

describe("the remembered accounts", () => {
  it("a row's miss on both slots is the plain mismatch, never the wrong-key card: no read proved the key sole", async () => {
    remember("cred-alice", "alice")
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: "cred-alice",
      addresses: [OTHER, `0x${"ce".repeat(32)}`],
      observed: { credentialId: "cred-alice", attachment: "platform" },
    })
    await click("sign-in-account")
    expect(refused()?.dataset.reason).toBe("PasskeyKeyMismatchError")
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_key_mismatch"])
  })

  it("Back forgets the row's tag: Show passkeys then runs the open chooser unnamed", async () => {
    remember("cred-alice", "alice")
    await arrive()
    h.enterWithPasskey.mockRejectedValueOnce(closed())
    await click("sign-in-account")
    expect(h.enterWithPasskey.mock.calls.at(-1)![2]).toBe("alice")
    await click("enter-back")
    h.enterWithPasskey.mockResolvedValueOnce(named("bob"))
    await click("sign-in-show-passkeys")
    expect(h.enterWithPasskey.mock.calls.at(-1)![2]).toBeUndefined()
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a row signs in on one click, pinned to its record, with no read", async () => {
    remember("cred-alice", "alice")
    await arrive()
    expect(byTestId("sign-in-account")?.dataset.tag).toBe("alice")
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("sign-in-account")
    expect(h.lookup).not.toHaveBeenCalled()
    expect(h.enterWithPasskey).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      "alice",
      expect.objectContaining({
        hints: { credentialId: "cred-alice", pubkeyHex: "ab".repeat(64) },
        restoreCache: false,
      }),
    )
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("every remembered account is listed, newest first; ?avoid hides one", async () => {
    remember("cred-a", "alice", 1)
    remember("cred-b", "bob", 2)
    remember("cred-c", "carol", 3)
    await render("/enter?choose=1&avoid=cred-b")
    expect(
      Array.from(
        container.querySelectorAll('[data-testid="sign-in-account"]'),
        (row) => (row as HTMLElement).dataset.tag,
      ),
    ).toEqual(["carol", "alice"])
  })

  it("a read that lands after a row click changes nothing, and the pinned entry settles", async () => {
    remember("cred-alice", "alice")
    await arrive()
    let release!: (value: unknown) => void
    h.lookup.mockReturnValueOnce(new Promise((r) => (release = r)))
    await type("zed")
    await blur()
    let finish!: (value: unknown) => void
    h.enterWithPasskey.mockReturnValueOnce(new Promise((r) => (finish = r)))
    await click("sign-in-account")
    const signal = lastOptions().signal!
    await act(async () =>
      release({ kind: "resolved", tag: "zed", candidate: CANDIDATE, l2Address: L2 }),
    )
    await flush()
    expect(signal.aborted).toBe(false)
    await act(async () => finish(named()))
    await flush()
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a row whose credential answers and adopts another claim reaches the confirm step with its tag", async () => {
    remember("cred-alice", "alice")
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: {},
      account: { getAddress: () => ({ toString: () => L2 }) },
    })
    await click("sign-in-account")
    expect(byTestId("confirm-tag")?.dataset.handle).toBe("alice")
  })
})

describe("Show passkeys and the cancels", () => {
  it("a write that failed after the chooser's answer committed shows the re-probe card, no Back", async () => {
    await arrive()
    h.enterWithPasskey.mockRejectedValueOnce(
      Object.assign(new Error("disk full"), { committed: true }),
    )
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("error")
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    expect(byTestId("enter-back")).toBeNull()
    expect(h.showReportableError).toHaveBeenCalledTimes(1)
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("enter-retry")
    expect(lastOptions().cacheOnly).toBe(true)
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("Show passkeys runs the open chooser on the tap, past the cache", async () => {
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("sign-in-show-passkeys")
    expect(lastOptions()).toMatchObject({ chooser: true, restoreCache: false })
    expect(lastOptions().hints).toBeUndefined()
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("the screen's close hands back to the campaign, signed out of it", async () => {
    await arrive()
    await click("sign-in-close")
    expect(leftForCampaign()).toBe(true)
  })

  it("cancel during a sign-in ends the attempt and the operation", async () => {
    await reachFound()
    let attempt: AbortSignal | undefined
    h.enterWithPasskey.mockImplementationOnce(async (_w, _c, _h, options: EnterOptions) => {
      attempt = (await options.gate()).signal
      await new Promise(() => {})
    })
    await click("sign-in-login")
    expect(screen()).toBeNull()
    expect(byTestId("spinner")).not.toBeNull()
    const signal = lastOptions().signal!
    expect(attempt?.aborted).toBe(false)
    await click("spinner-cancel")
    expect(attempt?.aborted).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(leftForCampaign()).toBe(true)
  })
})

describe("the endpoint editor", () => {
  it("opens beside the screen; closing it keeps the screen, with no sign-in and no cancel", async () => {
    await arrive()
    await click("sign-in-endpoints")
    expect(byTestId("endpoints-modal")).not.toBeNull()
    expect(screen()).not.toBeNull()
    expect(screen()!.contains(byTestId("endpoints-modal"))).toBe(false)
    await click("endpoints-close")
    expect(byTestId("endpoints-modal")).toBeNull()
    expect(screen()).not.toBeNull()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    expect(h.navigate).not.toHaveBeenCalled()
    expect(leftForCampaign()).toBe(false)
  })

  it("is offered under the desktop bridge too", async () => {
    h.bridge = { l1SubmitPath: "/desktop/l1-submit" }
    await arrive()
    await click("sign-in-endpoints")
    expect(byTestId("endpoints-modal")).not.toBeNull()
  })

  it("a running sign-in holds the endpoints pill; the screen and a refusal card do not", async () => {
    await reachFound()
    const { endpointsHeld } = await import("../src/ui/endpointsHold")
    expect(endpointsHeld()).toBe(false)
    let refuse!: (err: unknown) => void
    h.enterWithPasskey.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (refuse = reject)),
    )
    await click("sign-in-login")
    expect(byTestId("spinner")).not.toBeNull()
    expect(endpointsHeld()).toBe(true)
    await act(async () => refuse(closed()))
    await flush()
    expect(refused()).not.toBeNull()
    expect(endpointsHeld()).toBe(false)
  })

  it("the second prompt's approve step holds the endpoints pill too", async () => {
    await reachFound()
    const { endpointsHeld } = await import("../src/ui/endpointsHold")
    h.enterWithPasskey.mockImplementationOnce(async (_w, _c, _h, options: EnterOptions) => {
      const { signal } = await options.gate()
      const again = options.gate as (o: { again: AbortSignal }) => Promise<unknown>
      await again({ again: signal })
      await new Promise(() => {})
    })
    await click("sign-in-login")
    expect(byTestId("approve-again")).not.toBeNull()
    expect(endpointsHeld()).toBe(true)
  })
})

describe("the pinned sign-in", () => {
  it("a write that failed after the pinned answer committed shows the re-probe card, no Back", async () => {
    await reachFound()
    h.enterWithPasskey.mockRejectedValueOnce(
      Object.assign(new Error("disk full"), { committed: true }),
    )
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("error")
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-back")).toBeNull()
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("enter-retry")
    expect(lastOptions().cacheOnly).toBe(true)
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("Login pins the found credential to the selected tag under the operation's signal, and enters", async () => {
    await reachFound("/enter?handle=alice")
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("sign-in-login")
    expect(h.enterWithPasskey).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      "alice",
      expect.objectContaining({ hints: CANDIDATE, signal: expect.any(AbortSignal) }),
    )
    expect(lastOptions().signal?.aborted).toBe(false)
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(JSON.parse(walletStorage.getItem("webwallet.identity")!)).toMatchObject({
      handle: "alice",
      address: L2,
    })
  })

  it("a typed tag is the one the pinned entry names, not the URL's", async () => {
    await arrive("/enter?handle=alice")
    resolvedLookup("bob")
    await type("bob")
    await blur()
    h.enterWithPasskey.mockResolvedValueOnce(named("bob"))
    await click("sign-in-login")
    expect(h.enterWithPasskey.mock.calls.at(-1)![2]).toBe("bob")
  })

  it("a reservation the pinned entry's tag names is picked back up at once, never under the URL's", async () => {
    const { namehash } = await import("viem/ens")
    const { loadWalletIdentity } = await import("../src/features/identity/walletIdentity")
    await arrive("/enter?handle=alice")
    resolvedLookup("bob")
    await type("bob")
    await blur()
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    h.reservedNameHashes.mockResolvedValueOnce([
      namehash("alice.zk.money"),
      namehash("bob.zk.money"),
    ])
    await click("sign-in-login")
    // The claim server replays the claim; the record, its terms and the pending identity are
    // written here, and the wallet opens on the activation sheet.
    expect(h.claimTag).toHaveBeenCalledTimes(1)
    expect(h.claimTag.mock.calls[0]![0]).toBe("bob")
    expect(h.saveTerms).toHaveBeenCalledWith(expect.objectContaining({ tag: "bob" }))
    expect(h.openActivationPrompt).toHaveBeenCalled()
    expect(loadWalletIdentity()).toMatchObject({ handle: "bob", address: L2, pending: true })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(refused()).toBeNull()
    expect(navigatedTo("/claim/alice?resume=1")).toBe(false)
  })

  it("a reservation the passkey's own name matches is picked back up with nothing typed", async () => {
    const { namehash } = await import("viem/ens")
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce({ ...nameless(), userHandle: "carol" })
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    h.reservedNameHashes.mockResolvedValueOnce([namehash("carol.zk.money")])
    await click("sign-in-show-passkeys")
    expect(byTestId("confirm-tag")).toBeNull()
    expect(h.claimTag.mock.calls[0]![0]).toBe("carol")
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a passkey name no reservation hashes to still asks for the tag", async () => {
    const { namehash } = await import("viem/ens")
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce({ ...nameless(), userHandle: "carol" })
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    h.reservedNameHashes.mockResolvedValueOnce([namehash("dave.zk.money")])
    await click("sign-in-show-passkeys")
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(byTestId("confirm-tag")).not.toBeNull()
  })

  it("the passkey's own name names the reservation when the arrival tag names none", async () => {
    // The arrival tag rode a sign-in link (?handle), which names the tag the waitlist knew, not
    // necessarily the one the user reserved. It hashes to no held reservation; the passkey's own
    // name, which does, still names it, the way the registered path already falls through to it.
    const { namehash } = await import("viem/ens")
    await arrive("/enter?handle=alice")
    h.enterWithPasskey.mockResolvedValueOnce({ ...nameless(), userHandle: "carol" })
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    h.reservedNameHashes.mockResolvedValueOnce([namehash("carol.zk.money")])
    await click("sign-in-show-passkeys")
    expect(byTestId("confirm-tag")).toBeNull()
    expect(h.claimTag.mock.calls[0]?.[0]).toBe("carol")
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a granted key resumes the reservation its passkey names rather than the granted card", async () => {
    // A grant (the gate off answers granted too) is not a reason to send a passkey that already
    // holds a reservation back to the signup: the name it carries reopens the wallet in place.
    const { namehash } = await import("viem/ens")
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce({ ...nameless(), userHandle: "carol" })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: "granted" }),
    })
    h.reservedNameHashes.mockResolvedValueOnce([namehash("carol.zk.money")])
    await click("sign-in-show-passkeys")
    expect(byTestId("enter-refused")).toBeNull()
    expect(byTestId("confirm-tag")).toBeNull()
    expect(h.claimTag.mock.calls[0]?.[0]).toBe("carol")
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a granted key with no reservation its passkey names still shows the granted card", async () => {
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce({ ...nameless(), userHandle: "carol" })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: "granted" }),
    })
    h.reservedNameHashes.mockResolvedValueOnce([])
    await click("sign-in-show-passkeys")
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(byTestId("enter-refused")).not.toBeNull()
  })

  it("a granted key whose reservation lookup fails yields to the granted card, not a network error", async () => {
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce({ ...nameless(), userHandle: "carol" })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: "granted" }),
    })
    h.reservedNameHashes.mockRejectedValueOnce(new Error("account-service down"))
    await click("sign-in-show-passkeys")
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(byTestId("enter-refused")).not.toBeNull()
    // The granted card, not the committed network error (whose way on is the enter-continue pill).
    expect(byTestId("enter-continue")).toBeNull()
  })

  it("a reserved recovery that commits reloads carrying the passkey's name", async () => {
    // The unclaimed recovery adopts and switches the session, so the screen reloads to shed the
    // stale record stores; the passkey's own name must ride that reload, or the re-entry (recovered
    // from the cache, which carries no name) lands on the confirm-tag modal instead of the wallet.
    const { setActiveStorageId } = await import("../src/platform/storage/activeStorage")
    const { walletStorage } = await import("../src/platform/storage/walletStorage")
    setActiveStorageId("storage-a")
    await walletStorage.flush()
    await arrive()
    h.enterWithPasskey.mockImplementationOnce(async () => {
      setActiveStorageId("storage-b")
      await walletStorage.flush()
      return { ...nameless(), userHandle: "carol" }
    })
    await click("sign-in-show-passkeys")
    expect(leaveAssign).toHaveBeenCalled()
    expect(leaveAssign.mock.calls.at(-1)?.[0]).toContain("handle=carol")
  })

  it("a reservation whose claim cannot be replayed keeps the card whose way on is the signup", async () => {
    const { namehash } = await import("viem/ens")
    await arrive("/enter?handle=alice")
    resolvedLookup("bob")
    await type("bob")
    await blur()
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    h.reservedNameHashes.mockResolvedValueOnce([namehash("bob.zk.money")])
    h.claimTag.mockRejectedValueOnce(new Error("claim ledger unavailable"))
    await click("sign-in-login")
    expect(byTestId("enter-refused")?.textContent).toContain("@bob")
    await click("enter-continue")
    expect(h.navigate).toHaveBeenCalledWith("/claim/bob?resume=1", { replace: true })
  })

  it("returns the bound grant's passkey to its unfinished claim", async () => {
    h.nameGrantToken.mockReturnValue("bound-token")
    await reachFound("/enter?handle=alice&bound=1")
    h.boundNameGrantOwner.mockResolvedValue(true)
    h.enterWithPasskey.mockResolvedValueOnce(nameless())

    await click("sign-in-login")

    expect(lastOptions()).toMatchObject({ grantToken: "bound-token" })
    expect(h.boundNameGrantOwner).toHaveBeenCalledWith(
      expect.any(String),
      "bound-token",
      expect.objectContaining({ address: nameless().bootstrap.address }),
      expect.any(Object),
    )
    expect(h.navigate).toHaveBeenCalledWith("/claim/alice?resume=1", {
      replace: true,
      state: { boundGrantOwner: "alice" },
    })
    expect(h.reservedNameHashes).not.toHaveBeenCalled()
  })

  it("keeps a different passkey out of the bound grant's signup", async () => {
    h.nameGrantToken.mockReturnValue("bound-token")
    await reachFound("/enter?handle=alice&bound=1")
    h.enterWithPasskey.mockResolvedValueOnce(nameless())

    await click("sign-in-login")

    expect(refused()?.dataset.reason).toBe("DifferentPasskeyError")
    expect(container.textContent).toContain("cannot continue @alice's grant")
    expect(navigatedTo("/claim/alice?resume=1")).toBe(false)
    expect(h.reservedNameHashes).not.toHaveBeenCalled()
  })

  it("retries a bound grant owner-check outage without another passkey prompt", async () => {
    h.nameGrantToken.mockReturnValue("bound-token")
    await reachFound("/enter?handle=alice&bound=1")
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.boundNameGrantOwner.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(true)

    await click("sign-in-login")

    expect(refused()?.dataset.reason).toBe("error")
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-passkey")).toBeNull()
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(navigatedTo("/claim/alice?resume=1")).toBe(false)

    const attempts = h.enterWithPasskey.mock.calls.length
    await click("enter-retry")
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(attempts)
    expect(h.boundNameGrantOwner).toHaveBeenCalledTimes(2)
    expect(h.navigate).toHaveBeenCalledWith("/claim/alice?resume=1", {
      replace: true,
      state: { boundGrantOwner: "alice" },
    })
  })

  it("a pinned entry whose reservation lookup timed out is the network card, with Back", async () => {
    const { AccountServiceTimeoutError } = await import("@obsidion/front-core")
    await reachFound()
    h.enterWithPasskey.mockRejectedValueOnce(
      new AccountServiceTimeoutError("/domain/reservation", 15_000),
    )
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("error")
    expect(failures()).not.toContainEqual(["enter:by-tag", "passkey_not_on_device"])
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
  })

  it("a pinned key mismatch offers Back and the cancel, with no retry", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: CANDIDATE.credentialId,
      addresses: [OTHER],
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("PasskeyKeyMismatchError")
    expect(container.textContent).toContain("Go back and check the tag")
    // The way to the registered passkey is named: the phone over QR, or the key.
    expect(container.textContent).toContain("scan the QR code")
    expect(byTestId("enter-retry")).toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_key_mismatch"])
  })

  it("on a laptop, this computer's copy of the account's one key missing on both slots is the wrong-key card, with its own code", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: CANDIDATE.credentialId,
      addresses: [OTHER, `0x${"ce".repeat(32)}`],
      observed: { credentialId: CANDIDATE.credentialId, attachment: "platform" },
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(container.textContent).toMatch(/wrong key/i)
    expect(container.textContent).toContain("scan the QR code")
    expect(byTestId("enter-retry")).toBeNull()
    expect(byTestId("enter-show-passkeys")).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(failures().at(-1)).toEqual(["enter:by-tag", "bytag_local_copy_wrong_key"])
  })

  it("the same miss stays the plain mismatch when the account holds more keys than the one pinned", async () => {
    resolvedLookup("alice", true)
    await arrive("/enter?handle=alice")
    expect(login().disabled).toBe(false)
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: CANDIDATE.credentialId,
      addresses: [OTHER, `0x${"ce".repeat(32)}`],
      observed: { credentialId: CANDIDATE.credentialId, attachment: "platform" },
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("PasskeyKeyMismatchError")
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_key_mismatch"])
  })

  it.each([
    ["that closed", closed],
    ["with no credential", () => new Error("Passkey assertion returned no credential")],
  ])(
    "a pinned prompt %s names the device with no retry; Back returns to a blank screen",
    async (_name, missing) => {
      onPhone()
      await reachFound()
      h.enterWithPasskey.mockRejectedValueOnce(missing())
      await click("sign-in-login")
      expect(refused()?.dataset.reason).toBe("PasskeyNotOnDeviceError")
      expect(container.textContent).toContain("asked for @alice's passkey")
      expect(container.textContent).toContain("open zk.money in your phone's default browser")
      // The card's whole text, causes included, points at what the card offers: Back, then the screen.
      expect(container.textContent).not.toMatch(/in the prompt/i)
      expect(container.textContent).toContain("Wait, then go back and try again")
      expect(container.textContent).toContain("Go back and check the tag")
      expect(byTestId("enter-retry")).toBeNull()
      expect(byTestId("enter-back")).not.toBeNull()
      expect(byTestId("enter-cancel")).not.toBeNull()
      expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_not_on_device"])
      expect(h.showReportableError).not.toHaveBeenCalled()

      await click("enter-back")
      expect(refused()).toBeNull()
      expect(screen()).not.toBeNull()
      expect(input().value).toBe("")
      // No reseed and no read: the arrival handle was consumed on the first showing.
      expect(h.lookup).toHaveBeenCalledTimes(1)
      expect(h.navigate).not.toHaveBeenCalled()
    },
  )

  it("an unconfirmed record keeps a retry that pins again with no second read", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: CANDIDATE.credentialId,
      addresses: [OTHER, L2],
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("RegistryUnanchoredError")
    expect(container.textContent).toContain("couldn't be confirmed")
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(failures().at(-1)).toEqual(["enter:by-tag", "registry_unanchored"])

    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("enter-retry")
    expect(h.lookup).toHaveBeenCalledTimes(1)
    expect(lastOptions().hints).toEqual(CANDIDATE)
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a stored record that no longer reproduces is the same key mismatch", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: CANDIDATE.credentialId,
      addresses: [L2],
      storedAddressMismatch: true,
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("PasskeyKeyMismatchError")
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_key_mismatch"])
  })

  it("a stored record that no longer reproduces keeps its verdict: the weaker one keeps its retry", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: CANDIDATE.credentialId,
      addresses: [OTHER],
      storedAddressMismatch: true,
      verdict: "not-reproduced",
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-show-passkeys")).toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_key_mismatch"])
  })

  it("a certain wrong key offers Show passkeys and no retry; Show passkeys runs the chooser", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "unknown",
      credentialId: CANDIDATE.credentialId,
      addresses: [OTHER],
      storedAddressMismatch: true,
      verdict: "wrong-key",
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(container.textContent).toMatch(/wrong key/i)
    expect(byTestId("enter-retry")).toBeNull()
    expect(byTestId("enter-show-passkeys")).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("enter-show-passkeys")
    expect(lastOptions()).toMatchObject({ chooser: true, restoreCache: false })
  })

  it("a policy refusal on the pinned path keeps its retry and Back", async () => {
    const { PhoneRequiredError } = await policyErrors()
    await reachFound()
    h.enterWithPasskey.mockRejectedValueOnce(new PhoneRequiredError())
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("PhoneRequiredError")
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_wrong_device"])
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("enter-retry")
    expect(h.lookup).toHaveBeenCalledTimes(1)
    expect(lastOptions().hints).toEqual(CANDIDATE)
  })

  it("a passkey that answered but is not the tag's keeps its row, Back, and is counted as the wrong credential", async () => {
    await reachFound()
    const { PasskeyMismatchError } = await import("../src/features/onboarding/oxideOnboarding")
    h.enterWithPasskey.mockRejectedValueOnce(new PasskeyMismatchError())
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("PasskeyMismatchError")
    expect(container.textContent).toContain("opens a different account")
    expect(byTestId("enter-retry")).toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(failures().at(-1)).toEqual(["enter:by-tag", "passkey_wrong_credential"])
  })

  it("a confirm result shows the confirm step defaulting to the selected tag", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: {},
      account: { getAddress: () => ({ toString: () => L2 }) },
    })
    await click("sign-in-login")
    expect(screen()).toBeNull()
    expect(byTestId("confirm-tag")?.dataset.handle).toBe("alice")

    h.confirmTag.mockReturnValueOnce({ handle: "alice", address: L2 })
    await click("confirm-tag-submit")
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(owedClaimNotices()[L2]).toMatchObject({ tag: "alice" })
  })

  it("closing the confirm modal after a pinned entry cancels through the shared cancel", async () => {
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: {},
      account: { getAddress: () => ({ toString: () => L2 }) },
    })
    await click("sign-in-login")
    const signal = lastOptions().signal!
    await click("confirm-tag-close")
    expect(signal.aborted).toBe(true)
    expect(leftForCampaign()).toBe(true)
  })

  it("Back ends the pinned attempt behind its prompt and returns to the screen", async () => {
    await reachFound()
    let attempt: AbortSignal | undefined
    h.enterWithPasskey.mockImplementationOnce(async (_w, _c, _h, options: EnterOptions) => {
      attempt = (await options.gate()).signal
      throw closed()
    })
    await click("sign-in-login")
    expect(refused()?.dataset.reason).toBe("PasskeyNotOnDeviceError")
    await click("enter-back")
    expect(attempt?.aborted).toBe(true)
    expect(refused()).toBeNull()
    expect(screen()).not.toBeNull()
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it("Back from the confirm step returns to the screen; a row still enters from the matching cache", async () => {
    remember("cred-alice", "alice")
    await arrive()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: {},
      account: { getAddress: () => ({ toString: () => L2 }) },
    })
    await click("sign-in-account")
    expect(byTestId("confirm-tag")).not.toBeNull()
    await click("confirm-back")
    expect(byTestId("confirm-tag")).toBeNull()
    expect(screen()).not.toBeNull()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    // The hinted path carries no chooser flag: a cache for this credential may answer, with no prompt.
    h.enterWithPasskey.mockResolvedValueOnce(named())
    await click("sign-in-account")
    expect(lastOptions().chooser).toBeUndefined()
    expect(lastOptions().hints).toEqual({ credentialId: "cred-alice", pubkeyHex: "ab".repeat(64) })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })
})

describe("the completion writes", () => {
  const CREDENTIAL = "cred-alice"

  async function seedSession() {
    const { setActiveCredentialId, setActiveStorageId } = await import(
      "../src/platform/storage/activeStorage"
    )
    setActiveStorageId("storage-a")
    setActiveCredentialId(CREDENTIAL)
    walletStorage.setItem(
      MAP_KEY,
      JSON.stringify({
        version: 1,
        entries: {
          [CREDENTIAL]: {
            credentialId: CREDENTIAL,
            rpId: "localhost",
            l2Address: L2,
            pubkey: "ab".repeat(64),
            isMskRoot: true,
            createdAt: 1,
          },
        },
      }),
    )
  }

  it("an entry reported after a cancel writes no identity and navigates nowhere", async () => {
    await seedSession()
    const { usertagFor } = await import("../src/platform/auth/WebPasskeyIdentityMap")
    let release!: (value: unknown) => void
    await reachFound()
    h.enterWithPasskey.mockReturnValueOnce(new Promise((r) => (release = r)))
    await click("sign-in-login")
    await click("spinner-cancel")
    expect(leftForCampaign()).toBe(true)
    await act(async () => release(named()))
    await flush()
    // The account it names is committed; the identity record, the passkey hint and the move into
    // the wallet were still the attempt's, and stop at its cancel.
    expect(walletStorage.getItem("webwallet.identity")).toBeNull()
    expect(usertagFor("localhost", CREDENTIAL)).toBeUndefined()
    expect(navigatedTo("/")).toBe(false)
  })

  it("a cancel while the waitlist verify is pending caches, emits and shows nothing", async () => {
    let release!: (value: unknown) => void
    fetchMock.mockReturnValueOnce(new Promise((r) => (release = r)))
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    await click("sign-in-login")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await click("spinner-cancel")
    h.fireEvent.mockClear()
    await act(async () =>
      release({ ok: true, status: 200, json: async () => ({ status: "granted" }) }),
    )
    await flush()
    expect(walletStorage.getItem("webwallet.admission")).toBeNull()
    expect(h.fireEvent).not.toHaveBeenCalledWith("admission_checked", expect.anything())
    expect(refused()).toBeNull()
    expect(navigatedTo("/")).toBe(false)
    expect(owedClaimNotices()).toEqual({})
  })

  it("a late verify failure after a cancel opens no error modal", async () => {
    let fail!: (err: unknown) => void
    fetchMock.mockReturnValueOnce(new Promise((_r, reject) => (fail = reject)))
    await reachFound()
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    await click("sign-in-login")
    await click("spinner-cancel")
    h.fireEvent.mockClear()
    await act(async () => fail(new Error("offline")))
    await flush()
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(h.fireEvent).not.toHaveBeenCalled()
    expect(refused()).toBeNull()
  })
})

describe("the reload guard", () => {
  const assign = vi.fn()
  const switchesTo = (id: string, result: unknown) =>
    h.enterWithPasskey.mockImplementationOnce(async () => {
      await walletStorage.commitItem("webwallet.storageId", id)
      return result
    })

  beforeEach(async () => {
    assign.mockClear()
    vi.stubGlobal("location", { assign, origin: "https://wallet.test" })
    await walletStorage.commitItem("webwallet.storageId", "storage-a")
  })

  it("a pinned entry that switched accounts reloads with the selected tag and strict=1, keeping next", async () => {
    await arrive("/enter?handle=alice&next=%2Frequest%23gift")
    resolvedLookup("bob")
    await type("bob")
    await blur()
    switchesTo("storage-b", named("bob"))
    await click("sign-in-login")
    expect(assign).toHaveBeenCalledWith("/enter?handle=bob&strict=1&next=%2Frequest%23gift")
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it("the strict remount probes for a strict entry under a signal, and a wrong remembered tag confirms", async () => {
    await walletStorage.commitItem("webwallet.storageId", "storage-b")
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: {},
      account: { getAddress: () => ({ toString: () => L2 }) },
    })
    await render("/enter?handle=bob&strict=1")
    expect(lastOptions().strictTag).toBe(true)
    expect(lastOptions().cacheOnly).toBe(true)
    expect(lastOptions().signal).toBeInstanceOf(AbortSignal)
    expect(lastOptions().hints).toBeUndefined()
    expect(assign).not.toHaveBeenCalled()
    expect(byTestId("confirm-tag")?.dataset.handle).toBe("bob")
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it("an ordinary entry that switched accounts reloads without strict, dropping the chooser flags", async () => {
    switchesTo("storage-b", named())
    await render("/enter?handle=alice")
    expect(assign).toHaveBeenCalledWith("/enter?handle=alice")

    act(() => root.unmount())
    root = createRoot(container)
    assign.mockClear()
    await walletStorage.commitItem("webwallet.storageId", "storage-a")
    await render("/enter?choose=1&avoid=cred-x")
    switchesTo("storage-b", named())
    await click("sign-in-show-passkeys")
    expect(assign).toHaveBeenCalledWith("/enter")
  })

  it("a cancel during the remounted probe aborts it, and an uncommitted answer after it shows nothing", async () => {
    await walletStorage.commitItem("webwallet.storageId", "storage-b")
    let release!: (value: unknown) => void
    h.enterWithPasskey.mockReturnValueOnce(new Promise((r) => (release = r)))
    await render("/enter?handle=bob&strict=1")
    const signal = lastOptions().signal!
    await click("spinner-cancel")
    expect(signal.aborted).toBe(true)
    expect(assign).toHaveBeenCalledWith("https://launch.test.invalid/?signedout=1")
    await act(async () => release({ entered: false, reason: "unknown" }))
    await flush()
    expect(refused()).toBeNull()
    expect(screen()).toBeNull()
    expect(failures()).toEqual([])
  })

  it("a switch that landed before a cancel still replaces the document", async () => {
    let release!: (value: unknown) => void
    h.enterWithPasskey.mockImplementationOnce(async () => {
      await walletStorage.commitItem("webwallet.storageId", "storage-b")
      return new Promise((r) => (release = r))
    })
    await render("/enter?handle=bob")
    await click("spinner-cancel")
    expect(assign).toHaveBeenCalledWith("https://launch.test.invalid/?signedout=1")
    await act(async () => release(named("bob")))
    await flush()
    expect(assign).toHaveBeenCalledWith("/enter?handle=bob")
  })

  it("under StrictMode only the replayed arrival enters", async () => {
    await walletStorage.commitItem("webwallet.storageId", "storage-b")
    const { GateCancelledError } = await import("../src/features/identity/ceremonyGate")
    // Screen wiring only: the stand-in ends the first arrival the way the real gate does when the
    // replay starts its own attempt (the gate's own suite pins that).
    h.enterWithPasskey.mockImplementation(async (_w, _c, _h, options: EnterOptions) => {
      await new Promise((r) => setTimeout(r, 0))
      if (options.signal?.aborted) throw new GateCancelledError()
      return named("bob")
    })
    await render("/enter?handle=bob&strict=1", true)
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    const [first, second] = h.enterWithPasskey.mock.calls.map((c) => (c[3] as EnterOptions).signal!)
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)
    expect(h.navigate.mock.calls.filter((c) => c[0] === "/")).toHaveLength(1)
    expect(JSON.parse(walletStorage.getItem("webwallet.identity")!)).toMatchObject({
      handle: "bob",
    })
  })
})

describe("the code table", () => {
  it("the by-tag codes are distinct; the annotation pins each to FailureCode at typecheck", async () => {
    const { BY_TAG_FAILURE_CODES } = await import("../src/features/onboarding/findPasskeyByTag")
    type FailureCode = import("../src/lib/analytics").FailureCode
    const codes: FailureCode[] = [...Object.values(BY_TAG_FAILURE_CODES), "passkey_prompt_closed"]
    expect(new Set(codes).size).toBe(codes.length)
  })
})
