/**
 * /enter under the phone policy: a refusal from the passkey policy, a passkey no anchor names, a
 * prompt that closed without one, and any other failure all keep the user on the screen with the
 * reason and a retry. Only the user's own cancel falls through to /claim.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { namehash } from "viem/ens"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  type HeldRequest,
  pageHide,
  passkeyEvents,
  passkeyTelemetryHarness,
} from "./support/passkeyTelemetryHarness"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
vi.setConfig({ testTimeout: 30_000 })

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  enterWithPasskey: vi.fn(),
  diagnoseMiss: vi.fn(),
  showReportableError: vi.fn(),
  fireEvent: vi.fn(),
  saveWalletIdentity: vi.fn(),
  getConfig: vi.fn(),
  reservedNameHashes: vi.fn(),
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
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAccountContext: () => ({ setObsidionAccount: vi.fn() }),
  useAztecContext: () => ({ obsidionWallet: { wallet: true } }),
  useContractServiceContext: () => ({ contractService: {} }),
}))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: h.getConfig,
}))
vi.mock("../src/features/onboarding/oxideOnboarding", async () => {
  const { matchWireNameHash } = await import("@obsidion/front-core")
  return {
    enterWithPasskey: h.enterWithPasskey,
    confirmTag: h.confirmTag,
    isCommittedFailure: (err: unknown) =>
      typeof err === "object" && err !== null && (err as { committed?: boolean }).committed === true,
    // The real matching, without the module that drags the Aztec stack in.
    reservedTagMatch: (hashes: `0x${string}`[], ensDomain: string, handle: string) =>
      hashes.map((hash) => matchWireNameHash(handle, ensDomain, hash)).find(Boolean) ?? null,
    // The class the screen matches by instanceof; the real one drags the Aztec stack in.
    PasskeyMismatchError: class PasskeyMismatchError extends Error {
      name = "PasskeyMismatchError"
    },
  }
})
vi.mock("../src/features/onboarding/findPasskeyByTag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/findPasskeyByTag")>()),
  diagnoseMiss: h.diagnoseMiss,
  lookupPasskeyByTag: h.lookup,
}))
vi.mock("../src/config/oxideTuple", () => ({ getOxideTuple: h.getOxideTuple }))
vi.mock("../src/features/contacts/registryResolution", () => ({
  resolveTagViaRegistry: vi.fn(),
  resolveTagForCommit: vi.fn(),
}))
vi.mock("../src/features/onboarding/recoveryProbes", () => ({
  reservedNameHashes: h.reservedNameHashes,
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    probePhoneReach: async () => h.reach,
    recoverFromCache: h.recoverFromCache,
  }),
  peekAuthService: () =>
    h.recordsStale === undefined ? undefined : { recordsStale: () => h.recordsStale },
}))
vi.mock("../src/features/identity/walletIdentity", () => ({
  saveWalletIdentity: h.saveWalletIdentity,
  loadWalletIdentity: () => null,
}))
vi.mock("../src/features/onboarding/webRegistration", () => ({
  getPendingStore: () => ({ list: () => [] }),
}))
vi.mock("../src/features/paylink/claimStash", () => ({ peekClaimStash: () => undefined }))
vi.mock("../src/features/paylink/sponsoredPaylink", () => ({ decodeLink: vi.fn() }))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
vi.mock("../src/lib/analytics", () => ({
  fireEvent: h.fireEvent,
  failureCode: (e: unknown) => (e instanceof Error ? e.name : "err"),
}))
vi.mock("../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
// The sign-in cancel sits on this body and is handed the exit as the function itself.
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
vi.mock("../src/features/onboarding/steps/ConfirmTagModal", () => ({
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
    start?: import("../src/features/onboarding/steps/ConfirmTagModal").SignInStart
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
      <div data-testid="confirm-tag" data-handle={initialHandle} data-title={submitTitle ?? "Login"}>
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
vi.mock("../src/features/onboarding/steps/InvitationStep", () => ({ InvitationStep: () => null }))
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
}))

let container: HTMLDivElement
let root: Root

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))

// The module registry is reset per test, so the errors come from the same registry as the screen:
// `isPasskeyPolicyError` is an `instanceof` check.
const policyErrors = () => import("@obsidion/passkey-web")

type Entry = { pathname: string; search?: string; state?: unknown }

async function render(path: string | Entry = "/enter") {
  const { EnterAppScreen } = await import("../src/features/onboarding/EnterAppScreen")
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path as string]}>
        <EnterAppScreen />
      </MemoryRouter>,
    )
  })
  await flush()
}

type EnterOptions = {
  gate: () => Promise<{ signal: AbortSignal; route?: string; reach: string }>
  chooser?: boolean
  own?: import("@obsidion/passkey-web").PasskeyRequestScope
}
/** An entry that waits at the gate the way the real one does, then answers `result`. */
const gatedEntry = (result: unknown) =>
  h.enterWithPasskey.mockImplementationOnce(
    async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
      await options.gate()
      return result
    },
  )
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)

const leaveAssign = vi.fn()
/**
 * The screen exited to where signing in starts: the campaign when this build names one, which ends
 * its own session on arrival, else the wallet's own /claim.
 */
const leftForSignInStart = () =>
  h.navigate.mock.calls.some((call) => (call as unknown[])[0] === "/claim") ||
  leaveAssign.mock.calls.some((call) => call[0] === "https://launch.test.invalid/?signedout=1")

const L2 = `0x${"ac".repeat(32)}`
/** A recovered account with no registered name — the state the waitlist answer decides. */
const nameless = (address = L2) => ({
  entered: false,
  reason: "unclaimed",
  account: { getAddress: () => ({ toString: () => address }) },
  bootstrap: {
    address: "0xE0A0000000000000000000000000000000000001",
    signMessage: async () => "0xsig",
  },
  ensDomain: "zk.money",
})

/** One campaign answer, as the verify endpoint returns it. */
const answers = (body: unknown, status = 200) =>
  fetchMock.mockImplementationOnce(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  }))
const fetchMock = vi.fn()
const refused = () => container.querySelector<HTMLElement>('[data-testid="enter-refused"]')
const retry = () => container.querySelector<HTMLButtonElement>('[data-testid="enter-retry"]')!
const screen = () => byTestId("sign-in-start")
const click = async (id: string) => {
  await act(async () => byTestId(id)!.click())
  await flush()
}
/** A probe that finds no cached key, so the screen shows. */
const needsCeremony = () =>
  h.enterWithPasskey.mockResolvedValueOnce({ entered: false, reason: "ceremony-required" })

