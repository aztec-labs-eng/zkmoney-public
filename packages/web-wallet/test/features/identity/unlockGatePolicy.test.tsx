/** Guards: only a verified passkey unlock opens the wallet, and a stale one shows nothing. */
import type { PasskeyRequestScope } from "@obsidion/passkey-web"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { committed, seedDeviceKeys } from "../../support/page"
import catalogCopy from "../../../src/errors/catalog.copy"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
vi.setConfig({ testTimeout: 30_000 })

/** A wallet whose derivation depends on `this` and takes the passkey set, like the real one. */
class FakeWallet {
  readonly tag = "wallet"
  async deriveAccountAddress(msk: { toString(): string }, passkeys: readonly string[]) {
    return { toString: () => `${this.tag}:${msk.toString()}:${passkeys.join(",")}` }
  }
}

type Derive = (msk: { toString(): string }, passkeys: readonly string[]) => Promise<string>

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

vi.mock("../../../src/lib/analytics", () => ({ fireEvent: h.fireEvent, failureCode: () => "err" }))

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
  Icon: () => <i />,
  IconCircle: () => <i />,
}))

let container: HTMLDivElement
let root: Root

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))

/**
 * The page's wallet when the test has one, and a stored account that is locked: its unlock fails
 * with `h.unlockError`, and each retry runs `h.retryUnlock` first.
 */
async function openLockedSession() {
  const { service } = await import("@obsidion/front-core")
  const { openTestSession } = await import("../../support/session")
  const { giveAccountRecord } = await import("../../support/accountRecord")
  const auth = {
    unlock: h.unlock,
    probePhoneReach: h.probePhoneReach,
    suggestedRoute: h.suggestedRoute,
    clear: h.clear,
    lockOut: h.clear,
  }
  const session = openTestSession({ wallet: h.wallet, auth })
  await giveAccountRecord(
    { type: "saved", completeAddress: "0xacct", signer: { credentialId: "cred", pubkey: "p" } },
    session,
  )
  let builds = 0
  const account = service("account", { from: [], retry: "manual" }, async () => {
    if (builds++ > 0) await h.retryUnlock()
    throw new Error(h.unlockError)
  })
  Object.defineProperty(session, "account", { configurable: true, value: account })
}

