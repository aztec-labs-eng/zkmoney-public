import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  ComingSoonPill: () => null,
  GradientInitialAvatar: () => null,
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  GradientToggle: () => null,
  Icon: () => null,
  IconCircle: () => null,
  RowChevron: () => null,
  SettingsRow: ({
    label,
    onClick,
    trailing,
  }: {
    label: string
    onClick?: () => void
    trailing?: React.ReactNode
  }) => (
    <div data-row={label}>
      <button onClick={onClick}>{label}</button>
      {trailing}
    </div>
  ),
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
}))
vi.mock("@obsidion/front-core", () => ({
  useConfigValue: () => ({ value: false, setValue: vi.fn() }),
}))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))
vi.mock("../src/features/identity/walletIdentity", () => ({ loadWalletIdentity: () => undefined }))
vi.mock("../src/lib/analytics", () => ({ appVersion: "0.0.0" }))
vi.mock("../src/ui/prefs", () => ({ useHideBalances: () => [false, vi.fn()] }))
vi.mock("../src/features/requests/useNonContactRequests", () => ({
  useNonContactRequests: () => ({ requests: [], allowed: true, setAllowed: vi.fn() }),
}))
vi.mock("../src/ui/FeedbackModals", () => ({
  BugReportModal: () => null,
  FeedbackModal: () => null,
}))
const allowance = vi.hoisted(() => ({
  snapshot: { status: "loading", scope: "s" } as unknown,
  refresh: vi.fn(),
}))
vi.mock("../src/features/allowance/useSponsoredAllowance", () => ({
  useSponsoredAllowance: () => ({ snapshot: allowance.snapshot, refresh: allowance.refresh }),
}))
vi.mock("../src/ui/ContractAddressesModal", () => ({ ContractAddressesModal: () => null }))
vi.mock("../src/dev/ConfigProfileModal", () => ({ ConfigProfileModal: () => null }))
vi.mock("../src/ui/EndpointsModal", () => ({
  EndpointsModal: () => null,
  customEndpointsLabel: () => undefined,
}))
vi.mock("../src/ui/ResetScreen", () => ({ RESET_PATH: "/reset" }))
vi.mock("../src/features/deposit/StrandedRecoveryModal", () => ({
  StrandedRecoveryModal: () => null,
}))
// The wallet container reads the chain; the row only needs a real sheet to open and close.
vi.mock("../src/features/limits/AboutLimitsSheet", async () => {
  const { Modal } = await import("../src/ui/Modal")
  return {
    WalletAboutLimitsSheet: ({ onClose, topic }: { onClose: () => void; topic?: string }) => (
      <Modal title="About limits" onClose={onClose}>
        <div data-testid="about-limits-sheet" data-topic={topic ?? "all"} />
      </Modal>
    ),
  }
})

const { SettingsScreen } = await import("../src/ui/screens/SettingsScreen")

let root: Root
let container: HTMLDivElement

const ready = (state: unknown) => ({
  status: "ready",
  scope: "s",
  read: { allowance: { refillPeriod: 86_400 } },
  state,
  refreshing: false,
})

beforeEach(async () => {
  allowance.refresh.mockClear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <MemoryRouter>
        <SettingsScreen />
      </MemoryRouter>,
    ),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const row = () =>
  [...container.querySelectorAll("button")].find((el) => el.textContent === "Limits")!
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[aria-label="About limits"]')

describe("SettingsScreen Limits row", () => {
  it("opens the About limits sheet and returns focus to the row on Escape", async () => {
    row().focus()
    await act(async () => row().click())
    expect(dialog()?.open).toBe(true)
    await act(async () => {
      dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(row())
  })

  it("closes from the sheet's Close button", async () => {
    await act(async () => row().click())
    await act(async () =>
      dialog()!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(),
    )
    expect(dialog()).toBeNull()
  })
})

describe("SettingsScreen Sponsored transactions row", () => {
  const sponsored = () =>
    [...container.querySelectorAll("button")].find(
      (el) => el.textContent === "Sponsored transactions",
    )!
  const value = () => container.querySelector('[data-row="Sponsored transactions"]')!.textContent
  const rerender = (snapshot: unknown) => {
    allowance.snapshot = snapshot
    return act(async () =>
      root.render(
        <MemoryRouter>
          <SettingsScreen />
        </MemoryRouter>,
      ),
    )
  }

  it("reads the allowance again on each visit", () => {
    expect(allowance.refresh).toHaveBeenCalledTimes(1)
  })

  it("shows the remaining count, and keeps a proven none apart from unknown", async () => {
    await rerender(ready({ kind: "available", available: 42, renews: true }))
    expect(value()).toContain("42 left")
    // Only a rail that never renews proves none are left.
    await rerender(ready({ kind: "does-not-renew" }))
    expect(value()).toContain("0 left")
    // A stored zero that may renew is not stated as used up, and names no time; the sheet explains.
    await rerender(ready({ kind: "renewal-unknown", maxTx: 100 }))
    expect(value()).toContain("Unknown")
    expect(value()).not.toContain("0 left")
    await rerender(ready({ kind: "not-subscribed", maxTx: 100, renews: true }))
    expect(value()).toContain("Not started")
    await rerender({ status: "unavailable", scope: "s", error: new Error("pxe") })
    expect(value()).toContain("Unavailable")
    await rerender({ status: "loading", scope: "s" })
    expect(value()).toContain("Checking…")
  })

  it("opens the shared sheet on sponsorship, while Limits opens every section", async () => {
    sponsored().focus()
    await act(async () => sponsored().click())
    const sheet = document.querySelector<HTMLElement>('[data-testid="about-limits-sheet"]')!
    expect(sheet.dataset.topic).toBe("sponsorship")
    await act(async () => {
      dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(document.activeElement).toBe(sponsored())
    await act(async () => row().click())
    expect(
      document.querySelector<HTMLElement>('[data-testid="about-limits-sheet"]')!.dataset.topic,
    ).toBe("all")
  })
})
