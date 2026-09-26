/**
 * The tag card itself, rendered for real: in the start role its Enter and Login share one gate, a
 * blur cannot disable the button under the click, edits are handed up normalised, and the rows and
 * the chooser wait for preparation; in the confirm role nothing changed.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SignInStart } from "../src/features/onboarding/steps/ConfirmTagModal"

vi.mock("@obsidion/web-ds", () => ({
  PrimaryGradientButton: ({
    title,
    testId,
    isDisabled,
    isLoading,
    onClick,
  }: {
    title: string
    testId?: string
    isDisabled?: boolean
    isLoading?: boolean
    onClick?: () => void
  }) => (
    <button
      type="button"
      data-testid={testId ?? "primary"}
      disabled={isDisabled || isLoading}
      onClick={onClick}
    >
      {title}
    </button>
  ),
  Icon: () => <i />,
}))
vi.mock("../src/features/onboarding/OnboardingCard", () => ({
  OnboardingCard: ({ onClose, children }: { onClose?: () => void; children?: React.ReactNode }) => (
    <div>
      {onClose && <button type="button" data-testid="card-close" onClick={onClose} />}
      {children}
    </div>
  ),
}))

const { ConfirmTagModal } = await import("../src/features/onboarding/steps/ConfirmTagModal")

let container: HTMLDivElement
let root: Root
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Your tag"]')!
const type = async (value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input(), value)
    input().dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const submit = async () => {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  )
}
const click = (id: string) => act(async () => byTestId(id)!.click())

const onConfirm = vi.fn()
const onShowPasskeys = vi.fn()
const onBack = vi.fn()
const onClose = vi.fn()
const onCandidate = vi.fn()
const onTagChange = vi.fn()
const onTagBlur = vi.fn()
const onPrepareAgain = vi.fn()

const ROW = {
  credentialId: "cred-alice",
  pubkeyHex: "ab".repeat(64),
  l2Address: `0x${"ac".repeat(32)}`,
  usertag: "alice",
}

const start = (over: Partial<SignInStart> = {}): SignInStart => ({
  candidates: [],
  onCandidate,
  value: "",
  onTagChange,
  onTagBlur,
  submitReady: false,
  resolving: false,
  prepared: "ready",
  onPrepareAgain,
  chooserFirst: false,
  busy: false,
  ...over,
})

const renderStart = (over: Partial<SignInStart> = {}) =>
  act(async () =>
    root.render(
      <ConfirmTagModal
        start={start(over)}
        onConfirm={onConfirm}
        onShowPasskeys={onShowPasskeys}
        onClose={onClose}
      />,
    ),
  )

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("the start role", () => {
  it("titles itself Type your @tag, and carries the start test ids", async () => {
    await renderStart()
    expect(byTestId("sign-in-start")).not.toBeNull()
    expect(container.textContent).toContain("Type")
    expect(container.textContent).toContain("your @tag")
    expect(container.textContent).not.toContain("Confirm by typing")
    expect(byTestId("sign-in-login")).not.toBeNull()
    expect(byTestId("sign-in-show-passkeys")).not.toBeNull()
  })

  it("Enter submits nothing until the tag resolved; then Enter and Login each fire once", async () => {
    await renderStart({ value: "alice", submitReady: false })
    await submit()
    expect(onConfirm).not.toHaveBeenCalled()
    expect((byTestId("sign-in-login") as HTMLButtonElement).disabled).toBe(true)

    await renderStart({ value: "alice", submitReady: true })
    await submit()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await click("sign-in-login")
    expect(onConfirm).toHaveBeenCalledTimes(2)
    expect(onConfirm).toHaveBeenLastCalledWith("alice")
  })

  it("the Login click lands after the field blurs: the blur is handed up, the button stays enabled", async () => {
    await renderStart({ value: "alice", submitReady: true })
    await act(async () => input().focus())
    await act(async () => input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
    expect(onTagBlur).toHaveBeenCalledTimes(1)
    expect((byTestId("sign-in-login") as HTMLButtonElement).disabled).toBe(false)
    await click("sign-in-login")
    expect(onConfirm).toHaveBeenCalledWith("alice")
  })

  it("edits are handed up normalised — a leading @ dropped, lower-cased — and the field is controlled", async () => {
    await renderStart({ value: "ali" })
    await type("@Alice")
    expect(onTagChange).toHaveBeenLastCalledWith("alice")
    // The parent owns the value; until it re-renders, the field shows what it was given.
    expect(input().value).toBe("ali")
  })

  it("a row calls back with its account; rows, Login and Show passkeys wait for preparation and hold while busy", async () => {
    await renderStart({ candidates: [ROW], prepared: "pending", submitReady: true, value: "alice" })
    expect((byTestId("sign-in-account") as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId("sign-in-login") as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId("sign-in-show-passkeys") as HTMLButtonElement).disabled).toBe(true)

    await renderStart({ candidates: [ROW], submitReady: true, value: "alice" })
    expect(byTestId("sign-in-account")?.getAttribute("aria-label")).toBe("Sign in as @alice")
    await click("sign-in-account")
    expect(onCandidate).toHaveBeenCalledWith(ROW)

    await renderStart({ candidates: [ROW], submitReady: true, value: "alice", busy: true })
    expect((byTestId("sign-in-account") as HTMLButtonElement).disabled).toBe(true)
    expect((byTestId("sign-in-login") as HTMLButtonElement).disabled).toBe(true)
  })

  it("no rows, no list box", async () => {
    await renderStart()
    expect(byTestId("sign-in-accounts")).toBeNull()
    await renderStart({ candidates: [ROW] })
    expect(byTestId("sign-in-accounts")).not.toBeNull()
  })

  it("a notice renders inline under its own test id; a failed preparation offers only a re-prepare", async () => {
    await renderStart({ value: "alice", notice: { kind: "noKeyInstalled", tag: "alice" } })
    expect(byTestId("by-tag-noKeyInstalled")?.textContent).toContain("no passkey key installed")
    expect(byTestId("by-tag-noKeyInstalled")?.textContent).toContain("Show passkeys")

    await renderStart({ value: "alice", notice: { kind: "unreadable", tag: "alice" } })
    expect(byTestId("by-tag-unreadable")?.textContent).toContain("couldn't be read")

    await renderStart({ value: "alice", notice: { kind: "listed", tag: "alice" } })
    expect(byTestId("by-tag-listed")?.textContent).toContain("already on this browser")

    // A read the network refused is the one notice with a retry: it asks the way leaving the field does.
    await renderStart({ value: "alice", notice: { kind: "lookupFailed", tag: "alice" } })
    expect(byTestId("by-tag-lookupFailed")?.textContent).toContain("Show passkeys")
    await click("by-tag-retry")
    expect(onTagBlur).toHaveBeenCalledTimes(1)

    await renderStart({ prepared: "failed" })
    expect(byTestId("sign-in-unprepared")?.textContent).toContain("Couldn't reach the network")
    await click("sign-in-prepare-again")
    expect(onPrepareAgain).toHaveBeenCalledTimes(1)
    expect(onShowPasskeys).not.toHaveBeenCalled()
  })

  it("with the chooser first, Show passkeys is the primary button and Login a secondary one", async () => {
    await renderStart({ chooserFirst: true, value: "alice", submitReady: true })
    expect(byTestId("sign-in-show-passkeys")?.tagName).toBe("BUTTON")
    expect(container.querySelector(".ww-invite-modal-foot")).toBeNull()
    await click("sign-in-show-passkeys")
    expect(onShowPasskeys).toHaveBeenCalledTimes(1)
    await click("sign-in-login")
    expect(onConfirm).toHaveBeenCalledWith("alice")
  })

  it("an invalid tag shows the rule it broke", async () => {
    await renderStart({ value: "a b" })
    expect(container.textContent).toContain("Letters, numbers and hyphens only")
  })
})

describe("the confirm role", () => {
  const renderConfirm = (initialHandle?: string) =>
    act(async () =>
      root.render(
        <ConfirmTagModal
          initialHandle={initialHandle}
          onConfirm={onConfirm}
          onBack={onBack}
          onClose={onClose}
        />,
      ),
    )

  it("keeps its title, its own test ids, and submits any well-formed tag", async () => {
    await renderConfirm("Alice")
    expect(byTestId("confirm-tag")).not.toBeNull()
    expect(byTestId("sign-in-start")).toBeNull()
    expect(container.textContent).toContain("Confirm by typing")
    expect(input().value).toBe("alice")
    await click("primary")
    expect(onConfirm).toHaveBeenCalledWith("alice")
    await submit()
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })

  it("an invalid tag disables Login; Go back and the close call their handlers, and no open request is offered", async () => {
    await renderConfirm()
    await type("a b")
    expect((byTestId("primary") as HTMLButtonElement).disabled).toBe(true)
    expect(byTestId("sign-in-show-passkeys")).toBeNull()
    expect(container.textContent).toContain("Not your account?")
    await click("confirm-back")
    expect(onBack).toHaveBeenCalledTimes(1)
    await click("card-close")
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
