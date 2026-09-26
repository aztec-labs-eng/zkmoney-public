import { act, StrictMode, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  unlocked: true,
  handle: "alice" as string | undefined,
  pending: false,
  blocked: false,
  onboarded: true,
  admitted: true,
  launcher: false,
  phone: true,
  listeners: new Set<() => void>(),
  markAllRead: vi.fn(),
  logout: vi.fn(),
}))
vi.mock("../src/features/operations/operations", async () =>
  (await import("./support/fakeOperations")).fakeOperationsModule(),
)
vi.mock("../src/features/onboarding/RegistrationDepositPrompt", () => ({
  RegistrationDepositPrompt: () => null,
  useAwaitingDepositRecord: () => null,
}))
vi.mock("@obsidion/front-core", () => ({
  useAccountContext: () => ({ obsidionAccount: state.unlocked ? {} : undefined }),
  useAztecContext: () => ({ obsidionWallet: undefined }),
  useAppNotifications: () => ({
    entries: [],
    hydrated: true,
    unreadCount: 0,
    markAllRead: state.markAllRead,
  }),
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
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick: () => void }) => <button aria-label={ariaLabel} onClick={onClick} />,
  ZkMoneyRoot: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("../src/dev/demoFlag", () => ({ isDemoMode: () => false }))
vi.mock("../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ handle: state.handle, address: "0x123", pending: state.pending }),
  loadOnboardedIdentity: () => state.onboarded ? { handle: state.handle, address: "0x123", pending: state.pending } : null,
}))
vi.mock("../src/features/identity/admission", () => ({ hasWalletEntry: () => state.admitted }))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: async () => new Uint8Array([1]) }),
}))
vi.mock("../src/platform/desktopBridge", () => ({ getDesktopL1Bridge: () => state.launcher ? { l1SubmitPath: "/bridge" } : null }))
vi.mock("../src/features/scan/ScannerModal", () => ({
  ScannerModal: ({ onClose }: { onClose: () => void }) => <div role="dialog" aria-label="Scan QR code"><button onClick={onClose}>Close scanner</button></div>,
}))
vi.mock("../src/features/scan/scanPayload", () => ({ scanPayload: vi.fn() }))
vi.mock("../src/features/identity/logout", () => ({ logout: state.logout }))
vi.mock("../src/features/onboarding/webRegistration", () => ({
  isLogoutBlockedByRegistration: () => state.blocked,
}))
vi.mock("../src/features/contacts/TagSearchBar", () => ({
  TagSearchBar: ({ autoFocus, onDismiss }: { autoFocus?: boolean; onDismiss?: () => void }) => (
    <input
      aria-label="Search @tag"
      autoFocus={autoFocus}
      onKeyDown={(e) => e.key === "Escape" && onDismiss?.()}
    />
  ),
}))
vi.mock("../src/features/contacts/ShareTagModal", () => ({
  ShareTagModal: () => <div role="dialog" aria-label="Share @tag" />,
}))
vi.mock("../src/ui/LogoutModal", () => ({
  LogoutModal: ({ onConfirm }: { onConfirm: () => void }) => (
    <div role="dialog" aria-label="Logout">
      <button onClick={onConfirm}>Confirm logout</button>
    </div>
  ),
}))
vi.mock("../src/ui/LogoutBlockedModal", () => ({
  LogoutBlockedModal: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Registration in progress">
      <button onClick={onClose}>OK</button>
    </div>
  ),
}))
vi.mock("../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
import { SidebarLayout, useShellActions } from "../src/ui/AppShell"
import { MobileMenu } from "../src/ui/MobileMenu"

let host: HTMLDivElement
let root: Root
function Page() {
  const navigate = useNavigate()
  const { openMenu, openShareTag, openScanner, scannerAvailable } = useShellActions()
  return (
    <>
      <button onClick={() => navigate("/contacts")}>Go to contacts</button>
      <button onClick={openMenu}>Page menu</button>
      <button onClick={openShareTag}>Page Share</button>
      {scannerAvailable && <button onClick={openScanner}>Page Scan</button>}
    </>
  )
}
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
const render = (path = "/", mobilePageHeaderPaths: readonly string[] = [], autoFocusContacts = false, enablePhoneScan = false) =>
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<SidebarLayout mobilePageHeaderPaths={mobilePageHeaderPaths} enablePhoneScan={enablePhoneScan} />}>
            <Route path="contacts" element={
              <>
                {autoFocusContacts && <input aria-label="Contacts search" autoFocus />}
                <Page />
              </>
            } />
            <Route path="*" element={<Page />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
  })