beforeEach(() => {
  vi.resetModules()
  h.navigate.mockClear()
  h.enterWithPasskey.mockReset()
  h.lookup.mockReset().mockResolvedValue({ kind: "notFound" })
  h.getOxideTuple.mockReset().mockResolvedValue({})
  h.recoverFromCache.mockReset().mockResolvedValue(undefined)
  h.diagnoseMiss.mockReset()
  h.showReportableError.mockClear()
  h.fireEvent.mockClear()
  h.saveWalletIdentity.mockClear()
  h.reservedNameHashes.mockReset().mockResolvedValue([])
  h.confirmTag.mockReset()
  h.typedTag = undefined
  h.recordsStale = false
  h.reach = "unknown"
  h.getConfig.mockReturnValue({
    rpId: "localhost",
    campaignUrl: "https://launch.test.invalid",
    admissionGate: true,
    accountServiceTestMode: false,
  })
  fetchMock.mockReset()
  leaveAssign.mockClear()
  vi.stubGlobal("location", { assign: leaveAssign, origin: "https://wallet.test" })
  vi.stubGlobal("fetch", fetchMock)
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
  it("a phone-required refusal stays on /enter with the reason and a retry", async () => {
    const { PhoneRequiredError, DeviceBoundPasskeyError } = await policyErrors()
    h.enterWithPasskey.mockRejectedValueOnce(new PhoneRequiredError())
    await render()
    expect(container.textContent).toContain("Use your phone")
    expect(refused()?.dataset.reason).toBe("PhoneRequiredError")
    expect(leftForSignInStart()).toBe(false)
    // Not an error to report, but a failed entry the funnel counts.
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(h.fireEvent).toHaveBeenCalledWith("action_failed", {
      action: "enter",
      code: "PhoneRequiredError",
    })

    h.enterWithPasskey.mockRejectedValueOnce(new DeviceBoundPasskeyError())
    await act(async () => byTestId("enter-retry")!.click())
    await flush()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("can't be backed up")
    expect(refused()?.dataset.reason).toBe("DeviceBoundPasskeyError")
    expect(leftForSignInStart()).toBe(false)
  })

  it("a passkey no anchor names stays on /enter and offers no way to create an account", async () => {
    h.enterWithPasskey.mockResolvedValueOnce({ entered: false, reason: "unknown" })
    await render()
    expect(container.textContent).toContain("No wallet was found")
    expect(refused()?.dataset.reason).toBe("NoWalletForPasskeyError")
    expect(container.textContent).not.toMatch(/create/i)
    expect(leftForSignInStart()).toBe(false)
  })

  it("a cancel while the identity is saved leaves the hint unwritten and navigates nowhere", async () => {
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: true,
      handle: "alice",
      address: L2,
      account: {},
    })
    let release!: () => void
    h.saveWalletIdentity.mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
    await render()
    expect(h.saveWalletIdentity).toHaveBeenCalledTimes(1)
    expect(h.navigate).not.toHaveBeenCalled()

    await act(async () => byTestId("spinner-cancel")!.click())
    await flush()
    expect(leftForSignInStart()).toBe(true)
    // The save asks this before writing the passkey hint under the map lock.
    const owns = h.saveWalletIdentity.mock.calls[0][1] as () => boolean
    expect(owns()).toBe(false)

    await act(async () => release())
    await flush()
    expect(h.navigate).not.toHaveBeenCalledWith("/", { replace: true })
  })

  it("a granted account with no name is sent to finish signing up, not into the wallet", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    answers({ status: "granted" })
    await render()
    expect(refused()?.dataset.reason).toBe("GrantedRegistrationError")
    expect(container.textContent).toContain("You're through the queue")
    expect(container.textContent).not.toContain("still in line")
    // Nothing without a name reaches the wallet: no identity is saved and nothing navigates itself.
    expect(h.saveWalletIdentity).not.toHaveBeenCalled()
    expect(leftForSignInStart()).toBe(false)

    await act(async () => byTestId("enter-cancel")!.click())
    await flush()
    expect(h.navigate).toHaveBeenCalledWith("/claim?resume=1", { replace: true })
  })

  it("a nameless account stays out of the wallet even with the gate switched off", async () => {
    h.getConfig.mockReturnValue({ rpId: "localhost", campaignUrl: "", admissionGate: false })
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    await render()
    expect(fetchMock).not.toHaveBeenCalled()
    // With the gate off the campaign gave no answer, so account-service is asked, and holds nothing.
    expect(h.reservedNameHashes).toHaveBeenCalledTimes(1)
    expect(h.saveWalletIdentity).not.toHaveBeenCalled()
    expect(refused()?.dataset.reason).toBe("GrantedRegistrationError")
  })

  it("a queued account is told its place in line and offered the way to skip it", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    answers({ status: "queued", queuePosition: 812 })
    await render()
    expect(refused()?.dataset.reason).toBe("QueuedRegistrationError")
    expect(container.textContent).toContain("You're still in line")
    expect(container.textContent).toContain("number 812 in line")
    // The wallet is not opened and nothing navigates on its own: the exit is the way on.
    expect(h.saveWalletIdentity).not.toHaveBeenCalled()
    expect(leftForSignInStart()).toBe(false)

    // The exit resumes the signup that is already begun, rather than starting a new one.
    await act(async () => byTestId("enter-cancel")!.click())
    await flush()
    expect(h.navigate).toHaveBeenCalledWith("/claim?resume=1", { replace: true })
  })

  it("a queue with no position given says so without inventing one", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    answers({ status: "queued" })
    await render()
    expect(refused()?.dataset.reason).toBe("QueuedRegistrationError")
    expect(container.textContent).toContain("held for you")
    expect(container.textContent).not.toMatch(/in line\./)
  })

  it("a waitlist that could not answer offers another attempt, not a place in line", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    answers({}, 503)
    await render()
    expect(refused()?.dataset.reason).toBe("AdmissionUnavailableError")
    expect(container.textContent).toContain("Couldn't check your place in line")
    expect(container.textContent).not.toContain("You're still in line")
    expect(retry()).not.toBeNull()
    expect(leftForSignInStart()).toBe(false)
  })

  it("a key the waitlist has never seen signs up rather than being given a place in line", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    answers({}, 404)
    await render()
    expect(refused()).toBeNull()
    expect(leftForSignInStart()).toBe(true)
  })

  it("a second attempt reads the cached grant rather than asking the campaign again", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    answers({ status: "granted" })
    await render()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(refused()?.dataset.reason).toBe("GrantedRegistrationError")

    act(() => root.unmount())
    root = createRoot(container)
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    await render()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(refused()?.dataset.reason).toBe("GrantedRegistrationError")
  })

  it("an arrival read that could not answer shows the screen, unreported, and keeps the user off /claim", async () => {
    h.enterWithPasskey.mockRejectedValueOnce(new Error("rpc down"))
    await render()
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(refused()).toBeNull()
    expect(screen()).not.toBeNull()
    expect(leftForSignInStart()).toBe(false)
  })

  it("an account-service lookup that timed out on the chooser is the network refusal, not a closed prompt", async () => {
    const { AccountServiceTimeoutError } = await import("@obsidion/front-core")
    needsCeremony()
    await render()
    h.enterWithPasskey.mockRejectedValueOnce(
      new AccountServiceTimeoutError("/domain/reservation", 15_000),
    )
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("error")
    expect(retry()).not.toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(h.fireEvent).not.toHaveBeenCalledWith("action_failed", {
      action: "enter",
      code: "passkey_prompt_closed",
    })
  })

  it("the screen owns the tap: Show passkeys opens the chooser at once, with no sheet between", async () => {
    needsCeremony()
    await render()
    expect(screen()).not.toBeNull()
    expect(byTestId("sign-in-sheet")).toBeNull()
    expect(refused()).toBeNull()

    gatedEntry({ entered: false, reason: "unknown" })
    await click("sign-in-show-passkeys")
    expect(screen()).toBeNull()
    expect(byTestId("sign-in-sheet")).toBeNull()
    expect(refused()?.dataset.reason).toBe("NoWalletForPasskeyError")
    expect(leftForSignInStart()).toBe(false)
  })

  it("Cancel on the screen returns to /claim with nothing reported", async () => {
    needsCeremony()
    await render()
    await click("sign-in-close")
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(h.fireEvent).not.toHaveBeenCalledWith("action_failed", expect.anything())
    expect(refused()).toBeNull()
    expect(leftForSignInStart()).toBe(true)
  })

  it("leaving the screen navigates nowhere", async () => {
    needsCeremony()
    await render()
    expect(screen()).not.toBeNull()
    await act(async () => root.unmount())
    root = createRoot(container)
    await flush()
    expect(h.navigate).not.toHaveBeenCalled()
    expect(h.showReportableError).not.toHaveBeenCalled()
  })

  it("?choose=1 skips the probe and its Show passkeys asks the browser to list every passkey", async () => {
    await render("/enter?choose=1")
    expect(h.enterWithPasskey).not.toHaveBeenCalled()
    h.enterWithPasskey.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    await click("sign-in-show-passkeys")
    expect(h.enterWithPasskey).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      expect.objectContaining({ chooser: true, restoreCache: false }),
    )
  })

  it.each(["NotAllowedError", "AbortError"])(
    "a chooser closed with %s stays here with Back to the screen, nothing reported",
    async (name) => {
      needsCeremony()
      await render()
      h.enterWithPasskey.mockRejectedValueOnce(new DOMException("closed", name))
      await click("sign-in-show-passkeys")
      expect(h.showReportableError).not.toHaveBeenCalled()
      expect(refused()?.dataset.reason).toBe("PasskeyNotOfferedError")
      expect(container.textContent).toContain("Your passkey wasn't offered")
      // The screen is where the user tries again, so no retry; a laptop's closed prompt gets no
      // cause list — the browser's own chooser is the guidance there.
      expect(retry()).toBeNull()
      expect(byTestId("enter-back")).not.toBeNull()
      expect(byTestId("enter-cancel")).not.toBeNull()
      expect(byTestId("passkey-causes")).toBeNull()
      expect(leftForSignInStart()).toBe(false)
      expect(h.fireEvent).toHaveBeenCalledWith("action_failed", {
        action: "enter",
        code: "passkey_prompt_closed",
      })

      await click("enter-back")
      expect(refused()).toBeNull()
      expect(screen()).not.toBeNull()
      await click("sign-in-close")
      expect(leftForSignInStart()).toBe(true)
    },
  )

  it("a passkey no anchor names offers Back to the screen and the cancel, no retry", async () => {
    h.enterWithPasskey.mockResolvedValueOnce({ entered: false, reason: "unknown" })
    await render()
    expect(refused()?.dataset.reason).toBe("NoWalletForPasskeyError")
    expect(retry()).toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    await click("enter-back")
    expect(screen()).not.toBeNull()
    // Back re-prepares: the manifest and the cache proof, no prompt.
    expect(h.getOxideTuple).toHaveBeenCalledTimes(1)
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
  })

  it("cancelling the sign-in lands on /claim itself, with no event in the path", async () => {
    // Held open, so the screen sits on the step that owns the cancel.
    h.enterWithPasskey.mockImplementationOnce(() => new Promise(() => {}))
    await render()
    await act(async () => byTestId("spinner-cancel")!.click())
    await flush()
    // React hands the click event to a bare handler; an exit that took it as a search string
    // would leave for the campaign with "[object Object]" on the end.
    expect(leaveAssign).toHaveBeenCalledWith("https://launch.test.invalid/?signedout=1")
  })

  it("Cancel sign-in past the prompt ends the attempt as well as the screen", async () => {
    let attempt: AbortSignal | undefined
    needsCeremony()
    await render()
    h.enterWithPasskey.mockImplementationOnce(
      async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
        attempt = (await options.gate()).signal
        await new Promise(() => {})
      },
    )
    await click("sign-in-show-passkeys")
    expect(attempt?.aborted).toBe(false)
    await click("spinner-cancel")
    expect(attempt?.aborted).toBe(true)
    expect(leftForSignInStart()).toBe(true)
  })
})

