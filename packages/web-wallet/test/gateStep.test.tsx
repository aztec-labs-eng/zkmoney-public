/** What a screen shows while its gate holds: the creation sheet, or a phone's one tap before a second prompt. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PHONE_STEPS_COPY } from "@obsidion/passkey-web"
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
    className,
    isDisabled,
    onClick,
  }: {
    title: string
    testId?: string
    className?: string
    isDisabled?: boolean
    onClick?: () => void
  }) => (
    <button data-testid={testId} className={className} disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
  Icon: () => null,
}))

const { ApproveAgainStep, GateStep, PhoneSteps } = await import(
  "../src/features/identity/PhoneSteps"
)

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

  it("a creation shows the campaign's sheet: the button opens on the phone, the link swaps to the key", async () => {
    const { state, proceed } = holding("phone-steps")
    await act(async () => root.render(<GateStep state={state} />))
    expect(byTestId("phone-steps")).not.toBeNull()
    expect(byTestId("sign-in-sheet")).toBeNull()
    const text = container.textContent!
    expect(text).toContain("Scan QR code to save the key on your phone")
    expect(text).toContain(PHONE_STEPS_COPY.subtitle)
    expect(text).not.toContain("What you should see next")
    expect(text).toContain(PHONE_STEPS_COPY.why.title)
    expect(text).toContain(PHONE_STEPS_COPY.why.body)
    expect(text).toContain(PHONE_STEPS_COPY.supported.label)
    expect(text).toContain(PHONE_STEPS_COPY.loss.label)
    const tips = [...container.querySelectorAll('[role="tooltip"]')].map((t) => t.textContent)
    expect(tips[0]).toContain("1Password")
    expect(tips[1]).toContain(PHONE_STEPS_COPY.loss.title)
    expect(text).not.toContain(PHONE_STEPS_COPY.loss.line)
    expect(text).not.toContain(PHONE_STEPS_COPY.noPhone.note)
    // The reasons live in the row's tooltip; this variant has no warn box.
    expect(container.querySelectorAll(".ww-passkey-warn")).toHaveLength(0)
    expect(text).toContain("agree to the Terms & Conditions")
    // The blurred picture is decoration; the button over it is what names the step.
    const shot = container.querySelector(".ww-phone-steps__shot")!
    expect(shot.querySelector("img")!.alt).toBe("")
    expect(shot.contains(byTestId("phone-steps-continue"))).toBe(true)
    expect(byTestId("phone-steps-continue")!.textContent).toBe("Show QR Code")
    expect(byTestId("phone-steps-security-key")!.textContent).toBe(
      "Have a security key? Use it instead",
    )
    // Nothing in the sheet took focus on its own when it mounted.
    expect(byTestId("phone-steps")!.contains(document.activeElement)).toBe(false)
    await click("phone-steps-continue")
    expect(proceed).toHaveBeenLastCalledWith("phone")

    // The link opens no prompt: it swaps the sheet to the key variant, whose button does.
    await click("phone-steps-security-key")
    expect(proceed).toHaveBeenCalledTimes(1)
    const keyText = container.textContent!
    expect(keyText).toContain("Create account with your security key")
    expect(keyText).toContain(PHONE_STEPS_COPY.noPhone.note)
    expect(keyText).toContain(PHONE_STEPS_COPY.noPhone.models)
    expect(keyText).toContain(PHONE_STEPS_COPY.noPhone.back)
    expect(keyText).not.toContain("Show QR Code")
    expect(keyText).not.toContain(PHONE_STEPS_COPY.loss.label)
    expect(container.querySelectorAll(".ww-passkey-warn")).toHaveLength(1)
    expect(container.querySelector(".ww-passkey-warn")!.getAttribute("role")).toBe("alert")
    expect(byTestId("phone-steps-security-key")).toBeNull()
    expect(byTestId("phone-steps-continue")!.textContent).toBe(
      "Create account with my security key",
    )
    expect(document.activeElement).toBe(byTestId("phone-steps-continue"))
    await click("phone-steps-continue")
    expect(proceed).toHaveBeenCalledTimes(2)
    expect(proceed).toHaveBeenLastCalledWith("security-key")
  })

  it("the key variant's way back restores the phone variant without a prompt", async () => {
    const { state, proceed } = holding("phone-steps")
    await act(async () => root.render(<GateStep state={state} />))
    await click("phone-steps-security-key")
    expect(byTestId("phone-steps-back")!.textContent).toBe(PHONE_STEPS_COPY.noPhone.back)
    await click("phone-steps-back")
    expect(proceed).not.toHaveBeenCalled()
    const text = container.textContent!
    expect(text).toContain("Show QR Code")
    expect(text).toContain(PHONE_STEPS_COPY.loss.label)
    expect(text).not.toContain(PHONE_STEPS_COPY.noPhone.note)
    expect(byTestId("phone-steps-back")).toBeNull()
    expect(document.activeElement).toBe(byTestId("phone-steps-continue"))
  })

  it("a swap focuses the variant's primary button, not the split's control or Cancel", async () => {
    const { state } = holding("phone-steps")
    await act(async () =>
      root.render(
        <GateStep
          state={state}
          onCancel={() => {}}
          details={
            <p data-testid="split">
              You keep $18 <button type="button">Speed</button>
            </p>
          }
        />,
      ),
    )
    await click("phone-steps-security-key")
    expect(document.activeElement).toBe(byTestId("phone-steps-continue"))
    expect(document.activeElement!.textContent).toBe("Create account with my security key")
    await click("phone-steps-back")
    expect(document.activeElement).toBe(byTestId("phone-steps-continue"))
    expect(document.activeElement!.textContent).toBe("Show QR Code")
  })

  it("a key pick on a reach the probe left unknown still opens on the key", async () => {
    const { state, proceed } = holding("phone-steps")
    await act(async () => root.render(<GateStep state={{ ...state, reach: "unknown" }} />))
    await click("phone-steps-security-key")
    await click("phone-steps-continue")
    expect(proceed).toHaveBeenCalledWith("security-key")
  })

  it("a creation links the passkeys docs from outside its button", async () => {
    const { state, proceed } = holding("phone-steps")
    await act(async () => root.render(<GateStep state={state} />))
    const link = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === PHONE_STEPS_COPY.why.link,
    )!
    expect(link.getAttribute("href")).toBe("https://docs.zk.money/docs/passkeys")
    expect(link.target).toBe("_blank")
    // Reading the docs is not a sign-up.
    expect(link.closest("button")).toBeNull()
    // jsdom cannot open a tab: stop the navigation, keep the click.
    container.addEventListener("click", (e) => e.preventDefault(), { once: true })
    await act(async () => link.click())
    expect(proceed).not.toHaveBeenCalled()
    expect(byTestId("phone-steps")).not.toBeNull()
  })

  it("a creation that can reach no phone shows the key-only sheet and opens on the key", async () => {
    const { state, proceed } = holding("phone-steps")
    await act(async () => root.render(<GateStep state={{ ...state, reach: "no-hybrid" }} />))
    const text = container.textContent!
    expect(text).toContain("Create account with your security key")
    expect(text).toContain("One-time setup. About 20 seconds.")
    expect(text).toContain(PHONE_STEPS_COPY.noPhone.note)
    expect(text).toContain(PHONE_STEPS_COPY.noPhone.models)
    expect(container.querySelector(".ww-phone-steps__preview")).toBeNull()
    expect(byTestId("phone-steps-security-key")).toBeNull()
    expect(byTestId("phone-steps-back")).toBeNull()
    expect(text).not.toMatch(/scan|QR|phone/i)
    expect(byTestId("phone-steps-continue")!.textContent).toBe(
      "Create account with my security key",
    )
    await click("phone-steps-continue")
    expect(proceed).toHaveBeenCalledWith("security-key")
  })

  it("a creation shows the split it is given above both routes", async () => {
    const { state } = holding("phone-steps")
    await act(async () =>
      root.render(<GateStep state={state} details={<p data-testid="split">You keep $18</p>} />),
    )
    const split = byTestId("split")!
    const heading = container.querySelector(".ww-phone-steps__heading")!
    expect(split.textContent).toBe("You keep $18")
    expect(heading.compareDocumentPosition(split) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    for (const id of ["phone-steps-continue", "phone-steps-security-key"]) {
      expect(
        split.compareDocumentPosition(byTestId(id)!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
  })

  it("a key-only creation keeps the split between its warnings and its button", async () => {
    const { state } = holding("phone-steps")
    await act(async () =>
      root.render(
        <GateStep
          state={{ ...state, reach: "no-hybrid" }}
          details={<p data-testid="split">You keep $18</p>}
        />,
      ),
    )
    const split = byTestId("split")!
    const warn = container.querySelector(".ww-passkey-warn")!
    const button = byTestId("phone-steps-continue")!
    expect(warn.compareDocumentPosition(split) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(split.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe("PhoneSteps", () => {
  it("holds both routes while the signup is held", async () => {
    const onChoose = vi.fn()
    await act(async () => root.render(<PhoneSteps reach="ok" onChoose={onChoose} disabled />))
    const button = byTestId("phone-steps-continue") as HTMLButtonElement
    const link = byTestId("phone-steps-security-key") as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(link.disabled).toBe(true)
    await act(async () => {
      button.click()
      link.click()
    })
    expect(onChoose).not.toHaveBeenCalled()
  })

  it("keeps a key pick through a hold, and holds the way back with it", async () => {
    const onChoose = vi.fn()
    await act(async () => root.render(<PhoneSteps reach="ok" onChoose={onChoose} />))
    await click("phone-steps-security-key")
    await act(async () => root.render(<PhoneSteps reach="ok" onChoose={onChoose} disabled />))
    const button = byTestId("phone-steps-continue") as HTMLButtonElement
    const back = byTestId("phone-steps-back") as HTMLButtonElement
    expect(button.textContent).toBe("Create account with my security key")
    expect(button.disabled).toBe(true)
    expect(back.disabled).toBe(true)
    await act(async () => {
      button.click()
      back.click()
    })
    expect(onChoose).not.toHaveBeenCalled()
    await act(async () => root.render(<PhoneSteps reach="ok" onChoose={onChoose} />))
    expect(byTestId("phone-steps-continue")!.textContent).toBe(
      "Create account with my security key",
    )
    await click("phone-steps-continue")
    expect(onChoose).toHaveBeenCalledWith(["security-key"])
  })
})
