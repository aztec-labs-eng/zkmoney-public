import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({ Icon: () => null }))
vi.mock("../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../src/config/oxideTuple", () => ({ getOxideTuple: () => new Promise(() => {}) }))

const { WithdrawalAssetPicker } = await import("../src/features/withdraw/WithdrawalAssetPicker")
const { Modal } = await import("../src/ui/Modal")

describe("WithdrawalAssetPicker dismissal", () => {
  let container: HTMLDivElement
  let root: Root
  let outside: HTMLButtonElement
  const onChange = vi.fn()

  beforeEach(() => {
    onChange.mockReset()
    outside = document.createElement("button")
    document.body.appendChild(outside)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    outside.remove()
  })

  const trigger = () =>
    container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!
  const listbox = () => container.querySelector('[role="listbox"]')
  const option = () => container.querySelector<HTMLButtonElement>('[role="option"]')!
  const press = (el: Element) =>
    act(() => {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
  const escape = () => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    act(() => void document.activeElement?.dispatchEvent(event))
    return event
  }

  async function renderOpen(onSheetClose?: () => void) {
    const picker = <WithdrawalAssetPicker value="DAI" onChange={onChange} />
    const sheet = (
      <Modal variant="bare" onClose={onSheetClose}>
        {picker}
      </Modal>
    )
    await act(async () => root.render(onSheetClose ? sheet : picker))
    press(trigger())
    expect(listbox()).not.toBeNull()
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
  }

  const expectClosed = () => {
    expect(listbox()).toBeNull()
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
  }

  it("closes on a press outside and leaves focus where the user pressed", async () => {
    await renderOpen()
    outside.focus()
    press(outside)
    expectClosed()
    expect(document.activeElement).toBe(outside)
  })

  it("closes on Escape from outside the picker and focuses the trigger", async () => {
    await renderOpen()
    outside.focus()
    escape()
    expectClosed()
    expect(document.activeElement).toBe(trigger())
  })

  it.each([
    ["Escape", () => expect(escape().defaultPrevented).toBe(true)],
    ["a press on the sheet", () => press(container.querySelector(".ww-modal")!)],
  ])("inside a sheet, %s closes the list and leaves the sheet open", async (_, dismiss) => {
    const onSheetClose = vi.fn()
    await renderOpen(onSheetClose)
    dismiss()
    expectClosed()
    expect(onSheetClose).not.toHaveBeenCalled()
  })

  it("closes on a second press of the trigger", async () => {
    await renderOpen()
    press(trigger())
    expectClosed()
  })

  it("selects on an option press, closes, and focuses the trigger", async () => {
    await renderOpen()
    press(option())
    expect(onChange).toHaveBeenCalledWith("DAI")
    expectClosed()
    expect(document.activeElement).toBe(trigger())
  })
})