describe("EnterAppScreen miss diagnosis", () => {
  const unknownMiss = () =>
    gatedEntry({
      entered: false,
      reason: "unknown",
      credentialId: "cred-a",
      pubkey: "ab".repeat(64),
      addresses: ["0xelsewhere"],
      observed: { credentialId: "cred-a", attachment: "platform" },
    })

  it("a miss card offers Back to the screen, not a retry; the screen is where the next try starts", async () => {
    needsCeremony()
    await render()
    unknownMiss()
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("NoWalletForPasskeyError")
    expect(byTestId("enter-retry")).toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    await click("enter-back")
    expect(refused()).toBeNull()
    expect(screen()).not.toBeNull()
    gatedEntry({ entered: false, reason: "unknown" })
    await click("sign-in-show-passkeys")
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(3)
  })

  it("a miss with a known tag runs the diagnosis and shows the verdict, not the generic card", async () => {
    h.diagnoseMiss.mockResolvedValue("NOT_REPRODUCED_HERE")
    needsCeremony()
    await render("/enter?handle=alice")
    unknownMiss()
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("NotReproducedHereError")
    expect(h.diagnoseMiss).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: "cred-a", pubkey: "ab".repeat(64) }),
      "alice",
    )
    expect(leftForSignInStart()).toBe(false)
  })

  it.each(["DIFFERENT_PASSKEY", "INCONCLUSIVE", "NOT_REPRODUCED_HERE"])(
    "a %s verdict offers Back and the cancel, no retry, and its text names only those",
    async (diagnosis) => {
      h.diagnoseMiss.mockResolvedValue(diagnosis)
      needsCeremony()
      await render("/enter?handle=alice")
      unknownMiss()
      await click("sign-in-show-passkeys")
      expect(refused()).not.toBeNull()
      expect(byTestId("enter-retry")).toBeNull()
      expect(byTestId("enter-back")).not.toBeNull()
      expect(byTestId("enter-cancel")).not.toBeNull()
      expect(refused()!.textContent).not.toMatch(/try again/i)
      expect(refused()!.textContent).toMatch(/Go back/)
    },
  )

  it("a record-anchored wrong-key mismatch shows the certain card with Show passkeys and no retry", async () => {
    const { StoredAddressMismatchError } = await import("@obsidion/front-core")
    needsCeremony()
    await render()
    h.enterWithPasskey.mockImplementationOnce(
      async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
        await options.gate()
        throw Object.assign(new StoredAddressMismatchError(), { verdict: "wrong-key" })
      },
    )
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(container.textContent).toMatch(/wrong key/i)
    expect(byTestId("enter-retry")).toBeNull()
    expect(byTestId("enter-show-passkeys")).not.toBeNull()
    expect(byTestId("enter-cancel")).not.toBeNull()
    h.enterWithPasskey.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    await click("enter-show-passkeys")
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(3)
    expect(h.enterWithPasskey.mock.calls.at(-1)![3]).toMatchObject({ chooser: true })
  })

  it("a not-reproduced record mismatch keeps its retry", async () => {
    const { StoredAddressMismatchError } = await import("@obsidion/front-core")
    needsCeremony()
    await render()
    h.enterWithPasskey.mockImplementationOnce(
      async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
        await options.gate()
        throw Object.assign(new StoredAddressMismatchError(), { verdict: "not-reproduced" })
      },
    )
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(byTestId("enter-retry")).not.toBeNull()
    expect(byTestId("enter-show-passkeys")).toBeNull()
  })

  it("leaving the screen ends the attempt behind the prompt", async () => {
    let attempt: AbortSignal | undefined
    needsCeremony()
    await render()
    h.enterWithPasskey.mockImplementationOnce(
      async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
        attempt = (await options.gate()).signal
        await new Promise(() => {})
      },
    )
    await click("sign-in-show-passkeys")
    expect(attempt?.aborted).toBe(false)
    act(() => root.unmount())
    expect(attempt?.aborted).toBe(true)
    root = createRoot(container)
  })

  it("a cancel during the diagnosis shows no card and reports nothing", async () => {
    let answer!: (diagnosis: string) => void
    h.diagnoseMiss.mockReturnValueOnce(new Promise<string>((resolve) => (answer = resolve)))
    needsCeremony()
    await render("/enter?handle=alice")
    unknownMiss()
    await click("sign-in-show-passkeys")
    expect(h.diagnoseMiss).toHaveBeenCalledTimes(1)
    await click("spinner-cancel")
    h.fireEvent.mockClear()
    await act(async () => answer("DIFFERENT_PASSKEY"))
    await flush()
    expect(refused()).toBeNull()
    expect(h.fireEvent).not.toHaveBeenCalledWith("action_failed", expect.anything())
  })
})

