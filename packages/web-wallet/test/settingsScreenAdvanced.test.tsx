import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  GradientInitialAvatar: () => null,
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  GradientToggle: () => null,
  Icon: () => null,
  IconCircle: () => null,
  RowChevron: () => null,
  SettingsRow: ({ label, onClick }: { label: string; onClick?: () => void }) => (
    <button onClick={onClick}>{label}</button>
  ),
}))
vi.mock("@obsidion/front-core", () => ({
  useConfigValue: () => ({ value: false, setValue: vi.fn() }),
}))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))
vi.mock("../src/features/identity/walletIdentity", () => ({ loadWalletIdentity: () => undefined }))
vi.mock("../src/lib/analytics", () => ({ appVersion: "0.0.0" }))
vi.mock("../src/ui/prefs", () => ({ useHideBalances: () => [false, vi.fn()] }))
vi.mock("../src/ui/FeedbackModals", () => ({
  BugReportModal: () => null,
  FeedbackModal: () => null,
}))
vi.mock("../src/ui/ContractAddressesModal", () => ({
  ContractAddressesModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="contract-addresses">
      <button onClick={onClose}>close</button>
    </div>
  ),
}))

vi.mock("../src/ui/ResetScreen", () => ({ RESET_PATH: "/reset" }))

const { SettingsScreen } = await import("../src/ui/screens/SettingsScreen")

let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<SettingsScreen />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((el) => el.textContent === label)

describe("SettingsScreen Advanced section", () => {
  it("opens and closes the contract addresses sheet", async () => {
    expect(container.textContent).toContain("Advanced")
    expect(container.querySelector('[data-testid="contract-addresses"]')).toBeNull()
    await act(async () => button("Contract addresses")!.click())
    expect(container.querySelector('[data-testid="contract-addresses"]')).not.toBeNull()
    await act(async () => button("close")!.click())
    expect(container.querySelector('[data-testid="contract-addresses"]')).toBeNull()
  })

  it("sends Clear local data to the reset page", async () => {
    const original = window.location
    const replace = vi.fn()
    Object.defineProperty(window, "location", { value: { replace }, writable: true })
    try {
      await act(async () => button("Clear local data")!.click())
      expect(replace).toHaveBeenCalledWith("/reset")
    } finally {
      Object.defineProperty(window, "location", { value: original, writable: true })
    }
  })
})
