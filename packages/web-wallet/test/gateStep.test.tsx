/** What a screen shows while its gate holds: the phone steps, or a phone's one tap before a second prompt. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GateState } from "../src/features/identity/ceremonyGate"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
  NumberedStepRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const { ApproveAgainStep, GateStep } = await import("../src/features/identity/PhoneSteps")

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

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const click = (testId: string) => act(() => byTestId(testId)!.click())

/** A gate holding with `prompt`, its `proceed` a spy. */
const holding = (prompt: "phone-steps" | "sign-in" | "approve-again") => {
  const proceed = vi.fn()
  const state: Extract<GateState, { kind: "awaiting-action" }> = {
    kind: "awaiting-action",
    proceed,
    reach: "unknown",
    prompt,
  }
  return { state, proceed }
}

describe("ApproveAgainStep", () => {
  it("offers one continue and one cancel, each calling its handler", async () => {
    const onContinue = vi.fn()
    const onCancel = vi.fn()
    await act(async () =>
      root.render(<ApproveAgainStep onContinue={onContinue} onCancel={onCancel} />),
    )
    expect(container.textContent).toContain("One more approval")
    await click("approve-again-continue")
    expect(onContinue).toHaveBeenCalledTimes(1)
    await click("approve-again-cancel")
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("shows no cancel when the screen offers none", async () => {
    await act(async () => root.render(<ApproveAgainStep onContinue={() => {}} />))
    expect(byTestId("approve-again-cancel")).toBeNull()
  })
})

describe("GateStep", () => {
  it("the tap before a second prompt: says why, and Continue proceeds with no route", async () => {
    const { state, proceed } = holding("approve-again")
    const onCancel = vi.fn()
    await act(async () =>
      root.render(<GateStep state={state} onCancel={onCancel} cancelLabel="Stop" />),
    )
    expect(byTestId("approve-again")).not.toBeNull()
    expect(byTestId("sign-in-sheet")).toBeNull()
    expect(container.textContent).toContain("approve twice")
    expect(byTestId("approve-again-cancel")!.textContent).toBe("Stop")
    await click("approve-again-continue")
    expect(proceed).toHaveBeenCalledWith()
    await click("approve-again-cancel")
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("a sign-in shows the bare Sign in sheet, and Continue proceeds with no route", async () => {
    const { state, proceed } = holding("sign-in")
    await act(async () =>
      root.render(<GateStep state={state} onCancel={() => {}} cancelLabel="Stop" />),
    )
    expect(byTestId("sign-in-sheet")).not.toBeNull()
    expect(byTestId("phone-steps")).toBeNull()
    expect(container.textContent).toContain("Sign in")
    await click("sign-in-continue")
    expect(proceed).toHaveBeenCalledWith()
  })

  it("a creation shows the phone steps, and a QR pick proceeds on the phone route", async () => {
    const { state, proceed } = holding("phone-steps")
    await act(async () => root.render(<GateStep state={state} />))
    expect(byTestId("phone-steps")).not.toBeNull()
    expect(byTestId("sign-in-sheet")).toBeNull()
    await click("phone-steps-continue")
    expect(proceed).toHaveBeenCalledWith("phone")
  })
})