/**
 * A nameless account account-service holds a claim for: the signup continues as the tag the claim
 * names, confirmed on the same step a registered account uses.
 */
describe("EnterAppScreen reservation", () => {
  const hashOf = (tag: string) => namehash(`${tag}.zk.money`)
  const confirmStep = () => byTestId("confirm-tag")
  const unknownToCampaign = () => answers({}, 404)
  /** A promise and the functions that settle it. */
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    let reject!: (err: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it("a key the campaign never saw, with a claim, confirms its tag; the card then resumes that signup", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    unknownToCampaign()
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render()
    expect(h.reservedNameHashes.mock.calls[0]![0].address).toBe(nameless().bootstrap.address)
    expect(confirmStep()?.dataset.title).toBe("Continue signing up")
    expect(leftForSignInStart()).toBe(false)

    h.typedTag = "cris"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    // The tag matched: the card says the signup never finished, and its way on picks it back up.
    expect(refused()?.dataset.reason).toBe("ReservedRegistrationError")
    expect(refused()?.textContent).toContain("@cris")
    expect(h.navigate).not.toHaveBeenCalled()
    await click("enter-continue")
    expect(h.navigate).toHaveBeenCalledWith("/claim/cris?resume=1", { replace: true })
    expect(h.saveWalletIdentity).not.toHaveBeenCalled()
  })

  it("the reserved card's Back returns to the screen and forgets the reservation", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    unknownToCampaign()
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render()
    h.typedTag = "cris"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    expect(refused()?.dataset.reason).toBe("ReservedRegistrationError")
    expect(byTestId("enter-retry")).toBeNull()

    await click("enter-back")
    expect(refused()).toBeNull()
    expect(screen()).not.toBeNull()
    expect(h.navigate).not.toHaveBeenCalled()

    // A registered passkey's confirm step is its claim's, not the forgotten reservation's.
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: { nameHash: hashOf("alice"), address: L2, ensDomain: "zk.money" },
      account: { getAddress: () => ({ toString: () => L2 }) },
    })
    await click("sign-in-show-passkeys")
    expect(confirmStep()?.dataset.title).toBe("Login")
    h.confirmTag.mockReturnValueOnce({ handle: "alice", address: L2 })
    h.typedTag = "alice"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    expect(h.confirmTag).toHaveBeenCalledTimes(1)
  })

  it("a tag the link already carries that names the claim skips the step, not the card", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    unknownToCampaign()
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render("/enter?handle=cris")
    expect(confirmStep()).toBeNull()
    expect(refused()?.dataset.reason).toBe("ReservedRegistrationError")
    expect(h.navigate).not.toHaveBeenCalled()
    await click("enter-continue")
    expect(h.navigate).toHaveBeenCalledWith("/claim/cris?resume=1", { replace: true })
  })

  it("a link's tag that names no claim is only the step's seed", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    unknownToCampaign()
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render("/enter?handle=alice")
    expect(confirmStep()?.dataset.handle).toBe("alice")
    expect(leftForSignInStart()).toBe(false)
  })

  it("a tag that names none of the claims is refused on the step; decorated forms still match", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    unknownToCampaign()
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render()

    h.typedTag = "bob"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    expect(byTestId("confirm-tag-error")?.textContent).toContain("@bob")
    expect(h.navigate).not.toHaveBeenCalled()

    h.typedTag = "cris.zk.money"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    await click("enter-continue")
    expect(h.navigate).toHaveBeenCalledWith("/claim/cris?resume=1", { replace: true })
  })

  it("a key holding two claims confirms either tag", async () => {
    for (const tag of ["cris", "@Cris2"]) {
      h.navigate.mockClear()
      act(() => root.unmount())
      root = createRoot(container)
      h.enterWithPasskey.mockResolvedValueOnce(nameless())
      unknownToCampaign()
      h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris"), hashOf("cris2")])
      await render()
      h.typedTag = tag
      await act(async () => byTestId("confirm-tag-submit")!.click())
      await flush()
      await click("enter-continue")
      const bare = tag.replace("@", "").toLowerCase()
      expect(h.navigate).toHaveBeenCalledWith(`/claim/${bare}?resume=1`, { replace: true })
    }
  })

  it("no claim is today's signup page", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    unknownToCampaign()
    await render()
    expect(h.reservedNameHashes).toHaveBeenCalledTimes(1)
    expect(confirmStep()).toBeNull()
    expect(h.navigate).toHaveBeenCalledWith("/claim", { replace: true })
  })

  it.each([{ status: "granted" }, { status: "queued", queuePosition: 3 }])(
    "a campaign that knows the key keeps its card and asks account-service nothing (%o)",
    async (body) => {
      h.enterWithPasskey.mockResolvedValueOnce(nameless())
      answers(body)
      await render()
      expect(h.reservedNameHashes).not.toHaveBeenCalled()
      expect(refused()?.dataset.reason).toMatch(/GrantedRegistrationError|QueuedRegistrationError/)
    },
  )

  it("with the gate off a claim still confirms its tag instead of the granted card", async () => {
    h.getConfig.mockReturnValue({ rpId: "localhost", campaignUrl: "", admissionGate: false })
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render()
    expect(refused()).toBeNull()
    expect(confirmStep()).not.toBeNull()
  })

  it("account-service test mode asks nothing and keeps today's outcome", async () => {
    h.getConfig.mockReturnValue({
      rpId: "localhost",
      campaignUrl: "",
      admissionGate: false,
      accountServiceTestMode: true,
    })
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    h.reservedNameHashes.mockRejectedValue(new Error("unreachable"))
    await render()
    expect(h.reservedNameHashes).not.toHaveBeenCalled()
    expect(refused()?.dataset.reason).toBe("GrantedRegistrationError")
  })

  it("a lookup that fails after the commit is the network refusal; retry asks again, not the passkey", async () => {
    const { AccountServiceTimeoutError } = await import("@obsidion/front-core")
    await render("/enter?choose=1")
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    unknownToCampaign()
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

    // A campaign that cannot answer by now would change nothing: the retry does not ask it again.
    answers({}, 503)
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await act(async () => retry().click())
    await flush()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(h.reservedNameHashes).toHaveBeenCalledTimes(2)
    expect(confirmStep()).not.toBeNull()
  })

  it("the committed refusal's way on continues the signup rather than starting one", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    unknownToCampaign()
    h.reservedNameHashes.mockRejectedValueOnce(new Error("offline"))
    await render()
    await act(async () => byTestId("enter-continue")!.click())
    await flush()
    expect(h.navigate).toHaveBeenCalledWith("/claim?resume=1", { replace: true })
  })

  it("closing the reserved step continues the signup, where the reserved tag is not refused", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    unknownToCampaign()
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render()
    await act(async () => byTestId("confirm-tag-close")!.click())
    await flush()
    expect(h.navigate).toHaveBeenCalledWith("/claim?resume=1", { replace: true })
  })

  it("a sign-in failure before any commit retries the sign-in, not the signup", async () => {
    await render("/enter?choose=1")
    h.enterWithPasskey.mockRejectedValueOnce(new Error("rpc down"))
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("error")
    expect(byTestId("enter-continue")).toBeNull()
    expect(byTestId("enter-back")).not.toBeNull()
    h.enterWithPasskey.mockRejectedValueOnce(new Error("rpc down"))
    await act(async () => byTestId("enter-retry")!.click())
    await flush()
    expect(h.enterWithPasskey).toHaveBeenCalledTimes(2)
    expect(h.reservedNameHashes).not.toHaveBeenCalled()
  })

  it("Cancel sign-in during the lookup hands back, and its late answer does nothing", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    unknownToCampaign()
    const pending = deferred<string[]>()
    h.reservedNameHashes.mockReturnValueOnce(pending.promise)
    await render()
    await act(async () => byTestId("spinner-cancel")!.click())
    await flush()
    expect(leaveAssign).toHaveBeenCalledWith("https://launch.test.invalid/?signedout=1")
    h.navigate.mockClear()

    await act(async () => pending.resolve([hashOf("cris")]))
    await flush()
    expect(h.navigate).not.toHaveBeenCalled()
    expect(confirmStep()).toBeNull()
    expect(refused()).toBeNull()
  })

  it("a failed lookup answering after Cancel sign-in reports nothing", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    unknownToCampaign()
    const pending = deferred<string[]>()
    h.reservedNameHashes.mockReturnValueOnce(pending.promise)
    await render()
    await act(async () => byTestId("spinner-cancel")!.click())
    await flush()
    await act(async () => pending.reject(new Error("offline")))
    await flush()
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(refused()).toBeNull()
  })

  it("Cancel sign-in during the retry's lookup leaves nothing behind either", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    unknownToCampaign()
    h.reservedNameHashes.mockRejectedValueOnce(new Error("offline"))
    await render()
    const pending = deferred<string[]>()
    h.reservedNameHashes.mockReturnValueOnce(pending.promise)
    await act(async () => retry().click())
    await flush()
    await act(async () => byTestId("spinner-cancel")!.click())
    await flush()
    h.navigate.mockClear()
    await act(async () => pending.resolve([hashOf("cris")]))
    await flush()
    expect(h.navigate).not.toHaveBeenCalled()
    expect(confirmStep()).toBeNull()
  })

  it("from a reservation to a registered passkey: the registered tag enters the wallet", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    unknownToCampaign()
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await render()
    h.typedTag = "bob"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    expect(byTestId("confirm-tag-error")).not.toBeNull()

    // Back to the screen; its Show passkeys asks the browser again, and the registered passkey answers.
    await act(async () => byTestId("confirm-back")!.click())
    await flush()
    expect(byTestId("sign-in-start")).not.toBeNull()
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: { nameHash: hashOf("alice"), address: L2, ensDomain: "zk.money" },
      account: { getAddress: () => ({ toString: () => L2 }) },
    })
    await act(async () => byTestId("sign-in-show-passkeys")!.click())
    await flush()
    expect(confirmStep()?.dataset.title).toBe("Login")
    expect(byTestId("confirm-tag-error")).toBeNull()

    h.confirmTag.mockReturnValueOnce({ handle: "alice", address: L2 })
    h.typedTag = "alice"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    expect(h.confirmTag).toHaveBeenCalledTimes(1)
    expect(h.saveWalletIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ handle: "alice", address: L2 }),
      expect.any(Function),
    )
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(leftForSignInStart()).toBe(false)
  })

  it("from a registered passkey to a reservation: the reserved tag resumes, saving no identity", async () => {
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: { nameHash: hashOf("alice"), address: L2, ensDomain: "zk.money" },
      account: { getAddress: () => ({ toString: () => L2 }) },
    })
    await render()
    expect(confirmStep()?.dataset.title).toBe("Login")

    await act(async () => byTestId("confirm-back")!.click())
    await flush()
    h.enterWithPasskey.mockResolvedValueOnce(nameless())
    unknownToCampaign()
    h.reservedNameHashes.mockResolvedValueOnce([hashOf("cris")])
    await act(async () => byTestId("sign-in-show-passkeys")!.click())
    await flush()
    expect(confirmStep()?.dataset.title).toBe("Continue signing up")

    h.typedTag = "cris"
    await act(async () => byTestId("confirm-tag-submit")!.click())
    await flush()
    expect(h.confirmTag).not.toHaveBeenCalled()
    await click("enter-continue")
    expect(h.saveWalletIdentity).not.toHaveBeenCalled()
    expect(h.navigate).toHaveBeenCalledWith("/claim/cris?resume=1", { replace: true })
  })
})

