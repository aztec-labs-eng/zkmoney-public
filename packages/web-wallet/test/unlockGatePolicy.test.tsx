/**
 * The unlock gate: no ceremony starts before the wallet exists (it is what verifies the recovered
 * key); on every posture the locked pane is a single unlock button that opens the browser's own
 * prompt, with no probe. A refusal renders in place with its exits; a browser without a record for
 * the active passkey, or an unlock with no session, goes to /enter.
 */
import type { PasskeyRequestScope } from "@obsidion/passkey-web"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../src/platform/storage/walletStorage"
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

/** A wallet whose derivation depends on `this` and takes the signing key, like the real one. */
class FakeWallet {
  readonly tag = "wallet"
  async deriveAccountAddress(msk: { toString(): string }, pubkeyHex: string) {
    return { toString: () => `${this.tag}:${msk.toString()}:${pubkeyHex}` }
  }
}

type Derive = (msk: { toString(): string }, pubkeyHex: string) => Promise<string>

const h = vi.hoisted(() => ({
  unlock: vi.fn(
    async (_derive: Derive, _opts?: { signal?: AbortSignal; own?: PasskeyRequestScope }) => {},
  ),
  probePhoneReach: vi.fn(async () => "unknown"),
  suggestedRoute: vi.fn(async (_credentialId?: string) => "this-device"),
  clear: vi.fn(),
  retryUnlock: vi.fn(async () => {}),
  unlockError: "locked",
  wallet: undefined as unknown,
  assign: vi.fn(),
  fireEvent: vi.fn(),
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAccountContext: () => ({
    obsidionAccount: undefined,
    accountExists: true,
    unlockError: h.unlockError,
    retryUnlock: h.retryUnlock,
  }),
  useAztecContext: () => ({ obsidionWallet: h.wallet }),
}))
vi.mock("../src/platform/auth/useAuthenticator", () => {
  const auth = () => ({
    unlock: h.unlock,
    probePhoneReach: h.probePhoneReach,
    suggestedRoute: h.suggestedRoute,
    clear: h.clear,
    lockOut: h.clear,
  })
  return { getAuthService: auth, peekAuthService: auth }
})
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ rpId: "localhost" }),
}))
vi.mock("../src/dev/demoFlag", () => ({ isDemoMode: () => false }))
vi.mock("../src/ui/PxeBoot", () => ({ BootSplash: () => <div>boot splash</div> }))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("../src/lib/analytics", () => ({ fireEvent: h.fireEvent, failureCode: () => "err" }))
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

async function render(entry: string | { pathname: string; state: unknown } = "/") {
  const { UnlockGate } = await import("../src/features/identity/UnlockGate")
  const gate = (
    <UnlockGate>
      <span>wallet surface</span>
    </UnlockGate>
  )
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/" element={gate} />
          <Route path="/contacts/:tag/send" element={gate} />
          <Route path="/enter" element={<div>enter route</div>} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await flush()
}

/** This browser's record for the active passkey, the way a commit leaves it. */
async function seedRecord(credentialId = "cred") {
  const { setActiveCredentialId, setActiveStorageId } = await import(
    "../src/platform/storage/activeStorage"
  )
  setActiveStorageId("aaa")
  setActiveCredentialId(credentialId)
  walletStorage.setItem(
    "obsidion.obsidion_web_passkey_identity_map",
    JSON.stringify({
      version: 1,
      entries: { cred: { credentialId: "cred", rpId: "localhost", l2Address: "0xabc" } },
    }),
  )
}

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const unlockButton = () =>
  [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Unlock with passkey"),
  )!
