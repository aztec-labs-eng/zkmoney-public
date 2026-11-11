/**
 * The shell's Log out refuses while a registration claim is in flight. The view decides it, so the
 * guard is pinned here.
 */
import { act, type ReactNode } from "react"
import { seedDeviceKeys, testPage, testCore } from "../support/page"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { saveSetting } from "../../src/platform/storage/deviceKeys"

const state = vi.hoisted(() => ({
  savings: false,
  unlocked: true,
  handle: "alice" as string | undefined,
  owed: false,
  blocked: false,
  onboarded: true,
  launcher: false,
  phone: true,
  listeners: new Set<() => void>(),
  logout: vi.fn(),
  /** Actions that must wait for the upgrade, and every action a press asked for. */
  upgrade: new Set<string>(),
  asked: [] as string[],
}))
vi.mock("../../src/features/actionGate", () => ({
  useActionGuard: () => (action: string, run: () => void) => {
    state.asked.push(action)
    if (!state.upgrade.has(action)) run()
  },
}))
// Savings reads the booted profile, which this suite never boots.
vi.mock("../../src/features/savings/savingsGateway", () => ({
  useSavingsAvailable: () => state.savings,
}))
vi.mock("../../src/features/registration/openRegistration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/registration/openRegistration")>()),
  openRegistration: () => null,
  useRegistrationTagChangeable: () => false,
  useNameClaimPending: () => false,
  useRegistrationDepositOwed: () => state.owed,
}))
vi.mock("@obsidion/web-ds", () => ({
  GradientInitialAvatar: () => null,
  Icon: () => null,
  Toast: ({ message, onDismiss }: { message: string; onDismiss: () => void }) => (
    <div data-testid="toast">
      {message}
      <button onClick={onDismiss}>Dismiss toast</button>
    </div>
  ),
  Spinner: () => null,
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
  ZkMoneyRoot: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("../../src/dev/demoFlag", () => ({ isDemoMode: () => false }))
const fakeAuth = () => ({ getSecretKey: async () => new Uint8Array([1]) })
vi.mock("../../src/platform/desktopBridge", () => ({
  getDesktopL1Bridge: () => (state.launcher ? { l1SubmitPath: "/bridge" } : null),
}))
vi.mock("../../src/features/scan/ScannerModal", () => ({
  ScannerModal: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Scan QR code">
      <button onClick={onClose}>Close scanner</button>
    </div>
  ),
}))
vi.mock("../../src/features/scan/scanPayload", () => ({ scanPayload: vi.fn() }))
vi.mock("../../src/features/identity/logout", () => ({ logout: state.logout }))
vi.mock("../../src/features/registration/webRegistration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/registration/webRegistration")>()),
  isLogoutBlockedByRegistration: () => state.blocked,
}))
vi.mock("../../src/features/contacts/TagSearchBar", () => ({
  TagSearchBar: ({
    autoFocus,
    onDismiss,
    placeholder,
  }: {
    autoFocus?: boolean
    onDismiss?: () => void
    placeholder?: string
  }) => (
    <input
      aria-label="Search @tag"
      autoFocus={autoFocus}
      placeholder={placeholder}
      onKeyDown={(e) => e.key === "Escape" && onDismiss?.()}
    />
  ),
}))
vi.mock("../../src/ui/LogoutModal", () => ({
  LogoutModal: ({ onConfirm }: { onConfirm: () => void }) => (
    <div role="dialog" aria-label="Log out">
      <button onClick={onConfirm}>Confirm logout</button>
    </div>
  ),
}))
vi.mock("../../src/ui/LogoutBlockedModal", () => ({
  LogoutBlockedModal: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Registration in progress">
      <button onClick={onClose}>OK</button>
    </div>
  ),
}))
import { SidebarLayout } from "../../src/ui/AppShell/AppShell"
import { activeNamespace, closeSession, switchSession } from "../../src/session/session"
import { pageSessionDeps } from "../../src/app/sessionDeps"
import { openTestSession } from "../support/session"
import { seedOnboarded, setIdentity } from "../support/identity"

