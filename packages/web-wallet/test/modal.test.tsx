import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
}))

const { Modal, ModalSuspension } = await import("../src/ui/Modal")
const { BrowserPasskeyCeremony } = await import("@obsidion/passkey-web")

const CEREMONY_TIMING = {
  handoffWaitMs: 30,
  teardownWaitMs: 5,
  focusWaitMs: 10,
  pendingRetryDelaysMs: [1],
  createTimeoutMs: 50,
}

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("Modal", () => {
  let container: HTMLDivElement
  let root: Root
  let opener: HTMLButtonElement

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      this.open = true
    })
    vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      this.open = false
    })
    opener = document.createElement("button")
    document.body.appendChild(opener)
    opener.focus()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    opener.remove()
    vi.restoreAllMocks()
  })

  const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]')!
  const key = (init: KeyboardEventInit) =>
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
      )
    })

  async function render(node: React.ReactElement) {
    await act(async () => root.render(node))
  }

  it("is named, takes focus on open, and hands it back on close", async () => {
    await render(
      <Modal variant="create" label="Claim your payment" onClose={() => {}}>
        <button>Accept</button>
      </Modal>,
    )
    expect(dialog().getAttribute("aria-label")).toBe("Claim your payment")
    expect(dialog().getAttribute("aria-modal")).toBe("true")
    expect(document.activeElement).toBe(container.querySelector(".ww-modal"))

    await act(async () => root.render(<div />))
    expect(document.activeElement).toBe(opener)
  })

  it("honors explicit field focus on initial show and native busy reopen", async () => {
    await render(
      <Modal title="Amount">
        <input aria-label="Amount" data-autofocus />
      </Modal>,
    )
    const input = container.querySelector("input")!
    expect(document.activeElement).toBe(input)
    const frame = dialog() as HTMLDialogElement
    await act(async () => {
      frame.open = false
      frame.dispatchEvent(new Event("close"))
    })
    expect(frame.open).toBe(true)
    expect(document.activeElement).toBe(input)
  })

  it("keeps a deliberately blurred field unfocused on an ordinary rerender", async () => {
    const form = () => (
      <Modal title="Amount">
        <input data-autofocus />
      </Modal>
    )
    await render(form())
    const input = container.querySelector("input")!
    expect(document.activeElement).toBe(input)
    input.blur()
    expect(document.activeElement).toBe(document.body)
    await render(form())
    expect(document.activeElement).toBe(container.querySelector(".ww-modal"))
  })

  it("reopens after native dismissal changes the step without removing the frame", async () => {
    function Steps() {
      const [step, setStep] = React.useState("confirm")
      return (
        <Modal title={step} onClose={() => setStep("amount")}>
          {step === "confirm" ? (
            <button>Confirm</button>
          ) : (
            <input aria-label="Amount" data-autofocus />
          )}
        </Modal>
      )
    }
    await render(<Steps />)
    const frame = dialog() as HTMLDialogElement
    await act(async () => {
      frame.open = false
      frame.dispatchEvent(new Event("close"))
    })
    expect(frame).toBe(dialog())
    expect(frame.open).toBe(true)
    expect(frame.getAttribute("aria-label")).toBe("amount")
    expect(document.activeElement).toBe(container.querySelector("input"))
  })

  it("falls back to the title for its name", async () => {
    await render(
      <Modal title="Send" onClose={() => {}}>
        <span>body</span>
      </Modal>,
    )
    expect(dialog().getAttribute("aria-label")).toBe("Send")
  })

  it("keeps Tab inside the sheet in both directions", async () => {
    await render(
      <Modal variant="create" label="Two" onClose={() => {}}>
        <button>First</button>
        <button>Last</button>
      </Modal>,
    )
    const [close, first, last] = [...container.querySelectorAll("button")]
    expect(close.getAttribute("aria-label")).toBe("Close")

    // Shift+Tab from the container (initial focus) wraps to the last control.
    key({ key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(last)

    key({ key: "Tab" })
    expect(document.activeElement).toBe(close)

    key({ key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(last)

    // Mid-sheet moves are the browser's own; the trap only wraps at the edges.
    first.focus()
    key({ key: "Tab" })
    expect(document.activeElement).toBe(first)
  })

  it("Escape closes only when the sheet is closable", async () => {
    const onClose = vi.fn()
    await render(
      <Modal variant="create" label="Closable" onClose={onClose}>
        <button>Ok</button>
      </Modal>,
    )
    key({ key: "Escape" })
    expect(onClose).toHaveBeenCalledOnce()

    await render(
      <Modal variant="create" label="Locked">
        <button>Cancel</button>
      </Modal>,
    )
    key({ key: "Escape" })
    expect(dialog().getAttribute("aria-label")).toBe("Locked")
    expect(onClose).toHaveBeenCalledOnce()
  })
  it("reopens a busy frame after a native close and reconciles a dismissible one", async () => {
    const onClose = vi.fn()
    await render(
      <Modal title="Busy">
        <button>Wait</button>
      </Modal>,
    )
    const busy = dialog() as HTMLDialogElement
    await act(async () => {
      busy.open = false
      busy.dispatchEvent(new Event("close"))
    })
    expect(busy.open).toBe(true)
    await render(
      <Modal title="Ready" onClose={onClose}>
        <button>Done</button>
      </Modal>,
    )
    await act(async () => {
      busy.open = false
      busy.dispatchEvent(new Event("close"))
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("ignores delayed cleanup close events across StrictMode replay and replacement", async () => {
    const onClose = vi.fn()
    vi.mocked(HTMLDialogElement.prototype.close).mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      if (!this.open) return
      this.open = false
      queueMicrotask(() => this.dispatchEvent(new Event("close")))
    })
    await render(
      <React.StrictMode>
        <Modal title="First" onClose={onClose}>
          <button>First action</button>
        </Modal>
      </React.StrictMode>,
    )
    const old = dialog() as HTMLDialogElement
    expect(old.open).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    await render(
      <Modal key="replacement" title="Second" onClose={onClose}>
        <button>Second action</button>
      </Modal>,
    )
    await act(async () => old.dispatchEvent(new Event("close")))
    expect((dialog() as HTMLDialogElement).open).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    const current = dialog() as HTMLDialogElement
    await act(async () => {
      current.open = false
      current.dispatchEvent(new Event("close"))
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("preserves an existing destination even when native close restores the old opener", async () => {
    await render(
      <Modal title="Old">
        <button>Old action</button>
      </Modal>,
    )
    const destination = document.createElement("input")
    document.body.append(destination)
    destination.focus()
    vi.mocked(HTMLDialogElement.prototype.close).mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      this.open = false
      opener.focus()
    })
    await render(<div />)
    expect(document.activeElement).toBe(destination)
    destination.remove()
  })

  it("suspends without dismissing or losing state, and restores the focused control", async () => {
    const onClose = vi.fn()
    vi.mocked(HTMLDialogElement.prototype.close).mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      if (!this.open) return
      this.open = false
      queueMicrotask(() => this.dispatchEvent(new Event("close")))
    })
    const form = (suspended: boolean) => (
      <ModalSuspension suspended={suspended}>
        <Modal title="Deposit" onClose={onClose}>
          <input defaultValue="25" />
          <button>Connect</button>
        </Modal>
      </ModalSuspension>
    )
    await render(form(false))
    const frame = dialog() as HTMLDialogElement
    const input = container.querySelector("input")!
    const connect = container.querySelector(".ww-modal > button") as HTMLButtonElement
    input.value = "123"
    connect.focus()
    await render(form(true))
    expect(frame.open).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    await render(form(true))
    expect(frame.open).toBe(false)
    await render(form(false))
    expect(frame.open).toBe(true)
    expect(input.value).toBe("123")
    expect(document.activeElement).toBe(connect)
    expect(onClose).not.toHaveBeenCalled()
  })

  it("keeps newly mounted sheets closed during suspension and never restores removed sheets", async () => {
    const form = (suspended: boolean, title?: string) => (
      <ModalSuspension suspended={suspended}>
        {title && (
          <Modal key={title} title={title}>
            <button>{title}</button>
          </Modal>
        )}
      </ModalSuspension>
    )
    await render(form(true, "First"))
    const first = dialog() as HTMLDialogElement
    expect(first.open).toBe(false)
    await render(form(true, "Replacement"))
    const replacement = dialog() as HTMLDialogElement
    expect(replacement.open).toBe(false)
    await render(form(false, "Replacement"))
    expect(first.isConnected).toBe(false)
    expect(first.open).toBe(false)
    expect(replacement.open).toBe(true)
    await render(form(true, "Replacement"))
    await render(form(false))
    expect(replacement.open).toBe(false)
    expect(container.querySelector("dialog")).toBeNull()
  })

  describe("during a passkey request", () => {
    const assert = () =>
      new BrowserPasskeyCeremony(CEREMONY_TIMING)
        .assert({ rpId: "localhost", challenge: new Uint8Array(32) })
        .catch(() => {})
    let show: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      show = vi
        .spyOn(HTMLDialogElement.prototype, "show")
        .mockImplementation(function (this: HTMLDialogElement) {
          this.open = true
        })
      vi.spyOn(document, "hasFocus").mockReturnValue(true)
    })

    it("drops an open sheet to non-modal while an extension answers it, and back after", async () => {
      let settle!: (credential: null) => void
      let reopenedBeforeRequest = false
      // A script function, as an extension installs over the native one.
      let ariaModalDuringRequest: string | null = null
      const get = vi.fn(() => {
        reopenedBeforeRequest = show.mock.calls.length === 1
        ariaModalDuringRequest = dialog().getAttribute("aria-modal")
        return new Promise<null>((resolve) => (settle = resolve))
      })
      Object.defineProperty(navigator, "credentials", {
        value: { get, create: vi.fn() },
        configurable: true,
      })
      const onClose = vi.fn()
      await render(
        <Modal title="Pay" onClose={onClose}>
          <button>Pay</button>
        </Modal>,
      )
      const showModal = vi.mocked(HTMLDialogElement.prototype.showModal)
      expect(showModal).toHaveBeenCalledTimes(1)

      const request = assert()
      await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
      expect(reopenedBeforeRequest).toBe(true)
      expect(ariaModalDuringRequest).toBe("false")
      await act(async () => {
        settle(null)
        await request
      })
      expect(showModal).toHaveBeenCalledTimes(2)
      expect(show).toHaveBeenCalledTimes(1)
      expect(dialog().getAttribute("aria-modal")).toBe("true")

      // The closes the two reopenings queue are not dismissals.
      const frame = dialog() as HTMLDialogElement
      await act(async () => {
        frame.dispatchEvent(new Event("close"))
        frame.dispatchEvent(new Event("close"))
      })
      expect(onClose).not.toHaveBeenCalled()
      expect(frame.open).toBe(true)
    })

    it("leaves sheets modal when the browser answers the request itself", async () => {
      const get = Promise.resolve.bind(Promise, null)
      Object.defineProperty(navigator, "credentials", {
        value: { get, create: vi.fn() },
        configurable: true,
      })
      await render(
        <Modal title="Pay" onClose={() => {}}>
          <button>Pay</button>
        </Modal>,
      )
      await act(async () => {
        await assert()
      })
      expect(show).not.toHaveBeenCalled()
      expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1)
    })
  })

  describe("under an on-screen keyboard that overlays the page", () => {
    class FakeViewport extends EventTarget {
      height = 800
      offsetTop = 0
    }
    let viewport: FakeViewport
    beforeEach(() => {
      viewport = new FakeViewport()
      Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true })
      Object.defineProperty(window, "innerHeight", { value: 800, configurable: true })
    })
    afterEach(() => {
      Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true })
      vi.useRealTimers()
    })

    it("carries the keyboard's inset and the visible height on the sheet's root", async () => {
      await render(
        <Modal title="Amount">
          <input aria-label="Amount" />
        </Modal>,
      )
      expect(dialog().style.getPropertyValue("--ww-keyboard-inset")).toBe("0px")
      viewport.height = 520
      act(() => viewport.dispatchEvent(new Event("resize")))
      expect(dialog().style.getPropertyValue("--ww-keyboard-inset")).toBe("280px")
      expect(dialog().style.getPropertyValue("--ww-visible-height")).toBe("520px")
    })

    it("focuses the field at once, so iOS opens the keyboard, and scrolls it into view once the sheet has landed", async () => {
      let finish!: () => void
      const finished = new Promise<void>((resolve) => (finish = resolve))
      const proto = HTMLElement.prototype as unknown as { getAnimations?: () => unknown[] }
      proto.getAnimations = () => [{ finished }]
      const scrolled = vi.fn()
      const focus = vi.spyOn(HTMLElement.prototype, "focus")
      Object.assign(HTMLElement.prototype, { scrollIntoView: scrolled })
      try {
        await render(
          <Modal title="Amount">
            <input aria-label="Amount" data-autofocus />
          </Modal>,
        )
        const input = container.querySelector("input")!
        expect(document.activeElement).toBe(input)
        expect(focus.mock.contexts.indexOf(input)).toBeGreaterThanOrEqual(0)
        expect(focus.mock.calls[focus.mock.contexts.indexOf(input)][0]).toEqual({ preventScroll: true })
        expect(scrolled).not.toHaveBeenCalled()
        finish()
        await act(async () => {
          await finished
        })
        expect(scrolled).toHaveBeenCalledWith({ block: "nearest" })
      } finally {
        focus.mockRestore()
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
        delete proto.getAnimations
      }
    })
  })
})