const tapUnlock = async () => {
  await act(async () => unlockButton().click())
  await flush()
}

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  h.unlock.mockReset()
  h.probePhoneReach.mockReset().mockResolvedValue("unknown")
  h.suggestedRoute.mockReset().mockResolvedValue("this-device")
  h.clear.mockClear()
  h.retryUnlock.mockClear()
  h.unlockError = "locked"
  h.assign.mockClear()
  h.fireEvent.mockClear()
  h.wallet = undefined
  Object.defineProperty(window, "location", { value: { assign: h.assign }, writable: true })
  await seedRecord()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("UnlockGate", () => {
  it("shows the splash and starts no ceremony until the wallet exists", async () => {
    await render()
    expect(container.textContent).toContain("boot splash")
    expect(unlockButton()).toBeUndefined()
    expect(h.unlock).not.toHaveBeenCalled()
  })

  it("on a laptop the pane holds the ceremony until Unlock is tapped, then unlocks through a closure over the wallet", async () => {
    h.wallet = new FakeWallet()
    await render()
    expect(unlockButton()).toBeDefined()
    // The browser's own prompt decides which device answers, so nothing is probed first.
    expect(h.probePhoneReach).not.toHaveBeenCalled()
    expect(h.unlock).not.toHaveBeenCalled()

    await tapUnlock()
    expect(h.unlock).toHaveBeenCalledTimes(1)
    const [derive, opts] = h.unlock.mock.calls[0]! as [Derive, { signal: AbortSignal }]
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    // Called detached from the wallet, the way the service calls it, with the record's key.
    await expect(derive({ toString: () => "msk" }, "ab")).resolves.toBe("wallet:msk:ab")
    expect(h.retryUnlock).toHaveBeenCalledTimes(1)
  })

  it("the laptop pane keeps the way to a different passkey", async () => {
    h.wallet = new FakeWallet()
    await render()
    expect(unlockButton()).toBeDefined()
    expect(byTestId("unlock-choose-passkey")).not.toBeNull()
  })

  it("leaving the screen ends the attempt, and its late answer installs nothing", async () => {
    h.wallet = new FakeWallet()
    let finish!: () => void
    h.unlock.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
    await render()
    await tapUnlock()
    const signal = (h.unlock.mock.calls[0]![1] as { signal: AbortSignal }).signal
    expect(signal.aborted).toBe(false)
    act(() => root.unmount())
    expect(signal.aborted).toBe(true)
    await act(async () => finish())
    await flush()
    expect(h.retryUnlock).not.toHaveBeenCalled()
    root = createRoot(container)
  })

  it("a policy refusal renders in place with a retry and the chooser exit", async () => {
    const { PhoneRequiredError } = await import("@obsidion/passkey-web")
    h.wallet = new FakeWallet()
    h.unlock.mockRejectedValueOnce(new PhoneRequiredError())
    await render()
    await tapUnlock()
    expect(byTestId("unlock-refused")?.dataset.reason).toBe("PhoneRequiredError")
    expect(byTestId("unlock-retry")).not.toBeNull()
    expect(h.retryUnlock).not.toHaveBeenCalled()

    // "Use a different passkey" signs out and reloads into the chooser.
    await act(async () => byTestId("unlock-choose-passkey")!.click())
    const { getActiveCredentialId } = await import("../src/platform/storage/activeStorage")
    expect(h.clear).toHaveBeenCalledTimes(1)
    expect(getActiveCredentialId()).toBeNull()
    expect(h.assign).toHaveBeenCalledWith("/enter?choose=1")
  })

  it("a certain wrong-key mismatch shows the wrong-key card: Show passkeys, no retry, the failing credential avoided", async () => {
    const { StoredAddressMismatchError } = await import("@obsidion/front-core")
    h.wallet = new FakeWallet()
    h.unlock.mockRejectedValueOnce(
      Object.assign(new StoredAddressMismatchError(), { verdict: "wrong-key" }),
    )
    await render()
    await tapUnlock()
    expect(byTestId("unlock-refused")?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(container.textContent).toContain("wrong key")
    // This copy would answer a retry again; the way on is another device, picked on the sign-in
    // screen with this credential's row hidden.
    expect(byTestId("unlock-retry")).toBeNull()
    expect(byTestId("unlock-show-passkeys")).not.toBeNull()
    await act(async () => byTestId("unlock-show-passkeys")!.click())
    await flush()
    expect(h.clear).toHaveBeenCalledTimes(1)
    expect(h.assign).toHaveBeenCalledWith("/enter?choose=1&avoid=cred")
  })

  it("a not-reproduced mismatch keeps the retry", async () => {
    const { StoredAddressMismatchError } = await import("@obsidion/front-core")
    h.wallet = new FakeWallet()
    h.unlock.mockRejectedValueOnce(
      Object.assign(new StoredAddressMismatchError(), { verdict: "not-reproduced" }),
    )
    await render()
    await tapUnlock()
    expect(byTestId("unlock-refused")?.dataset.reason).toBe("StoredAddressMismatchError")
    expect(byTestId("unlock-retry")).not.toBeNull()
  })

  it("a retry from the refusal card aborts the attempt behind the last prompt", async () => {
    const { PhoneRequiredError } = await import("@obsidion/passkey-web")
    h.wallet = new FakeWallet()
    h.unlock.mockRejectedValueOnce(new PhoneRequiredError())
    await render()
    await tapUnlock()
    expect(byTestId("unlock-refused")).not.toBeNull()
    const first = (h.unlock.mock.calls[0]![1] as { signal: AbortSignal }).signal
    expect(first.aborted).toBe(false)
    await act(async () => byTestId("unlock-retry")!.click())
    await flush()
    // The newer tap supersedes: the old attempt is torn down before the new flight starts.
    expect(first.aborted).toBe(true)
    expect(h.unlock).toHaveBeenCalledTimes(2)
  })

  it("on a phone the passkey exit is held while the unlock ceremony runs", async () => {
    const ua = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent")!
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)",
      configurable: true,
    })
    try {
      h.wallet = new FakeWallet()
      h.unlock.mockImplementationOnce(() => new Promise(() => {}))
      await render()
      const exit = () => byTestId("unlock-choose-passkey") as HTMLButtonElement
      expect(exit().disabled).toBe(false)
      await act(async () => unlockButton().click())
      await flush()
      expect(exit().disabled).toBe(true)
      expect(h.clear).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, "userAgent", ua)
    }
  })

  it("no record for the active passkey goes straight to /enter", async () => {
    walletStorage.removeItem("obsidion.obsidion_web_passkey_identity_map")
    h.wallet = new FakeWallet()
    await render()
    expect(container.textContent).toContain("enter route")
    expect(h.unlock).not.toHaveBeenCalled()
  })

  it("a session that changed while the prompt was open ends the click quietly", async () => {
    const { SessionChangedError } = await import("../src/platform/auth/sessionErrors")
    h.wallet = new FakeWallet()
    h.unlock.mockRejectedValueOnce(new SessionChangedError())
    await render()
    await tapUnlock()
    expect(container.textContent).not.toContain("enter route")
    expect(byTestId("unlock-refused")).toBeNull()
    expect(h.retryUnlock).not.toHaveBeenCalled()
    expect(unlockButton()).toBeDefined()
  })

  it("a prompt that answered with no credential ends the click quietly", async () => {
    const { showReportableError } = await import("../src/errors/errorModal")
    h.wallet = new FakeWallet()
    h.unlock.mockRejectedValueOnce(new Error("Passkey assertion returned no credential"))
    await render()
    await tapUnlock()
    expect(showReportableError).not.toHaveBeenCalled()
    expect(byTestId("unlock-refused")).toBeNull()
    expect(h.retryUnlock).not.toHaveBeenCalled()
    expect(unlockButton()).toBeDefined()
  })

  it("a passkey that worked but an account that would not install shows front-core's reason", async () => {
    h.wallet = new FakeWallet()
    await render()
    expect(byTestId("unlock-install-failed")).toBeNull()

    // The unlock succeeds and front-core's install fails: the pane stays and says why.
    h.retryUnlock.mockImplementationOnce(async () => {
      h.unlockError = "Historical contract instance is missing"
    })
    await tapUnlock()
    expect(unlockButton()).toBeDefined()
    expect(byTestId("unlock-install-failed")?.textContent).toContain(
      "Historical contract instance is missing",
    )

    // The next tap starts clean.
    h.unlock.mockRejectedValueOnce(Object.assign(new Error("closed"), { name: "NotAllowedError" }))
    await tapUnlock()
    expect(byTestId("unlock-install-failed")).toBeNull()
  })

  it("an unlock that finds no passkey session goes to /enter", async () => {
    const { NoPasskeySessionError } = await import("../src/platform/auth/sessionErrors")
    h.wallet = new FakeWallet()
    h.unlock.mockRejectedValueOnce(new NoPasskeySessionError())
    await render()
    await tapUnlock()
    expect(container.textContent).toContain("enter route")
  })

  it("on a phone the locked pane is a single unlock button, no picker, no probe", async () => {
    const ua = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent")!
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)",
      configurable: true,
    })
    try {
      h.wallet = new FakeWallet()
      await render()
      expect(byTestId("route-picker")).toBeNull()
      expect(h.probePhoneReach).not.toHaveBeenCalled()
      await act(async () => unlockButton().click())
      await flush()
      expect(h.unlock).toHaveBeenCalledTimes(1)
      // A phone hands no route; the service ignores it there.
      expect((h.unlock.mock.calls[0]![1] as { route?: string }).route).toBeUndefined()
    } finally {
      Object.defineProperty(navigator, "userAgent", ua)
    }
  })
})

