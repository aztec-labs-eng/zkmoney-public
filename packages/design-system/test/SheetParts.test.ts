import { act, createElement } from "react"
import type { ReactElement } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChoiceCard, FactBox } from "../src/components/SheetBoxes"
import { StepTracker } from "../src/components/StepTracker"

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

function render(element: ReactElement) {
  act(() => root.render(element))
}

function fire(target: Element, event: Event) {
  act(() => {
    target.dispatchEvent(event)
  })
}

// jsdom has no PointerEvent; React reads only the type and pointerType.
function pointer(type: string, pointerType: string, init: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, ...init })
  Object.defineProperty(event, "pointerType", { value: pointerType })
  return event
}

describe("FactBox hint", () => {
  const facts = [
    {
      label: "Cost",
      value: "About $0.70",
      hint: {
        label: "Cost breakdown",
        title: "How it adds up",
        rows: [{ label: "Update", value: "$0.70" }],
      },
    },
  ]
  const tip = () => host.querySelector('[role="tooltip"]:not([hidden])')
  const button = () => host.querySelector("button") as HTMLButtonElement

  it("gives the button the breakdown as its description before it opens", () => {
    render(createElement(FactBox, { facts }))
    const description = document.getElementById(button().getAttribute("aria-describedby") ?? "")
    expect(tip()).toBeNull()
    expect(description?.textContent).toContain("How it adds up")
  })

  it("shows on mouse hover and hides shortly after the mouse leaves unless it comes back", () => {
    vi.useFakeTimers()
    render(createElement(FactBox, { facts }))
    const hint = button().parentElement as HTMLElement
    fire(hint, pointer("pointerover", "mouse"))
    expect(tip()).not.toBeNull()
    expect(button().getAttribute("aria-expanded")).toBe("true")

    fire(hint, pointer("pointerout", "mouse", { relatedTarget: document.body }))
    act(() => vi.advanceTimersByTime(100))
    fire(tip() as Element, pointer("pointerover", "mouse", { relatedTarget: document.body }))
    act(() => vi.advanceTimersByTime(500))
    expect(tip()).not.toBeNull()

    fire(hint, pointer("pointerout", "mouse", { relatedTarget: document.body }))
    act(() => vi.advanceTimersByTime(150))
    expect(tip()).toBeNull()
  })

  it("stays open after a tap until a press lands outside it", () => {
    render(createElement(FactBox, { facts }))
    const hint = button().parentElement as HTMLElement
    fire(hint, pointer("pointerover", "touch"))
    expect(tip()).toBeNull()
    fire(button(), new MouseEvent("click", { bubbles: true }))
    expect(tip()).not.toBeNull()
    fire(tip() as Element, pointer("pointerdown", "touch"))
    expect(tip()).not.toBeNull()
    fire(document.body, pointer("pointerdown", "touch"))
    expect(tip()).toBeNull()
  })

  // Safari leaves focus where it was on a click, so Escape may come from anywhere in the dialog.
  it.each(["the hint", "elsewhere in the dialog"])(
    "closes on an Escape from %s without the Escape reaching the dialog",
    (from) => {
      let dialogEscapes = 0
      render(
        createElement(
          "div",
          { onKeyDown: (e: { key: string }) => e.key === "Escape" && dialogEscapes++ },
          createElement(FactBox, { facts }),
          createElement("input", { "aria-label": "Elsewhere" }),
        ),
      )
      const target = from === "the hint" ? button() : (host.querySelector("input") as Element)
      fire(button(), new MouseEvent("click", { bubbles: true }))
      fire(target, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      expect(tip()).toBeNull()
      expect(dialogEscapes).toBe(0)

      fire(target, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      expect(dialogEscapes).toBe(1)
    },
  )

  // As in Safari, the click doesn't focus the button and focus goes to the card around it.
  it("closes when focus lands outside the hint, even under the mouse, but not on the card", () => {
    render(
      createElement(
        "div",
        { "tabIndex": -1, "aria-label": "Card" },
        createElement(FactBox, { facts }),
        createElement("input", { "aria-label": "Next" }),
      ),
    )
    fire(button(), new MouseEvent("click", { bubbles: true }))
    act(() => (host.firstElementChild as HTMLElement).focus())
    act(() => button().focus())
    expect(tip()).not.toBeNull()

    fire(button().parentElement as HTMLElement, pointer("pointerover", "mouse"))
    act(() => (host.querySelector("input") as HTMLInputElement).focus())
    expect(tip()).toBeNull()
  })

  it("stays open when the window gives focus back to the control that had it", () => {
    render(
      createElement(
        "div",
        null,
        createElement(FactBox, { facts }),
        createElement("input", { "aria-label": "Amount" }),
      ),
    )
    const input = host.querySelector("input") as HTMLInputElement
    act(() => input.focus())
    fire(button().parentElement as HTMLElement, pointer("pointerover", "mouse"))
    fire(input, new FocusEvent("focusin", { bubbles: true }))
    expect(tip()).not.toBeNull()
  })
})

describe("ChoiceCard", () => {
  it.each([
    { disabled: false, picked: ["key"] },
    { disabled: true, picked: [] },
  ])("reports its value when picked unless disabled ($disabled)", ({ disabled, picked }) => {
    const seen: string[] = []
    render(
      createElement(ChoiceCard, {
        name: "place",
        value: "key",
        checked: false,
        onChange: (value: string) => seen.push(value),
        label: "Security key",
        disabled,
      }),
    )
    fire(
      host.querySelector("label") as HTMLLabelElement,
      new MouseEvent("click", { bubbles: true }),
    )
    expect(seen).toEqual(picked)
  })
})

describe("StepTracker", () => {
  it("joins each step to the next, stops the rail at the last, and marks and spins the current step", () => {
    render(
      createElement(StepTracker, {
        label: "Adding",
        progress: "2 of 3",
        steps: [
          { label: "One", state: "done" },
          { label: "Two", state: "current" },
          { label: "Three", state: "todo" },
        ],
      }),
    )
    const steps = [...host.querySelectorAll("li")]
    expect(steps.map((step) => step.querySelector(".zkm-step-tracker__line") !== null)).toEqual([
      true,
      true,
      false,
    ])
    expect(steps.map((step) => step.getAttribute("aria-current"))).toEqual([null, "step", null])
    expect(steps.map((step) => step.querySelector(".zkm-spinner-icon") !== null)).toEqual([
      false,
      true,
      false,
    ])
  })

  it("stops a failed step's ring", () => {
    render(
      createElement(StepTracker, {
        label: "Adding",
        progress: "1 of 1",
        steps: [{ label: "One", state: "current", failed: true }],
      }),
    )
    expect(host.querySelector('[aria-current="step"] svg')).not.toBeNull()
    expect(host.querySelector(".zkm-spinner-icon")).toBeNull()
  })
})