beforeEach(() => {
  state.phone = true
  state.unlocked = true
  state.handle = "alice"
  state.pending = false
  state.blocked = false
  state.onboarded = true
  state.admitted = true
  state.launcher = false
  state.listeners.clear()
  state.markAllRead.mockClear()
  state.logout.mockClear()
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return state.phone },
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
  if (button("Notifications")?.getAttribute("aria-expanded") === "true") click("Notifications")
  act(() => root.unmount())
  host.remove()
  document.documentElement.style.overflow = ""
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe("phone shell", () => {
  it.each([true, false])("keeps the correct primary action order when phone=%s", (phone) => {
    state.phone = phone
    render()
    if (phone) click("Open menu")
    expect([...host.querySelectorAll(".ww-sidebar__menu .ww-nav-item")].map((b) => b.textContent)).toEqual([
      "Home", "Contacts", "Deposit", ...(phone ? ["Receive", "Send"] : ["Send", "Receive"]),
      "Withdraw", "Activity", "Settings",
    ])
  })
  it("scopes the new Home composition to the exact phone Home route", () => {
    render("/send")
    expect(host.querySelector(".ww-shell--home")).toBeNull()
  })
  it("focuses expanded search and returns to its trigger on Escape", () => {
    render()
    expect(host.querySelector("input")).toBeNull()
    click("Open search")
    expect(document.activeElement).toBe(host.querySelector("input"))
    act(() =>
      host
        .querySelector("input")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    )
    expect(host.querySelector("input")).toBeNull()
    expect(document.activeElement).toBe(button("Open search"))
  })
  it("closes search, enters the menu, and restores focus and scrolling on Escape", () => {
    document.documentElement.style.overflow = "clip"
    render()
    click("Open search")
    click("Open menu")
    expect(host.querySelector("input")).toBeNull()
    expect(menu()?.open).toBe(true)
    expect(document.documentElement.style.overflow).toBe("hidden")
    expect(document.activeElement).toBe(button("Close menu"))
    act(() => menu()!.dispatchEvent(new Event("cancel", { cancelable: true })))
    expect(menu()).toBeNull()
    expect(document.documentElement.style.overflow).toBe("clip")
    expect(document.activeElement).toBe(button("Open menu"))
  })
  it("releases the menu before Share mounts", () => {
    render()
    click("Open menu")
    click("Share @tag")
    expect(menu()).toBeNull()
    expect(document.documentElement.style.overflow).toBe("")
    expect(host.querySelector('[role="dialog"][aria-label="Share @tag"]')).not.toBeNull()
  })
  it("keeps working Contacts navigation until its page header opts in", () => {
    render()
    click("Open menu")
    click("Contacts")
    expect(menu()).toBeNull()
    expect(button("Open search")).toBeDefined()
    expect(button("Account settings, @alice.zk.money")).toBeDefined()
    click("Open menu")
    click("Home")
    expect(menu()).toBeNull()
  })
  it("lets an exact page path own the phone header", () => {
    render("/contacts", ["/contacts"])
    expect(button("Open search")).toBeUndefined()
    expect(button("Account settings, @alice.zk.money")).toBeUndefined()
    click("Page menu")
    expect(menu()?.open).toBe(true)
  })
  it("keeps the shell header on contact detail paths", () => {
    render("/contacts/alice", ["/contacts"])
    expect(button("Open menu")).toBeDefined()
    expect(button("Open search")).toBeDefined()
  })
  it("preserves focus requested by the destination page", () => {
    render("/", [], true)
    click("Open menu")
    click("Contacts")
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Contacts search"]'))
  })
  it("cleans up across the breakpoint and keeps desktop Contacts search", () => {
    render("/contacts", ["/contacts"])
    click("Page menu")
    act(() => {
      state.phone = false
      state.listeners.forEach((fn) => fn())
    })
    expect(menu()).toBeNull()
    expect(document.documentElement.style.overflow).toBe("")
    expect(host.querySelector("input")).not.toBeNull()
    expect(document.activeElement).toBe(button("Page menu"))
    act(() => {
      state.phone = true
      state.listeners.forEach((fn) => fn())
    })
    expect(menu()).toBeNull()
    expect(host.querySelector("input")).toBeNull()
  })
  it("does not expose identity, notifications or search above the phone unlock gate", () => {
    state.unlocked = false
    render()
    expect(button("Account settings, @alice.zk.money")).toBeUndefined()
    expect(button("Notifications")).toBeUndefined()
    expect(button("Open search")).toBeUndefined()
    expect(button("Open menu")).toBeDefined()
  })
  it("keeps the brand lockup and menu on locked Contacts until its page can render", () => {
    state.unlocked = false
    render("/contacts", ["/contacts"])
    expect(host.querySelector(".ww-shell-header .ww-brand")).not.toBeNull()
    expect(button("Open search")).toBeUndefined()
    expect(button("Notifications")).toBeUndefined()
    click("Open menu")
    expect(menu()?.open).toBe(true)
    expect(button("Logout")).toBeDefined()
    click("Close menu")
    state.unlocked = true
    render("/contacts", ["/contacts"])
    expect(host.querySelector(".ww-shell-header")).toBeNull()
  })
  it("clears expanded search when the account locks", () => {
    render()
    click("Open search")
    state.unlocked = false
    render()
    expect(host.querySelector("input")).toBeNull()
    expect(button("Open search")).toBeUndefined()
    state.unlocked = true
    render()
    expect(button("Open search")).toBeDefined()
    expect(host.querySelector("input")).toBeNull()
  })
  it.each(["Open search", "Open menu", "Page Share"])(
    "marks notifications read when %s closes the panel",
    (action) => {
      render()
      click("Notifications")
      expect(state.markAllRead).not.toHaveBeenCalled()
      click(action)
      expect(host.querySelector(".ww-notifications")).toBeNull()
      expect(state.markAllRead).toHaveBeenCalledTimes(1)
    },
  )
  it("toasts a new ended operation once", async () => {
    const { getOperationStore } = await import("../src/features/operations/operations")
    const store = getOperationStore() as unknown as {
      begin(r: object): Promise<void>
      settle(id: string, hash?: string): Promise<void>
      remove(id: string): Promise<void>
      dismiss(id: string): Promise<void>
    }
    render()
    await act(async () => {
      await store.begin({ operationId: "op-toast", flow: "send", summary: "$2 to @bo", scope: null })
      await store.settle("op-toast", "0x02")
    })
    const toasts = () => host.querySelectorAll('[data-testid="toast"]')
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].textContent).toContain("Sent: $2 to @bo")
    click("Dismiss toast")
    await act(async () => {
      await store.begin({ operationId: "op-other", flow: "send", summary: "$3", scope: null })
      await store.remove("op-other")
    })
    expect(toasts()).toHaveLength(0)
    await act(async () => store.dismiss("op-toast"))
  })
  it("rings the bell for a sent transaction this page no longer runs", async () => {
    const { getOperationStore } = await import("../src/features/operations/operations")
    const store = getOperationStore() as unknown as {
      begin(r: object): Promise<void>
      markSent(id: string, hash: string): Promise<void>
      release(id: string): void
      remove(id: string): Promise<void>
    }
    await act(async () => {
      await store.begin({ operationId: "op-bell", flow: "send", summary: "$1", scope: null })
      await store.markSent("op-bell", "0x01")
      store.release("op-bell")
    })
    render()
    expect(host.querySelector(".ww-notifications__bell-ring.is-safe")).not.toBeNull()
    expect(button("Notifications, a transaction is finishing")).toBeDefined()
    await act(async () => store.remove("op-bell"))
    expect(host.querySelector(".ww-notifications__bell-ring")).toBeNull()
  })
  it("keeps phone focus order aligned with the visible header", () => {
    render()
    expect([...host.querySelectorAll(".ww-topbar button")].map((b) => b.getAttribute("aria-label"))).toEqual([
      "Account settings, @alice.zk.money", "Notifications", "Open search", "Open menu",
    ])
    expect(button("Open search").hasAttribute("aria-controls")).toBe(false)
    expect(button("Open menu").hasAttribute("aria-controls")).toBe(false)
    click("Open search")
    expect(host.querySelector(`#${button("Close search").getAttribute("aria-controls")}`)).not.toBeNull()
    click("Open menu")
    expect(host.querySelector(`#${button("Open menu").getAttribute("aria-controls")}`)).toBe(menu())
  })
  it("restores scrolling and subscriptions when unmounted with the menu open", () => {
    render()
    click("Open menu")
    act(() => root.render(null))
    expect(document.documentElement.style.overflow).toBe("")
    expect(state.listeners.size).toBe(0)
  })
  it("ignores a queued replay close and nested events but reconciles a native menu close", async () => {
    const close = vi.fn()
    HTMLDialogElement.prototype.close = function () {
      if (!this.open) return
      this.open = false
      queueMicrotask(() => this.dispatchEvent(new Event("close")))
    }
    await act(async () => root.render(
      <StrictMode><MobileMenu onClose={close}><button aria-label="Close menu" /><dialog aria-label="Nested test" /></MobileMenu></StrictMode>,
    ))
    expect(menu()!.open).toBe(true)
    expect(close).not.toHaveBeenCalled()
    act(() => host.querySelector('[aria-label="Nested test"]')!.dispatchEvent(new Event("close", { bubbles: true })))
    expect(close).not.toHaveBeenCalled()
    await act(async () => menu()!.close())
    expect(close).toHaveBeenCalledOnce()
  })

})