/** An unlock inside an app's built-in browser, where the passkey can't be used at all. */
describe("UnlockGate in an app's built-in browser", () => {
  const UA = {
    android:
      "Mozilla/5.0 (Linux; Android 16; Pixel 9 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.0.0 Mobile Safari/537.36",
    iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
    iosSafari:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
    laptop:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  }
  const unsupported = () =>
    new DOMException("Error connecting to Web Authentication service", "NotSupportedError")
  const failures = () =>
    h.fireEvent.mock.calls.filter(([event]) => event === "action_failed").map(([, props]) => props)
  let ua: { mockRestore: () => void } | undefined

  /** The signed-in page at `pathname` in a browser with this user agent. */
  const at = (pathname: string, userAgent: string) => {
    ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
    const origin = "https://wallet.test"
    Object.defineProperty(window, "location", {
      value: {
        assign: h.assign,
        origin,
        href: `${origin}${pathname}`,
        pathname,
        search: "",
        hash: "",
      },
      writable: true,
    })
  }

  beforeEach(async () => {
    sessionStorage.clear()
    h.wallet = new FakeWallet()
    const { showReportableError } = await import("../src/errors/errorModal")
    vi.mocked(showReportableError).mockClear()
  })
  afterEach(() => {
    ua?.mockRestore()
    ua = undefined
  })

  it("a not-supported unlock shows the card with Chrome opening the sign-in page, not the error modal", async () => {
    const { showReportableError } = await import("../src/errors/errorModal")
    at("/", UA.android)
    h.unlock.mockRejectedValueOnce(unsupported())
    await render()
    await tapUnlock()
    expect(byTestId("unlock-refused")?.dataset.reason).toBe("NotSupportedError")
    expect(byTestId("open-in-browser-link")!.getAttribute("href")).toBe(
      "intent://wallet.test/enter#Intent;scheme=https;package=com.android.chrome;end",
    )
    expect(byTestId("unlock-retry")).not.toBeNull()
    expect(byTestId("unlock-choose-passkey")).not.toBeNull()
    expect(showReportableError).not.toHaveBeenCalled()
    expect(failures()).toEqual([{ action: "identity:unlock", code: "err" }])
  })

  it("the same failure on a payment request's send says to open the link again, with no link", async () => {
    at("/contacts/alice/send", UA.android)
    h.unlock.mockRejectedValueOnce(unsupported())
    await render({ pathname: "/contacts/alice/send", state: { request: { amount: "1" } } })
    await tapUnlock()
    expect(byTestId("unlock-refused")?.dataset.reason).toBe("NotSupportedError")
    expect(byTestId("open-in-browser")?.dataset.escape).toBe("reopen")
    expect(byTestId("open-in-browser-link")).toBeNull()
  })

  it.each([
    ["an iPhone app browser", UA.iosX],
    ["a laptop", UA.laptop],
    ["iPhone Safari", UA.iosSafari],
  ])("a closed prompt in %s leaves the pane as it was", async (_name, userAgent) => {
    const { showReportableError } = await import("../src/errors/errorModal")
    at("/", userAgent)
    h.unlock.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    await render()
    await tapUnlock()
    expect(byTestId("unlock-refused")).toBeNull()
    expect(unlockButton()).toBeDefined()
    expect(showReportableError).not.toHaveBeenCalled()
    expect(failures()).toEqual([])
  })

  it("an attempt a newer tap replaced shows nothing when it fails as not supported", async () => {
    at("/", UA.android)
    let fail!: (e: unknown) => void
    h.unlock
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => (fail = reject)))
      .mockImplementationOnce(() => new Promise<void>(() => {}))
    await render()
    await tapUnlock()
    await tapUnlock()
    await act(async () => fail(unsupported()))
    await flush()
    expect(byTestId("unlock-refused")).toBeNull()
    expect(failures()).toEqual([])
  })
})

