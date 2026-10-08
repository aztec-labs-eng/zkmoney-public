import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderSVG } from "uqr"
const mocks = vi.hoisted(() => ({
  phone: false,
  mint: vi.fn(),
  clipboard: vi.fn(),
  share: vi.fn(),
  record: vi.fn(),
  pending: false,
}))
vi.mock("../src/ui/usePhoneLayout", () => ({ usePhoneLayout: () => mocks.phone }))
vi.mock("../src/features/contacts/myCode", () => ({ mintMyConnectLink: mocks.mint }))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: "testnet" }) }))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: async () => ({ toBigInt: () => 123n }) }),
}))
vi.mock("../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ handle: "alice" }),
}))
vi.mock("../src/features/onboarding/webRegistration", () => ({
  useTagPresentationPending: () => mocks.pending,
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("../src/lib/analytics", () => ({ fireEvent: vi.fn() }))
vi.mock("@obsidion/front-core", async (original) => ({
  ...(await original<typeof import("@obsidion/front-core")>()),
  IssuedConnectStorage: { get: () => ({ recordHandshake: mocks.record }) },
}))
import { ShareTagModal } from "../src/features/contacts/ShareTagModal"
const link = "https://wallet.staging.zk.money/connect#full-handshake-packet-with-all-fields"

let root: Root, container: HTMLDivElement
const close = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  mocks.phone = false
  mocks.pending = false
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  mocks.mint.mockResolvedValue(link)
  mocks.clipboard.mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.clipboard },
  })
  Object.defineProperty(navigator, "share", { configurable: true, value: undefined })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const click = async (label: string) => {
  const button = [...container.querySelectorAll<HTMLElement>('button, [role="button"]')].find(
    (b) => b.textContent?.includes(label) || b.getAttribute("aria-label") === label,
  )
  expect(button).toBeTruthy()
  await act(async () => button!.click())
}
const render = async (onScan?: () => void) => {
  await act(async () =>
    root.render(
      <StrictMode>
        <ShareTagModal onClose={close} onScan={onScan} />
      </StrictMode>,
    ),
  )
}

it.each([true, false])(
  "says a tag that is not active yet cannot receive payments (pending=%s)",
  async (pending) => {
    mocks.pending = pending
    await render()
    const note = container.querySelector('[data-testid="share-tag-inactive"]')
    expect(note?.textContent ?? null).toBe(
      pending
        ? "@alice isn't active yet, so it can't receive payments. People can still connect with you."
        : null,
    )
  },
)

describe.each([false, true])("ShareTagModal lifecycle and payload (phone=%s)", (phone) => {
  beforeEach(() => {
    mocks.phone = phone
  })

  it("mints once under StrictMode and carries the full link in QR and every clipboard control", async () => {
    await render()
    expect(mocks.mint).toHaveBeenCalledTimes(1)
    const expected = document.createElement("div")
    expected.innerHTML = renderSVG(link, { whiteColor: "transparent", blackColor: "#fff" })
    expect(container.querySelector(".ww-qr-card__code")!.innerHTML).toBe(expected.innerHTML)
    await click("Copy link")
    expect(mocks.clipboard).toHaveBeenLastCalledWith(link)
    await act(async () =>
      (container.querySelector(".ww-qr-card__label") as HTMLButtonElement).click(),
    )
    expect(mocks.clipboard).toHaveBeenLastCalledWith(link)
    await click("Share")
    expect(mocks.clipboard).toHaveBeenLastCalledWith(link)
    expect(container.textContent).toContain("Link copied!")
    expect(container.textContent).not.toContain("Scan instead")
  })

  it("shares the complete URL through Web Share", async () => {
    Object.defineProperty(navigator, "share", { configurable: true, value: mocks.share })
    mocks.share.mockResolvedValue(undefined)
    await render()
    await click("Share")
    expect(mocks.share).toHaveBeenCalledWith({ title: "My zk.money tag", url: link })
    expect(mocks.clipboard).not.toHaveBeenCalled()
  })

  it("keeps exit and optional scan reachable during mint, and retries a mint error in place", async () => {
    let reject!: (error: Error) => void
    mocks.mint.mockReturnValueOnce(
      new Promise((_resolve, no) => {
        reject = no
      }),
    )
    const scan = vi.fn()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await render(scan)
      expect(container.textContent).toContain("Generating code…")
      await click("Close")
      expect(close).toHaveBeenCalledTimes(1)
      const scanButton = [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Scan instead"),
      )!
      await act(async () => scanButton.click())
      expect(scan).toHaveBeenCalledTimes(1)
      await act(async () => reject(new Error("offline")))
      expect(container.textContent).toContain("Couldn't generate your code")
      await click("Retry")
      expect(mocks.mint).toHaveBeenCalledTimes(2)
      expect(container.querySelector(".ww-qr-card__code")).not.toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  it("does not record a handshake when a pending mint reaches persistence after close", async () => {
    let finish!: () => Promise<void>
    mocks.mint.mockImplementationOnce(
      ({ record }: { record: (uuid: string) => Promise<void> }) =>
        new Promise((resolve, reject) => {
          finish = async () => {
            try {
              await record("closed-session")
              resolve(link)
            } catch (error) {
              reject(error)
            }
          }
        }),
    )
    await render()
    expect(container.textContent).toContain("Generating code…")
    await act(async () => root.render(null))
    await act(async () => finish())
    expect(mocks.record).not.toHaveBeenCalled()
    expect(container.textContent).toBe("")
  })

  it("keeps the dialog session and keyboard exit across the phone breakpoint", async () => {
    await render()
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.focus()
    mocks.phone = !phone
    await render()
    expect(container.querySelectorAll('[aria-label="Close"]')).toHaveLength(1)
    expect(container.querySelector('[role="dialog"]')).toBe(dialog)
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(mocks.mint).toHaveBeenCalledTimes(1)
    await click("Copy link")
    expect(mocks.clipboard).toHaveBeenLastCalledWith(link)
    act(() =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    )
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("cycles focus through the exit and restores the opener when closed", async () => {
    const opener = document.createElement("button")
    document.body.append(opener)
    opener.focus()
    try {
      await render(() => {})
      const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      buttons[buttons.length - 1].focus()
      act(() =>
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
        ),
      )
      expect(document.activeElement).toBe(buttons[0])
      expect(buttons[0].getAttribute("aria-label")).toBe("Close")
      await act(async () => root.render(null))
      expect(document.activeElement).toBe(opener)
    } finally {
      opener.remove()
    }
  })

  it("mints a new link after the previous Share surface unmounts", async () => {
    await render()
    await act(async () => root.render(null))
    mocks.mint.mockResolvedValueOnce(link + "-new")
    await render()
    expect(mocks.mint).toHaveBeenCalledTimes(2)
    await click("Copy link")
    expect(mocks.clipboard).toHaveBeenLastCalledWith(link + "-new")
  })
})