/** The confirmation the entry screen offers, and the way out of it: Back to the screen, then its Show passkeys. */
describe("EnterAppScreen chooser", () => {
  const dismissed = () => new DOMException("closed", "NotAllowedError")
  const lastChooser = () => {
    const calls = h.enterWithPasskey.mock.calls
    return (calls[calls.length - 1][3] as { chooser?: boolean }).chooser
  }
  /** An entry that recovers an account and asks the user to confirm its tag. */
  const confirms = () =>
    h.enterWithPasskey.mockResolvedValueOnce({
      entered: false,
      reason: "confirm",
      claim: {},
      account: { getAddress: () => ({ toString: () => L2 }) },
    })

  it("Back, then Show passkeys asks the browser for the list even though the URL did not; a dismissal lands on the card", async () => {
    confirms()
    await render()
    expect(lastChooser()).toBeFalsy()

    await act(async () => byTestId("confirm-back")!.click())
    await flush()
    expect(byTestId("confirm-tag")).toBeNull()
    expect(byTestId("sign-in-start")).not.toBeNull()
    h.enterWithPasskey.mockRejectedValueOnce(dismissed())
    await act(async () => byTestId("sign-in-show-passkeys")!.click())
    await flush()
    expect(lastChooser()).toBe(true)
    // A closed list is a closed prompt: the same card, with Back to the screen.
    expect(refused()?.dataset.reason).toBe("PasskeyNotOfferedError")
    expect(byTestId("enter-back")).not.toBeNull()
    expect(leftForSignInStart()).toBe(false)
  })

  it("keeps asking the browser when a refusal on that attempt is retried", async () => {
    const { PhoneRequiredError } = await policyErrors()
    confirms()
    await render()

    await act(async () => byTestId("confirm-back")!.click())
    await flush()
    h.enterWithPasskey.mockRejectedValueOnce(new PhoneRequiredError())
    await act(async () => byTestId("sign-in-show-passkeys")!.click())
    await flush()
    expect(refused()?.dataset.reason).toBe("PhoneRequiredError")

    h.enterWithPasskey.mockRejectedValueOnce(dismissed())
    await act(async () => byTestId("enter-retry")!.click())
    await flush()
    // The retry inherits the intent: resolving the cache would land back on the confirmation.
    expect(lastChooser()).toBe(true)
  })
})