/** One `passkey_ceremony` per unlock tap, classified from what the auth service threw. */
describe("UnlockGate passkey telemetry", () => {
  let harness: Awaited<ReturnType<typeof passkeyTelemetryHarness>>
  const events = () => passkeyEvents(h.fireEvent)
  const chooseAnother = () => byTestId("unlock-choose-passkey")!.click()

  beforeEach(async () => {
    harness = await passkeyTelemetryHarness()
    // An attempt an earlier test left open ends here, before this test counts anything.
    pageHide()
    h.fireEvent.mockClear()
    h.wallet = new FakeWallet()
  })

  it("an unlock that asked and succeeded is reported once", async () => {
    h.unlock.mockImplementationOnce(async (_derive, opts) => {
      await harness.answered("assert", opts?.own)
    })
    await render()
    await tapUnlock()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "unlock",
        flow: "unlock",
        outcome: "succeeded",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("an unlock whose stored account no longer reproduces reads as a passkey mismatch", async () => {
    const { StoredAddressMismatchError } = await import("@obsidion/front-core")
    h.unlock.mockImplementationOnce(async (_derive, opts) => {
      await harness.answered("assert", opts?.own)
      throw new StoredAddressMismatchError()
    })
    await render()
    await tapUnlock()
    expect(events()).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "passkey_mismatch", prompts: "1" }),
    ])
  })

  it("Use a different passkey after a refusal adds nothing to the one event it sent", async () => {
    const { StoredAddressMismatchError } = await import("@obsidion/front-core")
    h.unlock.mockImplementationOnce(async (_derive, opts) => {
      await harness.answered("assert", opts?.own)
      throw new StoredAddressMismatchError()
    })
    await render()
    await tapUnlock()
    // The pane's exits are disabled while an unlock runs, so this lands on a finished attempt.
    await act(async () => chooseAnother())
    act(() => pageHide())
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "passkey_mismatch", prompts: "1" }),
    ])
  })

  it("leaving the screen during the request sends nothing, then or when the page goes", async () => {
    const held: { request?: HeldRequest } = {}
    h.unlock.mockImplementationOnce(async (_derive, opts) => {
      held.request = harness.request("assert", opts?.signal, opts?.own)
      await held.request.settled
    })
    await render()
    await tapUnlock()
    expect(held.request).toBeDefined()
    act(() => {
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
    await flush()
    expect(events()).toEqual([])
  })

  it("a second tap while the first is still asking sends nothing for the first", async () => {
    const first: { request?: HeldRequest } = {}
    h.unlock
      .mockImplementationOnce(async (_derive, opts) => {
        first.request = harness.request("assert", opts?.signal, opts?.own)
        await first.request.settled
      })
      .mockImplementationOnce(async (_derive, opts) => {
        await harness.answered("assert", opts?.own)
      })
    await render()
    await tapUnlock()
    expect(first.request).toBeDefined()
    await tapUnlock()
    await flush()
    expect(h.unlock).toHaveBeenCalledTimes(2)
    expect(events()).toEqual([
      expect.objectContaining({ ceremony: "unlock", outcome: "succeeded", attempt: "2" }),
    ])
  })

  it("keeps a replaced unlock's own request out of the unlock that replaced it", async () => {
    let askLate!: () => void
    const late = new Promise<void>((resolve) => (askLate = resolve))
    const second: { request?: HeldRequest } = {}
    h.unlock
      .mockImplementationOnce(async (_derive, opts) => {
        await late
        await harness.answered("assert", opts?.own)
      })
      .mockImplementationOnce(async (_derive, opts) => {
        second.request = harness.request("assert", undefined, opts?.own)
        await second.request.settled
      })
    await render()
    await tapUnlock()
    await tapUnlock()
    expect(second.request).toBeDefined()
    // The replaced unlock asks the browser after its successor did, and owns that request.
    askLate()
    await flush()
    await act(async () => second.request!.answer())
    await flush()
    expect(events()).toEqual([
      expect.objectContaining({ ceremony: "unlock", outcome: "succeeded", prompts: "1" }),
      expect.objectContaining({ ceremony: "unlock", outcome: "succeeded", prompts: "1" }),
    ])
  })
})
