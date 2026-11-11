// @vitest-environment node
/** Where the keyboard overlays the page, the visual viewport measures it, once it settles. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  keyboardInset,
  revealAboveKeyboard,
  revealFocusedField,
  viewportSettled,
} from "../../src/ui/keyboardInset"

/** iOS Safari's visual viewport: the page keeps its height while the keyboard covers part of it. */
class FakeViewport extends EventTarget {
  height = 800
  offsetTop = 0
}

let viewport: FakeViewport
let scrollBy: ReturnType<typeof vi.fn>
const box = (bottom: number) => ({ getBoundingClientRect: () => ({ bottom }) })
const resize = (height: number) => {
  viewport.height = height
  viewport.dispatchEvent(new Event("resize"))
}

beforeEach(() => {
  vi.useFakeTimers()
  viewport = new FakeViewport()
  scrollBy = vi.fn()
  vi.stubGlobal("window", { visualViewport: viewport, innerHeight: 800, scrollBy })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("keyboardInset", () => {
  it("is how far the keyboard covers a box, and the visible height", () => {
    viewport.height = 500
    viewport.offsetTop = 20
    expect(keyboardInset(window)).toEqual({ inset: 280, visible: 500 })
    expect(keyboardInset(window, 400)).toEqual({ inset: 0, visible: 500 })
  })

  it("is undefined without a visual viewport", () => {
    expect(keyboardInset({} as Window)).toBeUndefined()
  })
})

describe("viewportSettled", () => {
  it("settles once the viewport stops resizing, and at most after the limit", async () => {
    let settled = false
    void viewportSettled(120, 600).then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(100)
    resize(700)
    await vi.advanceTimersByTimeAsync(100)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    expect(settled).toBe(true)

    settled = false
    void viewportSettled(120, 600).then(() => (settled = true))
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(100)
      resize(600 + i)
    }
    expect(settled).toBe(true)
  })

  it("settles at once without a visual viewport", async () => {
    vi.stubGlobal("window", {})
    await viewportSettled()
  })
})

describe("revealAboveKeyboard", () => {
  it("scrolls the page by what the keyboard covers, once it settles", async () => {
    const form = { ...box(700), isConnected: true } as unknown as HTMLElement
    const revealed = revealAboveKeyboard(form)
    resize(500)
    await vi.advanceTimersByTimeAsync(120)
    await revealed
    expect(scrollBy).toHaveBeenCalledWith({ top: 200 })
  })

  it("scrolls nothing for a box above the keyboard, or one that left the page", async () => {
    viewport.height = 500
    await Promise.all([
      revealAboveKeyboard({ ...box(480), isConnected: true } as unknown as HTMLElement),
      revealAboveKeyboard({ ...box(700), isConnected: false } as unknown as HTMLElement),
      vi.advanceTimersByTimeAsync(600),
    ])
    expect(scrollBy).not.toHaveBeenCalled()
  })
})

describe("revealFocusedField", () => {
  function field(focused = true) {
    const element = {
      closest: () => box(800),
      scrollIntoView: vi.fn(),
    }
    vi.stubGlobal("document", { activeElement: focused ? element : undefined })
    return element
  }

  it("scrolls the focused field into view where the keyboard overlays its sheet", async () => {
    const input = field()
    const revealed = revealFocusedField(input as unknown as HTMLElement)
    resize(500)
    await vi.advanceTimersByTimeAsync(120)
    await revealed
    expect(input.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" })
  })

  it("leaves a field alone where the page resized, or once it lost focus", async () => {
    const flat = field()
    await Promise.all([
      revealFocusedField(flat as unknown as HTMLElement),
      vi.advanceTimersByTimeAsync(600),
    ])
    expect(flat.scrollIntoView).not.toHaveBeenCalled()
    viewport.height = 500
    const blurred = field(false)
    await Promise.all([
      revealFocusedField(blurred as unknown as HTMLElement),
      vi.advanceTimersByTimeAsync(600),
    ])
    expect(blurred.scrollIntoView).not.toHaveBeenCalled()
  })
})
