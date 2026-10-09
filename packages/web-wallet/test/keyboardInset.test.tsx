import { act, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  KEYBOARD_INSET_PROPERTY,
  VISIBLE_HEIGHT_PROPERTY,
  keyboardInset,
  revealFocusedField,
  useKeyboardInset,
  viewportSettled,
} from "../src/ui/keyboardInset"

/** iOS Safari's visual viewport: the page keeps its height while the keyboard covers part of it. */
class FakeViewport extends EventTarget {
  height = 800
  offsetTop = 0
}

function Sheet() {
  const root = useRef<HTMLDivElement>(null)
  useKeyboardInset(root)
  return <div ref={root} data-testid="sheet" />
}

let host: HTMLDivElement
let root: Root
let viewport: FakeViewport
const install = (value: FakeViewport | undefined) =>
  Object.defineProperty(window, "visualViewport", { value, configurable: true })

beforeEach(() => {
  viewport = new FakeViewport()
  install(viewport)
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  install(undefined)
  vi.useRealTimers()
})

const sheet = () => host.querySelector<HTMLElement>("[data-testid=sheet]")!
const inset = () => sheet().style.getPropertyValue(KEYBOARD_INSET_PROPERTY)
const visible = () => sheet().style.getPropertyValue(VISIBLE_HEIGHT_PROPERTY)

describe("useKeyboardInset", () => {
  it("keeps the keyboard's overlay height and the visible height on the sheet, following the viewport", () => {
    act(() => root.render(<Sheet />))
    expect(inset()).toBe("0px")
    expect(visible()).toBe("800px")
    viewport.height = 500
    act(() => viewport.dispatchEvent(new Event("resize")))
    expect(inset()).toBe("300px")
    expect(visible()).toBe("500px")
    viewport.offsetTop = 20
    act(() => viewport.dispatchEvent(new Event("scroll")))
    expect(inset()).toBe("280px")
    viewport.height = 800
    viewport.offsetTop = 0
    act(() => viewport.dispatchEvent(new Event("resize")))
    expect(inset()).toBe("0px")
  })

  it("clears the properties and stops listening when the sheet goes", () => {
    act(() => root.render(<Sheet />))
    const element = sheet()
    act(() => root.render(<div />))
    expect(element.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe("")
    viewport.height = 500
    act(() => viewport.dispatchEvent(new Event("resize")))
    expect(element.style.getPropertyValue(KEYBOARD_INSET_PROPERTY)).toBe("")
  })

  it("sets nothing where the browser exposes no visual viewport", () => {
    install(undefined)
    act(() => root.render(<Sheet />))
    expect(inset()).toBe("")
    expect(keyboardInset()).toBeUndefined()
  })
})

describe("revealFocusedField", () => {
  it("scrolls the focused field into view once the keyboard has settled, only where the keyboard overlays", async () => {
    vi.useFakeTimers()
    const field = document.createElement("input")
    field.scrollIntoView = vi.fn()
    host.append(field)
    field.focus()
    const revealed = revealFocusedField(field)
    viewport.height = 500
    viewport.dispatchEvent(new Event("resize"))
    await vi.advanceTimersByTimeAsync(119)
    expect(field.scrollIntoView).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await revealed
    expect(field.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" })
    // Android and desktop: the page resized instead, so there is nothing to lift over.
    viewport.height = 800
    vi.mocked(field.scrollIntoView).mockClear()
    const flat = revealFocusedField(field)
    await vi.advanceTimersByTimeAsync(600)
    await flat
    expect(field.scrollIntoView).not.toHaveBeenCalled()
  })

  it("settles at once without a visual viewport, and at most after the limit", async () => {
    vi.useFakeTimers()
    install(undefined)
    await viewportSettled()
    install(viewport)
    let settled = false
    void viewportSettled(120, 600).then(() => (settled = true))
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      viewport.dispatchEvent(new Event("resize"))
    }
    expect(settled).toBe(true)
  })
})
