/** Guards: the signup card's Continue, the committed card's exits, the reserved step's close. */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { namehash } from "viem/ens"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { assignReads } from "../../support/fakeReads"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
vi.setConfig({ testTimeout: 30_000 })

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  enterWithPasskey: vi.fn(),
  /** The payment link waiting in this browser, if any. */
  claimStash: undefined as string | undefined,
  showReportableError: vi.fn(),
  fireEvent: vi.fn(),
  saveIdentity: vi.fn(),
  accountServiceTestMode: false,
  reservedNameHashes: vi.fn(),
  boundNameGrantOwner: vi.fn(),
  confirmTag: vi.fn(),
  /** What the confirm modal stand-in submits; its seed when unset. */
  typedTag: undefined as string | undefined,
  /** What the auth service reports; `undefined` stands for no service built yet. */
  recordsStale: false as boolean | undefined,
  /** What the browser says about reaching a phone. */
  reach: "unknown" as "ok" | "no-hybrid" | "below-floor" | "unknown",
  lookup: vi.fn(),
  getOxideTuple: vi.fn(async () => ({})),
  recoverFromCache: vi.fn(async () => undefined),
}))

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => h.navigate,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@obsidion/front-core")>()
  return { ...core, openContractService: () => core.fixed("contractService", {}) }
})
vi.mock("../../../src/features/onboarding/oxideOnboarding", async () => {
  const { matchWireNameHash } = await import("@obsidion/front-core")
  return {
    enterWithPasskey: h.enterWithPasskey,
    confirmTag: h.confirmTag,
    // The real matching, without the module that drags the Aztec stack in.
    reservedTagMatch: (hashes: `0x${string}`[], ensDomain: string, handle: string) =>
      hashes.map((hash) => matchWireNameHash(handle, ensDomain, hash)).find(Boolean) ?? null,
    // The class the screen matches by instanceof; the real one drags the Aztec stack in.
    PasskeySetUnreadError: class PasskeySetUnreadError extends Error {
      name = "PasskeySetUnreadError"
    },
  }
})
vi.mock("../../../src/features/onboarding/findPasskeyByTag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/findPasskeyByTag")>()),
  lookupPasskeyByTag: h.lookup,
}))
vi.mock("../../../src/features/contacts/registryResolution", () => ({
  resolveSignInTag: vi.fn(),
  resolveSignInTagForCommit: vi.fn(),
}))
vi.mock("../../../src/features/onboarding/recoveryProbes", () => ({
  reservedNameHashes: h.reservedNameHashes,
  boundNameGrantOwner: h.boundNameGrantOwner,
}))
vi.mock("../../../src/session/account", async (importOriginal) => ({
  // The session's own identity view.
  ...(await importOriginal<typeof import("../../../src/session/account")>()),
  saveIdentity: h.saveIdentity,
}))
vi.mock("../../../src/features/paylink/claimStash", () => ({ peekClaimStash: () => h.claimStash }))
vi.mock("../../../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (f: string) => `id:${f}`,
}))
vi.mock("../../../src/features/paylink/sponsoredPaylink", () => ({ decodeLink: vi.fn() }))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
vi.mock("../../../src/lib/analytics", () => ({
  fireEvent: h.fireEvent,
  fireOnboardingEvent: vi.fn(),
  reportLanding: vi.fn(),
  failureCode: (e: unknown) => (e instanceof Error ? e.name : "err"),
}))
vi.mock("../../../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
// The sign-in cancel sits on this body and is handed the exit as the function itself.
vi.mock("../../../src/features/onboarding/OnboardingCard", () => ({
  OnboardingSpinnerBody: ({
    label,
    cancelLabel,
    onCancel,
  }: {
    label: string
    cancelLabel?: string
    onCancel?: () => void
  }) => (
    <div>
      {label}
      <button data-testid="spinner-cancel" onClick={onCancel}>
        {cancelLabel}
      </button>
    </div>
  ),
}))
// The card's two roles: the start role's actions and the confirm step's way back are what the
// screen wires, so the stand-in exposes them; the real card has its own suite.
vi.mock("../../../src/features/onboarding/steps/ConfirmTagModal/ConfirmTagModal", () => ({
  ConfirmTagModal: ({
    initialHandle,
    error,
    submitTitle,
    start,
    onConfirm,
    onShowPasskeys,
    onBack,
    onClose,
  }: {
    initialHandle?: string
    error?: string
    submitTitle?: string
    start?: import("../../../src/features/onboarding/steps/ConfirmTagModal/ConfirmTagModal").SignInStart
    onConfirm: (handle: string) => void
    onShowPasskeys?: () => void
    onBack?: () => void
    onClose: () => void
  }) => {
    if (start) {
      const live = start.prepared === "ready" && !start.busy
      return (
        <div data-testid="sign-in-start" data-prepared={start.prepared}>
          {start.candidates.map((c) => (
            <button
              key={c.credentialId}
              data-testid="sign-in-account"
              data-tag={c.usertag}
              disabled={!live}
              onClick={() => start.onCandidate(c)}
            />
          ))}
          {start.notice && <p data-testid={`by-tag-${start.notice.kind}`}>{start.notice.tag}</p>}
          <button
            data-testid="sign-in-login"
            disabled={!(start.submitReady && live)}
            onClick={() => onConfirm(start.value)}
          />
          <button data-testid="sign-in-show-passkeys" disabled={!live} onClick={onShowPasskeys} />
          <button data-testid="sign-in-close" onClick={onClose} />
        </div>
      )
    }
    return (
      <div
        data-testid="confirm-tag"
        data-handle={initialHandle}
        data-title={submitTitle ?? "Login"}
      >
        {error && <p data-testid="confirm-tag-error">{error}</p>}
        <button data-testid="confirm-back" onClick={onBack} />
        <button data-testid="confirm-tag-close" onClick={onClose} />
        <button
          data-testid="confirm-tag-submit"
          onClick={() => onConfirm(h.typedTag ?? initialHandle ?? "")}
        />
      </div>
    )
  },
}))
vi.mock("../../../src/features/onboarding/steps/InvitationStep/InvitationStep", () => ({
  InvitationStep: () => null,
}))
// The backdrop behind the modals mounts the boot splash, whose fade timer outlives the file.
vi.mock("../../../src/features/onboarding/steps/CreateWalletStep/CreateWalletStep", () => ({
  CreateWalletStep: () => null,
}))
vi.mock("@obsidion/web-ds", () => ({
  PrimaryGradientButton: ({
    title,
    testId,
    onClick,
  }: {
    title: string
    testId?: string
    onClick?: () => void
  }) => (
    <button data-testid={testId} onClick={onClick}>
      {title}
    </button>
  ),
  NumberedStepRow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TopNavIconButton: ({
    ariaLabel,
    testId,
    onClick,
  }: {
    ariaLabel?: string
    testId?: string
    onClick?: () => void
  }) => <button aria-label={ariaLabel} data-testid={testId} onClick={onClick} />,
}))

let container: HTMLDivElement
let root: Root

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))

