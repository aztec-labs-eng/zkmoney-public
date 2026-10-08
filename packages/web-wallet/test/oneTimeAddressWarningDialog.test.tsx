/**
 * The one-time-address warning dialog persists its hide only when the box is checked and the user
 * confirms with Got it. Closing never persists, checked or not.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/ui/Modal", () => ({
  Modal: ({ children }: { children?: React.ReactNode }) => <div role="dialog">{children}</div>,
}))
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {title}
    </button>
  ),
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel?: string; onClick?: () => void }) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick} />
  ),
}))

const { OneTimeAddressWarning } = await import("../src/features/deposit/OneTimeAddressWarning")
const { deviceStorage } = await import("../src/platform/storage/rollupStorage")

const HIDE_KEY = "webwallet.hide-one-time-address-warning"

describe("OneTimeAddressWarning dialog", () => {
  let container: HTMLDivElement
  let root: Root
  const onClose = vi.fn()
  const onGotIt = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const show = () =>
    act(async () =>
      root.render(<OneTimeAddressWarning symbol="TEST" onClose={onClose} onGotIt={onGotIt} />),
    )
  const checkbox = () => container.querySelector<HTMLInputElement>("input[type='checkbox']")!
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === text)!
  const close = () => container.querySelector<HTMLButtonElement>("[aria-label='Close']")!

  it("stores the hide only after the checkbox and Got it", async () => {
    await show()
    expect(container.textContent).toContain("This is a unique")
    expect(container.textContent).toContain("Don't show this again")

    await act(async () => button("Got it!").click())
    expect(onGotIt).toHaveBeenCalledOnce()
    expect(deviceStorage.getItem(HIDE_KEY)).toBeNull()

    await show()
    await act(async () => checkbox().click())
    await act(async () => button("Got it!").click())
    expect(onGotIt).toHaveBeenCalledTimes(2)
    expect(deviceStorage.getItem(HIDE_KEY)).toBe("true")
  })

  it("does not store the hide when closed with the box checked", async () => {
    await show()
    await act(async () => checkbox().click())
    expect(checkbox().checked).toBe(true)

    await act(async () => close().click())
    expect(onClose).toHaveBeenCalledOnce()
    expect(onGotIt).not.toHaveBeenCalled()
    expect(deviceStorage.getItem(HIDE_KEY)).toBeNull()
  })
})