describe("phone scanner entry guards", () => {
  it("opens from the menu only with the explicit wallet opt-in and returns focus to its viable trigger", () => {
    render("/", [], false, true)
    click("Open menu")
    click("Scan QR code")
    expect(menu()).toBeNull()
    expect(host.querySelector('[role="dialog"][aria-label="Scan QR code"]')).not.toBeNull()
    click("Close scanner")
    expect(document.activeElement).toBe(button("Open menu"))
  })
  it.each(["phone", "unlocked", "onboarded", "admitted", "handle", "pending", "launcher"] as const)("does not expose Scan when %s fails its gate", (gate) => {
    if (gate === "handle") state.handle = undefined
    else if (gate === "pending" || gate === "launcher") state[gate] = true
    else state[gate] = false
    render("/", [], false, true)
    if (state.phone) click("Open menu")
    expect(button("Scan QR code")).toBeUndefined()
    expect(button("Page Scan")).toBeUndefined()
  })
  it("closes an active scanner when the wallet locks", () => {
    render("/", [], false, true)
    click("Page Scan")
    expect(host.querySelector('[aria-label="Scan QR code"]')).not.toBeNull()
    state.unlocked = false
    render("/", [], false, true)
    expect(host.querySelector('[aria-label="Scan QR code"]')).toBeNull()
  })
})