type Entry = { pathname: string; search?: string; state?: unknown }

/**
 * The page as the active tab leaves it: its wallet up, and the anonymous session open. Every
 * session the screen's sign-in opens reads the same wallet.
 */
async function openPage() {
  // The page loads its device keys from what storage holds, as a boot does.
  const { walletStorage: saved } = await import("../../../src/platform/storage/walletStorage")
  await saved.flush()
  await (await import("../../support/page")).reloadDevice()
  const { activateTab } = await import("../../../src/platform/storage/activeTab")
  const { namespaceOf, switchSession } = await import("../../../src/session/session")
  const { pageSessionDeps } = await import("../../../src/app/sessionDeps")
  const { sessionPage } = await import("../../support/session")
  const { defaultConfig } = await import("../../support/page")
  const { openContractService } = await import("@obsidion/front-core")
  activateTab()
  const target = { kind: "pxe", identity: {}, bootStartedAt: 0, attempts: 1 } as never
  const auth = {
    probePhoneReach: async () => h.reach,
    recoverFromCache: h.recoverFromCache,
    recordsStale: () => h.recordsStale === true,
  }
  // The session of the account the device names, as boot opens it; its account tasks left out.
  // The suite's stand-in contract service (the front-core mock above), as the page would build it.
  const page = sessionPage(auth, {
    config: { ...defaultConfig, accountServiceTestMode: h.accountServiceTestMode },
    contractService: openContractService({} as never),
  })
  page.openWallet({} as never, target, async () => ({ wallet: true, node: {} } as never))
  page.wantWallet()
  await vi.waitFor(() => expect(page.wallet.get().status).toBe("ready"))
  assignReads(page.chain, { oxideTuple: h.getOxideTuple })
  const deps = pageSessionDeps(page)
  switchSession(namespaceOf(page.device.get().storageId), (namespace) => ({
    ...deps(namespace),
    signIn: undefined,
  }))
}

async function render(path: string | Entry = "/enter") {
  const { EnterAppScreen } = await import(
    "../../../src/features/onboarding/EnterAppScreen/EnterAppScreen"
  )
  await openPage()
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path as string]}>
        <EnterAppScreen />
      </MemoryRouter>,
    )
  })
  await flush()
}

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)