/** The session's identity, and the passkey record that entered it while `state.onboarded`. */
async function seedIdentityState() {
  const identity = { handle: state.handle, address: "0x123" }
  if (state.onboarded) return seedOnboarded(identity, "localhost")
  await setIdentity(identity)
  await seedDeviceKeys({ passkeyMap: null })
}

const deviceDb = testPage().database

let host: HTMLDivElement
let root: Root
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === label,
  )!
const click = (label: string) =>
  act(() => {
    button(label).focus()
    button(label).click()
  })
const menu = () => host.querySelector<HTMLDialogElement>("dialog")
const render = () =>
  act(() => {
    // The session's account: unlocked, or its own, which stays locked.
    openTestSession({ auth: fakeAuth(), account: state.unlocked ? {} : undefined })
    root.render(
      <MemoryRouter>
        <Routes>
          <Route element={<SidebarLayout />}>
            <Route path="*" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
  })
beforeEach(async () => {
  // The analytics question was answered, so the shell renders without it.
  await saveSetting(deviceDb, "analyticsConsent", false)
  state.upgrade = new Set()
  state.asked = []
  state.savings = false
  state.phone = true
  state.unlocked = true
  state.handle = "alice"
  state.owed = false
  state.blocked = false
  state.onboarded = true
  state.launcher = false
  state.listeners.clear()
  state.logout.mockClear()
  // The bell over this suite's operations, with no records and no notification state.
  const { bell, milestones } = switchSession(
    activeNamespace(testCore().device),
    pageSessionDeps(testPage(fakeAuth())),
  )
  // Booted to the bell's milestones: its list is complete, so new entries toast.
  milestones.mark("firstBalance")
  milestones.mark("depositsReplayed")
  milestones.mark("historyAtHead")
  await vi.waitFor(() => expect(bell.get().sources.loaded).toBe(true))
  await seedIdentityState()
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return state.phone
    },
    addEventListener: (_: string, fn: () => void) => state.listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => state.listeners.delete(fn),
  }))
  // Browser checks cover native focus containment, which jsdom does not implement.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList)
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.documentElement.style.overflow = ""
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  closeSession()
})

describe("logout gate", () => {
  const dialog = (label: string) => host.querySelector(`[role="dialog"][aria-label="${label}"]`)
  const openLogout = () => {
    click("Open menu")
    click("Log out")
  }

  it("confirms and logs out when no claim is in flight", () => {
    render()
    openLogout()
    expect(menu()).toBeNull()
    expect(dialog("Log out")).not.toBeNull()
    expect(dialog("Registration in progress")).toBeNull()
    click("Confirm logout")
    expect(state.logout).toHaveBeenCalledTimes(1)
  })

  it("refuses while a claim is in flight and never reaches logout", () => {
    state.blocked = true
    render()
    openLogout()
    expect(menu()).toBeNull()
    expect(dialog("Registration in progress")).not.toBeNull()
    expect(dialog("Log out")).toBeNull()
    click("OK")
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(state.logout).not.toHaveBeenCalled()
  })

  it("reads the claim at the click, not at the last render", () => {
    render()
    click("Open menu")
    state.blocked = true
    click("Log out")
    expect(dialog("Registration in progress")).not.toBeNull()
    click("OK")
    click("Open menu")
    state.blocked = false
    click("Log out")
    expect(dialog("Log out")).not.toBeNull()
  })

  it("keeps the open popup when the claim settles underneath it", () => {
    state.blocked = true
    render()
    openLogout()
    state.blocked = false
    render()
    expect(dialog("Registration in progress")).not.toBeNull()
    expect(dialog("Log out")).toBeNull()
    click("OK")
    openLogout()
    expect(dialog("Log out")).not.toBeNull()
  })

  it("leaves a locked wallet's Log out alone even with a claim in flight", () => {
    state.unlocked = false
    state.blocked = true
    render()
    openLogout()
    expect(dialog("Log out")).not.toBeNull()
    click("Confirm logout")
    expect(state.logout).toHaveBeenCalledTimes(1)
  })
})
