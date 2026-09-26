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
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.open = true })
    vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) { this.open = false })
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
    await render(<Modal title="Amount"><input aria-label="Amount" data-autofocus /></Modal>)
    const input = container.querySelector("input")!
    expect(document.activeElement).toBe(input)
    const frame = dialog() as HTMLDialogElement
    await act(async () => { frame.open = false; frame.dispatchEvent(new Event("close")) })
    expect(frame.open).toBe(true)
    expect(document.activeElement).toBe(input)
  })

  it("keeps a deliberately blurred field unfocused on an ordinary rerender", async () => {
    const form = () => <Modal title="Amount"><input data-autofocus /></Modal>
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
      return <Modal title={step} onClose={() => setStep("amount")}>
        {step === "confirm" ? <button>Confirm</button> : <input aria-label="Amount" data-autofocus />}
      </Modal>
    }
    await render(<Steps />)
    const frame = dialog() as HTMLDialogElement
    await act(async () => { frame.open = false; frame.dispatchEvent(new Event("close")) })
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
    await render(<Modal title="Busy"><button>Wait</button></Modal>)
    const busy = dialog() as HTMLDialogElement
    await act(async () => { busy.open = false; busy.dispatchEvent(new Event("close")) })
    expect(busy.open).toBe(true)
    await render(<Modal title="Ready" onClose={onClose}><button>Done</button></Modal>)
    await act(async () => { busy.open = false; busy.dispatchEvent(new Event("close")) })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("ignores delayed cleanup close events across StrictMode replay and replacement", async () => {
    const onClose = vi.fn()
    vi.mocked(HTMLDialogElement.prototype.close).mockImplementation(function (this: HTMLDialogElement) {
      if (!this.open) return
      this.open = false
      queueMicrotask(() => this.dispatchEvent(new Event("close")))
    })
    await render(<React.StrictMode><Modal title="First" onClose={onClose}><button>First action</button></Modal></React.StrictMode>)
    const old = dialog() as HTMLDialogElement
    expect(old.open).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    await render(<Modal key="replacement" title="Second" onClose={onClose}><button>Second action</button></Modal>)
    await act(async () => old.dispatchEvent(new Event("close")))
    expect((dialog() as HTMLDialogElement).open).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    const current = dialog() as HTMLDialogElement
    await act(async () => { current.open = false; current.dispatchEvent(new Event("close")) })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("preserves an existing destination even when native close restores the old opener", async () => {
    await render(<Modal title="Old"><button>Old action</button></Modal>)
    const destination = document.createElement("input")
    document.body.append(destination)
    destination.focus()
    vi.mocked(HTMLDialogElement.prototype.close).mockImplementation(function (this: HTMLDialogElement) {
      this.open = false
      opener.focus()
    })
    await render(<div />)
    expect(document.activeElement).toBe(destination)
    destination.remove()
  })

  it("suspends without dismissing or losing state, and restores the focused control", async () => {
    const onClose = vi.fn()
    vi.mocked(HTMLDialogElement.prototype.close).mockImplementation(function (this: HTMLDialogElement) {
      if (!this.open) return
      this.open = false
      queueMicrotask(() => this.dispatchEvent(new Event("close")))
    })
    const form = (suspended: boolean) => <ModalSuspension suspended={suspended}>
      <Modal title="Deposit" onClose={onClose}><input defaultValue="25" /><button>Connect</button></Modal>
    </ModalSuspension>
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
    const form = (suspended: boolean, title?: string) => <ModalSuspension suspended={suspended}>
      {title && <Modal key={title} title={title}><button>{title}</button></Modal>}
    </ModalSuspension>
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

})
