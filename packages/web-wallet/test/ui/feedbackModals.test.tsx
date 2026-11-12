/** The bug report and feedback forms offer Settings' usage data switch while sharing is off. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Before the feedback endpoint is read.
vi.hoisted(() => vi.stubEnv("VITE_ZKMONEY_API_URL", "https://api.zk.test"))

import { saveSetting } from "../../src/platform/storage/deviceKeys"
import { closeSession, type Session } from "../../src/session/session"
import { SettingsScreen } from "../../src/ui/screens/SettingsScreen"
import usageDataCopy from "../../src/ui/usageData.copy"
import { openTestSession } from "../support/session"

let host: HTMLDivElement
let root: Root
let session: Session
let bodies: string[]

const FORMS = [
  { form: "bug", banner: 0 },
  { form: "feedback", banner: 1 },
] as const

const usageSwitch = (scope: ParentNode | null) =>
  [...(scope?.querySelectorAll(".zkm-settings-row") ?? [])]
    .find(
      (row) => row.querySelector(".zkm-settings-row__label")?.textContent === usageDataCopy.label,
    )
    ?.querySelector<HTMLButtonElement>('[role="switch"]')
const form = () => document.querySelector(".ww-feedback")
const formSwitch = () => usageSwitch(form())
const settingsSwitch = () => usageSwitch(host.querySelector(".ww-panel__scroll"))
const consent = () => session.device.get().analyticsConsent

const open = (banner: number) =>
  act(() => host.querySelectorAll<HTMLButtonElement>(".ww-settings__banner")[banner]!.click())
const close = () =>
  act(() => form()!.querySelector<HTMLButtonElement>(".ww-modal__close button")!.click())
/** Clicks a usage data switch and waits for the setting it saves. */
const flip = (control: HTMLButtonElement | null | undefined, to: boolean) =>
  act(async () => {
    control!.click()
    await vi.waitFor(() => expect(consent()).toBe(to))
  })
const submit = async (text: string) => {
  const box = form()!.querySelector("textarea")!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text)
    box.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => {
    form()!.querySelector<HTMLButtonElement>(".zkm-primary-btn")!.click()
    // The stubbed request answers at once; one macrotask lets the form take the answer.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(form()!.querySelector('[role="status"]')).not.toBeNull()
}

beforeEach(async () => {
  bodies = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body)
      return new Response(null, { status: 201 })
    }),
  )
  host = document.body.appendChild(document.createElement("div"))
  root = createRoot(host)
  session = openTestSession()
  await session.registrations.ready
  await act(async () =>
    root.render(
      <MemoryRouter>
        <SettingsScreen />
      </MemoryRouter>,
    ),
  )
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  closeSession()
  vi.unstubAllGlobals()
})

describe.each(FORMS)("the $form form's usage data switch", ({ banner }) => {
  it("shows while sharing is off, and not once it is on", async () => {
    expect(consent()).toBe(false)
    open(banner)
    expect(formSwitch()?.getAttribute("aria-checked")).toBe("false")
    close()
    await act(() => saveSetting(session.database, "analyticsConsent", true))
    open(banner)
    expect(form()).not.toBeNull()
    expect(formSwitch()).toBeUndefined()
  })

  it("saves the setting Settings shows, both ways, and stays until the form closes", async () => {
    open(banner)
    await flip(formSwitch(), true)
    expect(formSwitch()?.getAttribute("aria-checked")).toBe("true")
    expect(settingsSwitch()?.getAttribute("aria-checked")).toBe("true")
    await flip(settingsSwitch(), false)
    expect(formSwitch()?.getAttribute("aria-checked")).toBe("false")
    await flip(formSwitch(), true)
    close()
    open(banner)
    expect(formSwitch()).toBeUndefined()
  })

  it("sends the same report whichever way the switch is", async () => {
    open(banner)
    await submit("crashed")
    close()
    open(banner)
    await flip(formSwitch(), true)
    await submit("crashed")
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
  })
})