/**
 * Recovery can commit an account other than the one this tab holds, which moves the storage
 * pointer under record stores that are already loaded. The document is replaced when it does.
 */
describe("EnterAppScreen account switch", () => {
  const assign = vi.fn()
  /** A recovery that commits `id`; `stale` is what the auth service then reports. */
  const commits = (id: string, result: unknown = nameless(), stale = false) =>
    h.enterWithPasskey.mockImplementationOnce(async () => {
      localStorage.setItem("webwallet.storageId", id)
      h.recordsStale = stale
      return result
    })
  /** A recovery that names its account, the one outcome that reaches the wallet. */
  const named = { entered: true, handle: "alice", address: L2, account: {} }

  beforeEach(() => {
    assign.mockClear()
    vi.stubGlobal("location", { assign, origin: "https://wallet.test" })
    localStorage.setItem("webwallet.storageId", "storage-a")
  })
  afterEach(() => vi.unstubAllGlobals())

  it("continues in place when recovery finds the account the tab already held", async () => {
    commits("storage-a", named)
    await render()
    expect(assign).not.toHaveBeenCalled()
    expect(h.saveWalletIdentity).toHaveBeenCalledTimes(1)
  })

  it("replaces the document before asking the waitlist when a different account is committed", async () => {
    commits("storage-b")
    answers({ status: "granted" })
    await render()
    expect(assign).toHaveBeenCalledWith("/enter")
    // Nothing after the switch runs against the previous account's loaded records.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(refused()).toBeNull()
    expect(leftForSignInStart()).toBe(false)
  })

  it.each([
    ["a cancel", Object.assign(new Error("cancelled"), { name: "GateCancelledError" })],
    ["a failure", new Error("rpc down")],
  ])(
    "%s that lands after a different account was committed still replaces the document",
    async (_label, error) => {
      h.enterWithPasskey.mockImplementationOnce(async () => {
        localStorage.setItem("webwallet.storageId", "storage-b")
        throw error
      })
      await render()
      // The commit stands and moved the pointer under this document's stores: it must go, and
      // nothing is shown or navigated in it first.
      expect(assign).toHaveBeenCalledWith("/enter")
      expect(refused()).toBeNull()
      expect(leftForSignInStart()).toBe(false)
      expect(h.showReportableError).not.toHaveBeenCalled()
    },
  )

  it("does not replace the document a second time once it has reloaded", async () => {
    localStorage.setItem("webwallet.storageId", "storage-b")
    commits("storage-b", named)
    await render()
    expect(assign).not.toHaveBeenCalled()
    expect(h.saveWalletIdentity).toHaveBeenCalledTimes(1)
  })

  it("carries the tag and the onward destination across, and drops the chooser flags", async () => {
    await render({
      pathname: "/enter",
      search: "?handle=alice&choose=1&avoid=cred-x",
      state: { next: "/request#gift" },
    })
    commits("storage-b")
    await click("sign-in-show-passkeys")
    expect(assign).toHaveBeenCalledWith("/enter?handle=alice&next=%2Frequest%23gift")
  })

  it.each([
    "https://evil.test/steal",
    "//evil.test/steal",
    "/\\evil.test/steal",
    "/\n/evil.test/steal",
    "/\r/evil.test/steal",
    "/\t/evil.test/steal",
    "/a/..//evil.test/steal",
    "/%2e//evil.test/steal",
  ])("refuses an onward destination that leaves this wallet (%s)", async (next) => {
    commits("storage-b")
    await render({ pathname: "/enter", state: { next } })
    expect(assign).toHaveBeenCalledWith("/enter")
  })

  it("the reloaded document still finishes at the carried destination", async () => {
    localStorage.setItem("webwallet.storageId", "storage-b")
    commits("storage-b", named)
    await render({ pathname: "/enter", search: "?next=%2Frequest%23gift" })
    expect(assign).not.toHaveBeenCalled()
    expect(h.navigate).toHaveBeenCalledWith("/request#gift", { replace: true })
  })

  it("a nameless account that switched accounts reloads first, then its reservation resumes on the carried tag", async () => {
    commits("storage-b")
    await render("/enter?handle=cris")
    expect(assign).toHaveBeenCalledWith("/enter?handle=cris")
    // Nothing is asked of account-service against the previous account's loaded records.
    expect(h.reservedNameHashes).not.toHaveBeenCalled()

    act(() => root.unmount())
    root = createRoot(container)
    commits("storage-b")
    answers({}, 404)
    h.reservedNameHashes.mockResolvedValueOnce([namehash("cris.zk.money")])
    await render("/enter?handle=cris")
    expect(assign).toHaveBeenCalledTimes(1)
    await click("enter-continue")
    expect(h.navigate).toHaveBeenCalledWith("/claim/cris?resume=1", { replace: true })
  })

  it("a carried destination that leaves this wallet is not followed", async () => {
    localStorage.setItem("webwallet.storageId", "storage-b")
    commits("storage-b", named)
    await render({ pathname: "/enter", search: "?next=https%3A%2F%2Fevil.test%2Fsteal" })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  describe("signed out, as after a logout", () => {
    beforeEach(() => localStorage.removeItem("webwallet.storageId"))

    it("replaces the document before asking the waitlist when the account's records are stale", async () => {
      commits("storage-b", nameless(), true)
      answers({ status: "granted" })
      await render()
      expect(assign).toHaveBeenCalledWith("/enter")
      expect(fetchMock).not.toHaveBeenCalled()
      expect(refused()).toBeNull()
      expect(leftForSignInStart()).toBe(false)
    })

    it("replaces the document before a named account reaches the wallet", async () => {
      commits("storage-b", named, true)
      await render()
      expect(assign).toHaveBeenCalledWith("/enter")
      expect(h.saveWalletIdentity).not.toHaveBeenCalled()
    })

    it("replaces the document before asking which tag to confirm", async () => {
      commits(
        "storage-b",
        {
          entered: false,
          reason: "confirm",
          claim: {},
          account: { getAddress: () => ({ toString: () => L2 }) },
        },
        true,
      )
      await render()
      expect(assign).toHaveBeenCalledWith("/enter")
      expect(byTestId("show-passkeys")).toBeNull()
    })

    it("still replaces the document when the result lands after the user cancelled", async () => {
      let land!: () => void
      h.enterWithPasskey.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => (land = resolve))
        localStorage.setItem("webwallet.storageId", "storage-b")
        h.recordsStale = true
        return named
      })
      await render()
      await act(async () => byTestId("spinner-cancel")!.click())
      await flush()
      await act(async () => land())
      await flush()
      expect(assign).toHaveBeenCalledWith("/enter")
      expect(h.saveWalletIdentity).not.toHaveBeenCalled()
    })

    it("continues in place on a browser that never held the account", async () => {
      commits("storage-b", named)
      await render()
      expect(assign).not.toHaveBeenCalled()
      expect(h.saveWalletIdentity).toHaveBeenCalledTimes(1)
      expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    })

    it("sends a key the waitlist has never seen to sign up, in place", async () => {
      commits("storage-b")
      answers({}, 404)
      await render()
      expect(assign).not.toHaveBeenCalled()
      expect(leftForSignInStart()).toBe(true)
    })

    it("treats a page with no auth service as fresh", async () => {
      h.recordsStale = undefined
      h.enterWithPasskey.mockImplementationOnce(async () => {
        localStorage.setItem("webwallet.storageId", "storage-b")
        return named
      })
      await render()
      expect(assign).not.toHaveBeenCalled()
      expect(h.saveWalletIdentity).toHaveBeenCalledTimes(1)
    })
  })

  it("replaces the document when an earlier commit on this page left the records stale", async () => {
    // A remount after an attempt that committed and then failed: the same account, already active.
    localStorage.setItem("webwallet.storageId", "storage-b")
    commits("storage-b", named, true)
    await render()
    expect(assign).toHaveBeenCalledWith("/enter")
    expect(h.saveWalletIdentity).not.toHaveBeenCalled()
  })
})