describe("logout gate", () => {
  const dialog = (label: string) => host.querySelector(`[role="dialog"][aria-label="${label}"]`)
  const openLogout = () => {
    click("Open menu")
    click("Logout")
  }

  it("confirms and logs out when no claim is in flight", () => {
    render()
    openLogout()
    expect(menu()).toBeNull()
    expect(dialog("Logout")).not.toBeNull()
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
    expect(dialog("Logout")).toBeNull()
    click("OK")
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(state.logout).not.toHaveBeenCalled()
  })

  it("reads the claim at the click, not at the last render", () => {
    render()
    click("Open menu")
    state.blocked = true
    click("Logout")
    expect(dialog("Registration in progress")).not.toBeNull()
    click("OK")
    click("Open menu")
    state.blocked = false
    click("Logout")
    expect(dialog("Logout")).not.toBeNull()
  })

  it("keeps the open popup when the claim settles underneath it", () => {
    state.blocked = true
    render()
    openLogout()
    state.blocked = false
    render()
    expect(dialog("Registration in progress")).not.toBeNull()
    expect(dialog("Logout")).toBeNull()
    click("OK")
    openLogout()
    expect(dialog("Logout")).not.toBeNull()
  })

  it("leaves a locked wallet's Logout alone even with a claim in flight", () => {
    state.unlocked = false
    state.blocked = true
    render()
    openLogout()
    expect(dialog("Logout")).not.toBeNull()
    click("Confirm logout")
    expect(state.logout).toHaveBeenCalledTimes(1)
  })
})
