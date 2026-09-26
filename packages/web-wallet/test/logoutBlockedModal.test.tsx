import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
}))

const { LogoutBlockedModal } = await import("../src/ui/LogoutBlockedModal")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("LogoutBlockedModal", () => {
  let host: HTMLDivElement
  let root: Root
  const onClose = vi.fn()
  const onConfirm = vi.fn()

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
    onClose.mockClear()
    onConfirm.mockClear()
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root.render(<LogoutBlockedModal onClose={onClose} onConfirm={onConfirm} />))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
  })

  it("logs out anyway from the small link under OK", () => {
    const anyway = host.querySelector<HTMLButtonElement>(".ww-logout__anyway")!
    expect(anyway.textContent).toBe("Log out anyway")
    expect(host.querySelector(".ww-logout__actions .ww-logout__anyway")).toBeNull()
    act(() => anyway.click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it("says the tag is not registered yet and offers OK as the one action", () => {
    expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
      "Registration in progress",
    )
    expect(host.textContent).toContain("Don't log out yet")
    const body = host.querySelector(".ww-logout__body")?.textContent ?? ""
    expect(body).toContain("isn't registered yet")
    expect(body).toContain("harder to get back into your account")
    expect(body).toContain("Once registration is complete")
    const actions = host.querySelectorAll<HTMLButtonElement>(".ww-logout__actions button")
    expect(actions).toHaveLength(1)
    expect(actions[0].textContent).toBe("OK")
    act(() => actions[0].click())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("dismisses from the close icon", () => {
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