/** One `passkey_ceremony` per sign-in, classified from what `enterWithPasskey` returned or threw. */
describe("EnterAppScreen passkey telemetry", () => {
  let harness: Awaited<ReturnType<typeof passkeyTelemetryHarness>>
  const OTHER_L2 = `0x${"bd".repeat(32)}`
  const ENTERED = { entered: true, handle: "alice", address: L2, account: {} }
  const events = () => passkeyEvents(h.fireEvent)

  beforeEach(async () => {
    harness = await passkeyTelemetryHarness()
    // An attempt an earlier test left open ends here, before this test counts anything.
    pageHide()
    h.fireEvent.mockClear()
  })

  /** A sign-in that asks through its own scope once past the gate and waits for the test. */
  const heldEntry = (result: unknown = { entered: false, reason: "unknown" }) => {
    const entry: { request?: HeldRequest } = {}
    h.enterWithPasskey.mockImplementationOnce(
      async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
        const { signal } = await options.gate()
        entry.request = harness.request("assert", signal, options.own)
        await entry.request.settled
        return result
      },
    )
    return entry
  }
  /** A sign-in whose one request is answered at once, then ends in `outcome`. */
  const answeredEntry = (outcome: () => unknown) =>
    h.enterWithPasskey.mockImplementationOnce(
      async (_w: unknown, _c: unknown, _h: unknown, options: EnterOptions) => {
        await options.gate()
        await harness.answered("assert", options.own)
        return outcome()
      },
    )

  /** The screen, reached through an arrival probe that found no cached key. */
  const toScreen = async (path = "/enter") => {
    needsCeremony()
    await render(path)
    expect(screen()).not.toBeNull()
    h.fireEvent.mockClear()
  }

  /** The screen with @alice's passkey read off L1, so Login is the pinned sign-in. */
  const toFoundPasskey = async () => {
    h.lookup.mockResolvedValue({
      kind: "resolved",
      tag: "alice",
      candidate: { credentialId: "cred-alice", pubkeyHex: "ab" },
      l2Address: L2,
      moreKeys: false,
    })
    await toScreen("/enter?handle=alice")
    expect(byTestId("sign-in-login")!.hasAttribute("disabled")).toBe(false)
  }

  it("an arrival probe that restores a cached key reports nothing: it asked for nothing", async () => {
    h.enterWithPasskey.mockResolvedValueOnce(ENTERED)
    await render()
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(events()).toEqual([])
  })

  it("an arrival probe that needs a prompt reports nothing and shows the screen", async () => {
    await toScreen()
    expect(events()).toEqual([])
  })

  it("an arrival probe refused by this browser's record reports the refusal with no prompt", async () => {
    const { StoredAddressMismatchError } = await import("@obsidion/front-core")
    h.enterWithPasskey.mockRejectedValueOnce(new StoredAddressMismatchError())
    await render()
    expect(refused()?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "enter",
        outcome: "refused",
        reason: "passkey_mismatch",
        prompts: "0",
      }),
    ])
  })

  it.each([
    ["an entered account", ENTERED, { outcome: "succeeded" }],
    [
      "a tag to confirm",
      { entered: false, reason: "confirm", claim: {}, account: {} },
      { outcome: "succeeded" },
    ],
    [
      "no wallet for the passkey",
      { entered: false, reason: "unknown" },
      { outcome: "refused", reason: "no_wallet_for_passkey" },
    ],
  ])("Show passkeys ending in %s reports it", async (_name, result, expected) => {
    await toScreen()
    answeredEntry(() => result)
    await click("sign-in-show-passkeys")
    expect(events()).toEqual([
      expect.objectContaining({ ceremony: "sign_in", flow: "enter", prompts: "1", ...expected }),
    ])
  })

  it("a nameless account succeeds, and the waitlist's refusal after it sends no passkey event", async () => {
    await toScreen()
    answeredEntry(() => nameless())
    answers({ status: "queued", queuePosition: 3 })
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("QueuedRegistrationError")
    expect(events()).toEqual([expect.objectContaining({ outcome: "succeeded" })])
  })

  it("a sign-in whose stored account no longer reproduces reads as a passkey mismatch", async () => {
    const { StoredAddressMismatchError } = await import("@obsidion/front-core")
    await toScreen()
    answeredEntry(() => {
      throw new StoredAddressMismatchError()
    })
    await click("sign-in-show-passkeys")
    expect(refused()?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(events()).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "passkey_mismatch", prompts: "1" }),
    ])
  })

  it.each([
    ["an entered account", ENTERED, { outcome: "succeeded" }],
    [
      "a record the registry could not confirm",
      { entered: false, reason: "unknown", addresses: [L2] },
      { outcome: "failed", reason: "registry_unconfirmed" },
    ],
    [
      "a key that is not the tag's",
      { entered: false, reason: "unknown", addresses: [OTHER_L2] },
      { outcome: "refused", reason: "passkey_mismatch" },
    ],
  ])("a pinned sign-in ending in %s reports it", async (_name, result, expected) => {
    await toFoundPasskey()
    answeredEntry(() => result)
    await click("sign-in-login")
    expect(events()).toEqual([
      expect.objectContaining({ ceremony: "sign_in", flow: "enter", prompts: "1", ...expected }),
    ])
  })

  it("a pinned sign-in the wrong passkey answered reads as a passkey mismatch", async () => {
    const { PasskeyMismatchError } = await import("../src/features/onboarding/oxideOnboarding")
    await toFoundPasskey()
    answeredEntry(() => {
      throw new PasskeyMismatchError()
    })
    await click("sign-in-login")
    expect(events()).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "passkey_mismatch" }),
    ])
  })

  it("Cancel sign-in during the request sends one cancel, and nothing once the screen and page go", async () => {
    await toScreen()
    const entry = heldEntry()
    await click("sign-in-show-passkeys")
    expect(entry.request).toBeDefined()
    await click("spinner-cancel")
    act(() => {
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({ outcome: "cancelled", reason: "in_app_cancel", prompts: "1" }),
    ])
  })

  it("leaving the screen during the request sends nothing, then or when the page goes", async () => {
    await toScreen()
    const entry = heldEntry()
    await click("sign-in-show-passkeys")
    expect(entry.request).toBeDefined()
    act(() => {
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([])
  })

  it("the refusal card's retry is a fresh attempt, counted as this page's second", async () => {
    await toFoundPasskey()
    answeredEntry(() => ({ entered: false, reason: "unknown", addresses: [L2] }))
    await click("sign-in-login")
    answeredEntry(() => ENTERED)
    await click("enter-retry")
    expect(events()).toEqual([
      expect.objectContaining({ outcome: "failed", reason: "registry_unconfirmed", attempt: "1" }),
      expect.objectContaining({ outcome: "succeeded", prompts: "1", attempt: "2" }),
    ])
  })

  it("a sign-in that replaces the document has reported before it does", async () => {
    const assign = vi.fn()
    vi.stubGlobal("location", { assign, origin: "https://wallet.test" })
    localStorage.setItem("webwallet.storageId", "storage-a")
    try {
      await toScreen()
      answeredEntry(() => {
        localStorage.setItem("webwallet.storageId", "storage-b")
        return ENTERED
      })
      await click("sign-in-show-passkeys")
      expect(assign).toHaveBeenCalledWith("/enter")
      const sent = h.fireEvent.mock.calls.findIndex(([name]) => name === "passkey_ceremony")
      expect(events()).toEqual([expect.objectContaining({ outcome: "succeeded" })])
      expect(h.fireEvent.mock.invocationCallOrder[sent]).toBeLessThan(
        assign.mock.invocationCallOrder[0]!,
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
