/**
 * The bell panel reads the shared notification store: the "N new" badge counts unread entries, a
 * row tap dismisses its entry and hands the activity feed the router state that opens its detail,
 * and a live row spins instead of showing a timestamp and survives the tap.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AppNotificationStore,
  type AppNotificationEntry,
  type IStorageAdapter,
} from "@obsidion/front-core"
import { NotificationsPanel, freshToasts, toastKey } from "../src/ui/NotificationsPanel"

const layout = vi.hoisted(() => ({ phone: false }))
vi.mock("../src/ui/usePhoneLayout", () => ({ usePhoneLayout: () => layout.phone }))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const memory = new Map<string, string>()
const adapter: IStorageAdapter = {
  getItem: async (k) => memory.get(k) ?? null,
  setItem: async (k, v) => void memory.set(k, v),
  removeItem: async (k) => void memory.delete(k),
  clear: async () => memory.clear(),
}

let landed: unknown = null
function Activity() {
  landed = useLocation().state
  return <p>activity</p>
}

describe("NotificationsPanel", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    layout.phone = false
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    const store = AppNotificationStore.get(adapter)
    await store.load()
    await store.createIfAbsent({
      id: "transfer:receive:0xabc",
      producer: "transfer",
      domain: "transfer",
      sourceId: "0xabc",
      title: "Transfer received",
      description: "+1 ETH from @alice",
      timestampMs: 1_700_000_000_000,
      systemIcon: "arrow.down.left",
      severity: "success",
      target: { type: "transfer.txDetail", txHash: "0xabc" },
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("counts unread, then marks read and routes the tap to the activity feed", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<NotificationsPanel onClose={() => {}} />} />
            <Route path="/activity" element={<Activity />} />
          </Routes>
        </MemoryRouter>,
      )
    })
    expect(container.textContent).toContain("1 new")
    expect(container.textContent).toContain("+1 ETH from @alice")

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".ww-notifications__row")!.click()
    })
    expect(landed).toEqual({
      openTxHash: "0xabc",
      notice: "Transfer received: +1 ETH from @alice",
    })
    expect(AppNotificationStore.get().unreadCount()).toBe(0)
    expect(AppNotificationStore.get().get("transfer:receive:0xabc")?.dismissedAt).toBeTruthy()
  })

  it("spins on a live row and leaves it for its producer to retire", async () => {
    const store = AppNotificationStore.get()
    await store.upsert({
      id: "send:1",
      producer: "send",
      domain: "transaction",
      sourceId: "send:1",
      title: "Sending",
      description: "$25 to @alice · Proving privately",
      timestampMs: 1_700_000_000_000,
      systemIcon: "arrow.up.right",
      severity: "info",
      pending: true,
      target: { type: "transfer.pending" },
    })
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<NotificationsPanel onClose={() => {}} />} />
            <Route path="/activity" element={<Activity />} />
          </Routes>
        </MemoryRouter>,
      )
    })
    const row = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".ww-notifications__row"),
    ).find((r) => r.textContent?.includes("Proving privately"))!
    expect(row.querySelector(".zkm-spinner-icon")).toBeTruthy()

    await act(async () => row.click())
    expect(store.get("send:1")?.dismissedAt).toBeUndefined()
  })

  it("uses a dismissible native sheet on phones and the existing panel on desktop", async () => {
    layout.phone = true
    const close = vi.fn()
    await act(async () => root.render(<MemoryRouter><NotificationsPanel onClose={close} /></MemoryRouter>))
    const dialog = container.querySelector("dialog")!
    expect(dialog.open).toBe(true)
    expect(dialog.getAttribute("aria-label")).toBe("Notifications")
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close notifications"]')!.click())
    expect(close).toHaveBeenCalledOnce()
    close.mockClear()
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    expect(close).toHaveBeenCalledOnce()
    layout.phone = false
    await act(async () => root.render(<MemoryRouter><NotificationsPanel onClose={close} /></MemoryRouter>))
    expect(container.querySelector("dialog")).toBeNull()
    expect(container.querySelector('.ww-notifications[role="dialog"]')).not.toBeNull()
  })

})

describe("freshToasts", () => {
  const entry = (patch: Partial<AppNotificationEntry>): AppNotificationEntry =>
    ({
      id: "send:1",
      producer: "send",
      domain: "transaction",
      sourceId: "send:1",
      title: "Sending",
      description: "$25 to @alice",
      timestampMs: 1,
      systemIcon: "arrow.up.right",
      severity: "info",
      read: false,
      ...patch,
    } as AppNotificationEntry)

  it("never toasts a live row — the flow pops the panel itself once the user has signed", () => {
    expect(freshToasts([entry({ pending: true })], new Set())).toEqual([])
  })

  it("toasts the outcome of a row it watched in flight", () => {
    const seen = new Set([toastKey(entry({ pending: true }))])
    expect(freshToasts([entry({})], seen)).toHaveLength(1)
  })

  it("toasts a settled entry once, and never one already read", () => {
    const seen = new Set([toastKey(entry({}))])
    expect(freshToasts([entry({})], seen)).toEqual([])
    expect(freshToasts([entry({ read: true })], new Set())).toEqual([])
  })
})