const leaveAssign = vi.fn()
/** The browser's address for `path`, as the screen and its refusal card read it. */
const addressed = (path: string) => {
  const url = new URL(path, "https://wallet.test")
  const { origin, host, href, pathname, search, hash } = url
  return { assign: leaveAssign, origin, host, href, pathname, search, hash }
}
/** The screen exited to where signing in starts. */
const leftForSignInStart = () =>
  h.navigate.mock.calls.some((call) => (call as unknown[])[0] === "/claim")

const L2 = `0x${"ac".repeat(32)}`
/** A recovered account with no registered name. */
const nameless = (address = L2) => ({
  entered: false,
  reason: "unclaimed",
  account: { getAddress: () => ({ toString: () => address }) },
  held: () => true,
  bootstrap: {
    address: "0xE0A0000000000000000000000000000000000001",
    signMessage: async () => "0xsig",
  },
  ensDomain: "zk.money",
})

const refused = () => container.querySelector<HTMLElement>('[data-testid="enter-refused"]')
const retry = () => container.querySelector<HTMLButtonElement>('[data-testid="enter-retry"]')!
const click = async (id: string) => {
  await act(async () => byTestId(id)!.click())
  await flush()
}

beforeEach(() => {
  vi.resetModules()
  h.navigate.mockClear()
  h.enterWithPasskey.mockReset()
  h.lookup.mockReset().mockResolvedValue({ kind: "notFound" })
  h.getOxideTuple.mockReset().mockResolvedValue({})
  h.recoverFromCache.mockReset().mockResolvedValue(undefined)
  h.showReportableError.mockClear()
  h.fireEvent.mockClear()
  h.saveIdentity.mockClear()
  h.reservedNameHashes.mockReset().mockResolvedValue([])
  h.boundNameGrantOwner.mockReset().mockResolvedValue(false)
  h.confirmTag.mockReset()
  h.typedTag = undefined
  h.claimStash = undefined
  h.recordsStale = false
  h.reach = "unknown"
  h.accountServiceTestMode = false
  leaveAssign.mockClear()
  vi.stubGlobal("location", addressed("/enter"))
  localStorage.clear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("EnterAppScreen refusals", () => {
  it("a nameless account with no reservation is sent to finish signing up, not into the wallet", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    await render()
    expect(h.reservedNameHashes).toHaveBeenCalledTimes(1)
    expect(refused()?.dataset.reason).toBe("GrantedRegistrationError")
    expect(h.saveIdentity).not.toHaveBeenCalled()
    expect(leftForSignInStart()).toBe(false)

    await act(async () => byTestId("enter-continue")!.click())
    await flush()
    expect(h.navigate).toHaveBeenCalledWith("/claim?resume=1", { replace: true })
  })
})

/**
 * A nameless account account-service holds a claim for: the signup continues as the tag the claim
 * names, confirmed on the same step a registered account uses.
 */
describe("EnterAppScreen reservation", () => {
  const hashOf = (tag: string) => namehash(`${tag}.zk.money`)
  const confirmStep = () => byTestId("confirm-tag")

  it("a lookup that fails after the commit is the network refusal; retry asks again, not the passkey", async () => {
    const { AccountServiceTimeoutError } = await import("@obsidion/front-core")
    await render("/enter?choose=1")
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockRejectedValueOnce(
      new AccountServiceTimeoutError("/domain/reservation", 15_000),
    )
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("error")
    // The account is committed: the way on is the signup it holds, never the screen.
    expect(byTestId("enter-back")).toBeNull()
    expect(byTestId("enter-continue")).not.toBeNull()
    expect(h.fireEvent).not.toHaveBeenCalledWith("action_failed", {
      action: "enter",
      code: "passkey_prompt_closed",
    })
    expect(leftForSignInStart()).toBe(false)

    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await act(async () => retry().click())
    await flush()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    expect(h.reservedNameHashes).toHaveBeenCalledTimes(2)
    expect(confirmStep()).not.toBeNull()
  })

  it("the committed refusal's way on continues the signup rather than starting one", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockRejectedValueOnce(new Error("offline"))
    await render()
    await act(async () => byTestId("enter-continue")!.click())
    await flush()
    expect(h.navigate).toHaveBeenCalledWith("/claim?resume=1", { replace: true })
  })

  it("closing the reserved step continues the signup, where the reserved tag is not refused", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render()
    await act(async () => byTestId("confirm-tag-close")!.click())
    await flush()
    expect(h.navigate).toHaveBeenCalledWith("/claim?resume=1", { replace: true })
  })
})
