/**
 * Guards the desktop settings page decides: an invalid or wrong-shape endpoint stops the save, and
 * leaving asks first while a save runs.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Network } from "@obsidion/core/constants"
import type { DesktopSettingsState } from "../../src/desktopSettings/state"

vi.hoisted(() => {
  process.env.TZ = "America/Los_Angeles"
})

vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
    isLoading,
  }: {
    title: string
    onClick: () => void
    isDisabled?: boolean
    isLoading?: boolean
  }) => (
    <button disabled={isDisabled || isLoading} onClick={onClick}>
      {title}
    </button>
  ),
}))

const { DesktopSettingsScreen } = await import("../../src/desktopSettings/DesktopSettingsScreen")

const RECORD = "webwallet.endpoints"
const SHAPED = "https://cdn.example/profiles/v5/current.json"
const BAKED = {
  current: "0.5.1",
  publishedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-10-01T00:00:00.000Z",
}

type Reply = { status: number; body?: object } | "no-answer"
let replies: Record<string, Reply[]>
let calls: { path: string; body: Record<string, unknown> }[]
let root: Root
let container: HTMLDivElement

function state(overrides: Partial<DesktopSettingsState> = {}): DesktopSettingsState {
  return {
    token: "tok",
    values: {},
    sources: {},
    problems: [],
    builtAt: "2026-09-01T00:00:00.000Z",
    profile: { url: SHAPED, overridden: false, baked: BAKED },
    profileProbe: { state: "ok", overridden: false },
    ...overrides,
  }
}

async function mount(s: DesktopSettingsState | null = state(), network = Network.TESTNET) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<DesktopSettingsScreen state={s} network={network} />))
}

const input = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!
const profileUrl = () => input("config-profile-url")
const shippedSwitch = () =>
  container.querySelector<HTMLInputElement>('.ww-dsettings__switch input[type="checkbox"]')!
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((el) => el.textContent === label)
const saveButton = () => button("Save & relaunch wallet")!
const text = () => container.textContent ?? ""
const stored = () => JSON.parse(localStorage.getItem(RECORD) ?? "null")

function fill(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
function toggle(el: HTMLInputElement) {
  act(() => el.click())
}
const save = () => act(async () => saveButton().click())

beforeEach(() => {
  localStorage.clear()
  calls = []
  replies = {}
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init.body)) })
      const reply = replies[path]?.shift() ?? {
        status: 200,
        body: { ok: true, status: "accepted" },
      }
      if (reply === "no-answer") throw new TypeError("Failed to fetch")
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status })
    }),
  )
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("saving", () => {
  it("an invalid endpoint stops everything", async () => {
    await mount()
    fill(input("endpoint-enclave"), "https://e.example/rpc")
    expect(saveButton().disabled).toBe(true)
    await save()
    expect(calls).toEqual([])
    expect(stored()).toBeNull()
  })

  it("a URL of the wrong shape on a testnet build stops everything", async () => {
    await mount()
    fill(profileUrl(), "https://elsewhere.example/profile.json")
    expect(text()).toContain("Enter a profile address of the form")
    expect(saveButton().disabled).toBe(true)
    await save()
    expect(calls).toEqual([])
  })

  it("a URL without the slashes after its scheme stops everything, switch or not", async () => {
    await mount()
    fill(profileUrl(), "https:cdn.example/profiles/v5/current.json")
    expect(text()).toContain("Enter a full http(s) URL.")
    expect(saveButton().disabled).toBe(true)
    toggle(shippedSwitch())
    expect(saveButton().disabled).toBe(true)
  })

  it("asks before leaving while a save is under way", async () => {
    let answer!: () => void
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        }),
    )
    await mount()
    fill(profileUrl(), SHAPED)
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(leave()).toBe(false)
    await act(async () => saveButton().click())
    expect(leave()).toBe(true)
    await act(async () => answer())
    expect(leave()).toBe(false)
  })
})
