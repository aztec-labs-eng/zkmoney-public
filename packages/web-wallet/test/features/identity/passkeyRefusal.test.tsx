/** Guards: no step mid-attempt, and the in-app way out leaks no secret and no stale copy error. */
import { act, StrictMode, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tabStash } from "../../../src/platform/storage/tabStash"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { PasskeyRefusal } = await import("../../../src/features/identity/PasskeyRefusal")
type RouteRefusal = import("../../../src/features/identity/PasskeyRefusal").RouteRefusal
const errors = await import("@obsidion/passkey-web")
const { stashClaimLink } = await import("../../../src/features/paylink/claimStash")
const { CONNECT_STASH_KEY } = await import("../../../src/features/contacts/connectReceive")
const { openTestSession } = await import("../../support/session")
const { closeSession } = await import("../../../src/session/session")

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("PasskeyRefusal after a creation on this computer", () => {
  const phoneExit = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="passkey-phone"]')
  const retry = () => container.querySelector<HTMLButtonElement>('[data-testid="passkey-retry"]')
  const refused = (over: Partial<RouteRefusal> = {}): RouteRefusal => {
    const e = new errors.LaptopPasskeyRefusedError("apple", ["gpm"])
    return {
      name: e.name,
      message: e.message,
      leftover: true,
      appleRefusedHere: e.appleRefusedHere,
      route: "this-device",
      reach: "ok",
      ...over,
    }
  }

  it("presses neither the phone nor Try again while an attempt runs", async () => {
    const onRetry = vi.fn()
    const onPhone = vi.fn()
    await act(async () =>
      root.render(<PasskeyRefusal error={refused()} onRetry={onRetry} onPhone={onPhone} busy />),
    )
    await act(async () => {
      phoneExit()!.click()
      retry()!.click()
    })
    expect(onPhone).not.toHaveBeenCalled()
    expect(onRetry).not.toHaveBeenCalled()
  })
})

describe("PasskeyRefusal in an app's built-in browser", () => {
  const UA = {
    android:
      "Mozilla/5.0 (Linux; Android 16; Pixel 9 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.0.0 Mobile Safari/537.36",
  }
  const unsupported = new DOMException(
    "Error connecting to Web Authentication service",
    "NotSupportedError",
  )
  const notSupported = {
    name: "NotSupportedError",
    message: unsupported.message,
    cause: unsupported,
  }
  const startUrl = window.location.href
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  const execCommand = Object.getOwnPropertyDescriptor(document, "execCommand")

  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const buttonNamed = (label: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)
  const escape = () => byTestId("open-in-browser")
  const link = () => byTestId("open-in-browser-link") as HTMLAnchorElement | null

  function as(userAgent: string, address: string) {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
    window.history.replaceState(null, "", address)
  }

  async function show(ui: ReactNode, state?: unknown, strict = false) {
    closeSession()
    openTestSession()
    const tree = <MemoryRouter initialEntries={[{ pathname: "/", state }]}>{ui}</MemoryRouter>
    await act(async () => root.render(strict ? <StrictMode>{tree}</StrictMode> : tree))
  }

  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState(null, "", startUrl)
    sessionStorage.clear()
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard)
    else delete (navigator as { clipboard?: unknown }).clipboard
    if (execCommand) Object.defineProperty(document, "execCommand", execCommand)
    else delete (document as { execCommand?: unknown }).execCommand
  })

  it.each([
    ["the payment-link page", "/link#secret-frag"],
    ["a return path holding a fragment", "/enter?next=%2Frequest%23secret-packet"],
  ])("on %s gives the app's menu and the original link, never a built one", async (_n, address) => {
    as(UA.android, address)
    await show(<PasskeyRefusal error={notSupported} onRetry={() => {}} />)
    expect(escape()!.dataset.escape).toBe("hint")
    expect(link()).toBeNull()
    expect(buttonNamed("Copy link")).toBeUndefined()
    expect(container.innerHTML).not.toContain("secret")
    expect(byTestId("passkey-retry")!.className).not.toContain("ww-invite-pill")
  })

  it.each<[string, () => void, unknown]>([
    ["a payment request in router memory", () => {}, { request: { amount: "12", note: "rent" } }],
    ["a waiting payment link", () => stashClaimLink(tabStash, "secret-frag"), undefined],
    ["a waiting contact link", () => sessionStorage.setItem(CONNECT_STASH_KEY, "{}"), undefined],
  ])("with %s asks for the original link only", async (_n, seed, state) => {
    as(UA.android, "/contacts/alice/send")
    seed()
    await show(<PasskeyRefusal error={notSupported} onRetry={() => {}} />, state)
    expect(escape()!.dataset.escape).toBe("reopen")
    expect(link()).toBeNull()
    expect(container.innerHTML).not.toContain("secret")
    expect(container.innerHTML).not.toContain("rent")
  })

  const seedGrant = (handle: string) => {
    sessionStorage.setItem("obsidion.name-grant", "grant-token")
    sessionStorage.setItem("obsidion.name-grant-handle", handle)
  }

  it("with a name grant on its claim page asks for the original link only", async () => {
    as(UA.android, "/claim/alice")
    seedGrant("alice")
    await show(<PasskeyRefusal error={notSupported} onRetry={() => {}} />)
    expect(escape()!.dataset.escape).toBe("reopen")
    expect(link()).toBeNull()
  })

  it.each([
    ["failure", false],
    ["success", true],
  ])("an older copy's %s landing last leaves no stale failure", async (_n, firstOk) => {
    as(UA.android, "/enter")
    let settleFirst!: () => void
    const denied = () => Promise.reject(new Error("denied"))
    const writeText = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            settleFirst = () => (firstOk ? resolve() : reject(new Error("denied")))
          }),
      )
      .mockImplementationOnce(firstOk ? denied : async () => {})
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    Object.defineProperty(document, "execCommand", { value: () => false, configurable: true })
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      await show(<PasskeyRefusal error={notSupported} />)
      await act(async () => buttonNamed("Copy link")!.click())
      await act(async () => buttonNamed("Copy link")!.click())
      await act(async () => settleFirst())
      // One of the two copies landed: the link is on the clipboard.
      expect(escape()!.textContent).toContain("Link copied.")
      await act(async () => vi.advanceTimersByTime(2000))
      expect(writeText).toHaveBeenCalledTimes(2)
      expect(escape()!.textContent).not.toContain("Couldn't copy")
    } finally {
      vi.useRealTimers()
    }
  })
})