async function render(entry: string | { pathname: string; state: unknown } = "/") {
  const { UnlockGate } = await import("../../../src/features/identity/UnlockGate/UnlockGate")
  await openLockedSession()
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
  const { writeDeviceKeys } = await import("../../../src/platform/storage/deviceKeys")
  const { testPage } = await import("../../support/page")
  await writeDeviceKeys(testPage().database, { storageId: "aaa", credentialId })
  await seedDeviceKeys({
    passkeyMap: JSON.stringify({
      version: 1,
      entries: { cred: { credentialId: "cred", rpId: "localhost", l2Address: "0xabc" } },
    }),
  })
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
    expect(container.textContent).toContain("Loading zk.money")
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
    await expect(derive({ toString: () => "msk" }, ["ab"])).resolves.toBe("wallet:msk:ab")
    expect(h.retryUnlock).toHaveBeenCalledTimes(1)
  })

  describe("a wallet with a backup", () => {
    const ROOT = "aa".repeat(64)
    const SPARE = "bb".repeat(64)
    /** The session's root record with both keys in its set, and, when `spare`, the backup's record. */
    async function seedWallet(spare: boolean, session = "cred") {
      const entries: Record<string, unknown> = {
        cred: {
          credentialId: "cred",
          rpId: "localhost",
          l2Address: "0xabc",
          pubkey: ROOT,
          isMskRoot: true,
          passkeySet: [ROOT, SPARE],
        },
      }
      if (spare) {
        entries.spare = {
          credentialId: "spare",
          rpId: "localhost",
          l2Address: "0xabc",
          pubkey: SPARE,
          isMskRoot: false,
          backup: { account: `0x${"11".repeat(20)}`, envelope: `0x${"00".repeat(62)}` },
          passkeySet: [ROOT, SPARE],
        }
      }
      await seedDeviceKeys({ passkeyMap: JSON.stringify({ version: 1, entries }) })
      return session
    }
    const otherKey = () => byTestId("unlock-other-key") as HTMLButtonElement | null
    const card = (label: string) =>
      container.querySelector<HTMLButtonElement>(
        `[data-testid="unlock-keys"] button[aria-label="${label}"]`,
      )
    const backupCard = () => card("Unlock with the backup passkey")

    it("offers the backup this browser recorded and unlocks with that key alone; its refusal offers the other key", async () => {
      const { PhoneRequiredError } = await import("@obsidion/passkey-web")
      await seedWallet(true)
      h.wallet = new FakeWallet()
      h.unlock
        .mockRejectedValueOnce(new PhoneRequiredError())
        .mockRejectedValueOnce(new PhoneRequiredError())
      await render()
      // The wallet's keys as cards in place of the unlock button; the session's key was last used.
      expect(unlockButton()).toBeUndefined()
      expect(
        Array.from(container.querySelectorAll('[data-testid="unlock-keys"] button'), (b) =>
          b.getAttribute("aria-label"),
        ),
      ).toEqual([
        "Unlock with the sign-up passkey, last used on this browser",
        "Unlock with the backup passkey",
      ])
      expect(otherKey()).toBeNull()
      expect(byTestId("unlock-choose-passkey")?.textContent).toBe("Use a different passkey")
      await act(async () => backupCard()!.click())
      await flush()
      expect(h.unlock.mock.calls[0]![1]).toMatchObject({ credentialId: "spare" })
      // The refusal's retry asks the same key; its alternative is the key that did not fail.
      const alternatives = () =>
        Array.from(
          container.querySelectorAll('[data-testid="unlock-other-key"]'),
          (b) => b.textContent,
        )
      expect(alternatives()).toEqual(["Use your sign-up passkey"])
      await act(async () => byTestId("unlock-retry")!.click())
      await flush()
      expect(h.unlock.mock.calls[1]![1]).toMatchObject({ credentialId: "spare" })
      expect(alternatives()).toEqual(["Use your sign-up passkey"])
      await act(async () => otherKey()!.click())
      await flush()
      expect(h.unlock.mock.calls[2]![1]).toMatchObject({ credentialId: "cred" })
      expect(h.retryUnlock).toHaveBeenCalledTimes(1)
    })

    it("a chosen key's wrong-key card keeps that key: the phone asks for it, and the exit hides it", async () => {
      const { StoredAddressMismatchError } = await import("@obsidion/front-core")
      const wrongKey = () =>
        Object.assign(new StoredAddressMismatchError(), {
          verdict: "wrong-key",
          observed: { credentialId: "spare", attachment: "platform" },
        })
      const ua = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent")!
      Object.defineProperty(navigator, "userAgent", {
        value:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/155.0.0.0 Safari/537.36",
        configurable: true,
      })
      try {
        await seedWallet(true)
        h.wallet = new FakeWallet()
        h.unlock.mockRejectedValueOnce(wrongKey()).mockRejectedValueOnce(wrongKey())
        await render()
        await act(async () => backupCard()!.click())
        await flush()
        await act(async () => byTestId("unlock-phone")!.click())
        await flush()
        expect(h.unlock.mock.calls[1]![1]).toMatchObject({ phone: true, credentialId: "spare" })
        expect(h.clear).not.toHaveBeenCalled()
        await act(async () => byTestId("unlock-choose-passkey")!.click())
        await flush()
        expect(h.assign).toHaveBeenCalledWith("/enter?choose=1&avoid=spare")
      } finally {
        Object.defineProperty(navigator, "userAgent", ua)
      }
    })

    it("a backup this browser holds no record of is found on /enter, from the row's keys", async () => {
      await seedWallet(false)
      h.wallet = new FakeWallet()
      await render()
      expect(otherKey()?.textContent).toBe("Use your backup passkey")
      await act(async () => otherKey()!.click())
      await flush()
      expect(h.unlock).not.toHaveBeenCalled()
      expect(h.clear).toHaveBeenCalledTimes(1)
      expect(h.assign).toHaveBeenCalledWith("/enter?pick=cred")
    })

    it("a wallet of three keys, one without a record here, offers another passkey by /enter", async () => {
      const map = {
        version: 1,
        entries: {
          cred: {
            credentialId: "cred",
            rpId: "localhost",
            l2Address: "0xabc",
            pubkey: ROOT,
            isMskRoot: true,
            passkeySet: [ROOT, SPARE, "cc".repeat(64)],
          },
        },
      }
      await seedDeviceKeys({ passkeyMap: JSON.stringify(map) })
      h.wallet = new FakeWallet()
      await render()
      expect(otherKey()?.textContent).toBe("Use another passkey")
      expect(byTestId("unlock-keys")).toBeNull()
    })

    it("a wallet of three keys, all recorded here, offers each as a card and unlocks with the one tapped", async () => {
      const THIRD = "cc".repeat(64)
      const passkeySet = [ROOT, SPARE, THIRD]
      const backup = (credentialId: string, pubkey: string) => ({
        credentialId,
        rpId: "localhost",
        l2Address: "0xabc",
        pubkey,
        isMskRoot: false,
        backup: { account: `0x${"11".repeat(20)}`, envelope: `0x${"00".repeat(62)}` },
        passkeySet,
      })
      const entries = {
        cred: {
          credentialId: "cred",
          rpId: "localhost",
          l2Address: "0xabc",
          pubkey: ROOT,
          isMskRoot: true,
          passkeySet,
        },
        spare: backup("spare", SPARE),
        third: backup("third", THIRD),
      }
      await seedDeviceKeys({ passkeyMap: JSON.stringify({ version: 1, entries }) })
      h.wallet = new FakeWallet()
      await render()
      expect(
        Array.from(container.querySelectorAll('[data-testid="unlock-keys"] button'), (b) =>
          b.getAttribute("aria-label"),
        ),
      ).toEqual([
        "Unlock with the sign-up passkey, last used on this browser",
        "Unlock with the backup passkey 1",
        "Unlock with the backup passkey 2",
      ])
      expect(container.textContent).toContain("Any of them opens the same wallet.")
      expect(otherKey()).toBeNull()
      await act(async () => card("Unlock with the backup passkey 2")!.click())
      await flush()
      expect(h.unlock.mock.calls[0]![1]).toMatchObject({ credentialId: "third" })
    })
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
    expect(h.clear).toHaveBeenCalledTimes(1)
    expect(committed().credentialId).toBeNull()
    expect(h.assign).toHaveBeenCalledWith("/enter?choose=1")
  })

  it("a backup record whose envelope did not open shows the wallet's card by name, with a retry", async () => {
    const { PasskeyEnvelopeError } = await import("@obsidion/front-core")
    h.wallet = new FakeWallet()
    await render()
    h.unlock.mockRejectedValueOnce(new PasskeyEnvelopeError("decrypt"))
    await tapUnlock()
    expect(byTestId("unlock-refused")?.dataset.reason).toBe("PasskeyEnvelopeError")
    expect(byTestId("unlock-retry")).not.toBeNull()
    expect(h.fireEvent).toHaveBeenCalledWith("action_failed", {
      action: "identity:unlock",
      code: "err",
    })
    expect(h.retryUnlock).not.toHaveBeenCalled()
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
    // This copy would answer a retry again; the way on is another device, picked on the sign-in
    // screen with this credential's row hidden.
    expect(byTestId("unlock-retry")).toBeNull()
    expect(byTestId("unlock-show-passkeys")).not.toBeNull()
    await act(async () => byTestId("unlock-show-passkeys")!.click())
    await flush()
    expect(h.clear).toHaveBeenCalledTimes(1)
    expect(h.assign).toHaveBeenCalledWith("/enter?choose=1&avoid=cred")
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
    await seedDeviceKeys({ passkeyMap: null })
    h.wallet = new FakeWallet()
    await render()
    expect(container.textContent).toContain("enter route")
    expect(h.unlock).not.toHaveBeenCalled()
  })

  it("a session that changed while the prompt was open ends the click quietly", async () => {
    const { SessionChangedError } = await import("../../../src/platform/auth/sessionErrors")
    h.wallet = new FakeWallet()
    h.unlock.mockRejectedValueOnce(new SessionChangedError())
    await render()
    await tapUnlock()
    expect(container.textContent).not.toContain("enter route")
    expect(byTestId("unlock-refused")).toBeNull()
    expect(h.retryUnlock).not.toHaveBeenCalled()
    expect(unlockButton()).toBeDefined()
  })

  it("a passkey that worked but an account that would not install shows the generic words", async () => {
    h.wallet = new FakeWallet()
    await render()
    expect(byTestId("unlock-install-failed")).toBeNull()

    // The unlock succeeds and front-core's install fails: the pane stays and says why.
    h.retryUnlock.mockImplementationOnce(async () => {
      h.unlockError = "Historical contract instance is missing"
    })
    await tapUnlock()
    expect(unlockButton()).toBeDefined()
    expect(byTestId("unlock-install-failed")?.textContent).toContain(catalogCopy.unknown)

    // The next tap starts clean.
    h.unlock.mockRejectedValueOnce(Object.assign(new Error("closed"), { name: "NotAllowedError" }))
    await tapUnlock()
    expect(byTestId("unlock-install-failed")).toBeNull()
  })

  it("an unlock that finds no passkey session goes to /enter", async () => {
    const { NoPasskeySessionError } = await import("../../../src/platform/auth/sessionErrors")
    h.wallet = new FakeWallet()
    h.unlock.mockRejectedValueOnce(new NoPasskeySessionError())
    await render()
    await tapUnlock()
    expect(container.textContent).toContain("enter route")
  })
})

/** An unlock inside an app's built-in browser, where the passkey can't be used at all. */
describe("UnlockGate in an app's built-in browser", () => {
  const UA = {
    android:
      "Mozilla/5.0 (Linux; Android 16; Pixel 9 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.0.0 Mobile Safari/537.36",
    iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
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

  const reports: unknown[] = []
  let unsubscribe = () => {}

  beforeEach(async () => {
    sessionStorage.clear()
    h.wallet = new FakeWallet()
    const { subscribeErrorModal } = await import("../../../src/errors/errorModal")
    reports.length = 0
    unsubscribe = subscribeErrorModal((payload) => reports.push(payload))
  })
  afterEach(() => {
    unsubscribe()
    ua?.mockRestore()
    ua = undefined
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
