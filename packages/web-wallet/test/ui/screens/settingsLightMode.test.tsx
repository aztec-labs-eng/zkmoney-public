/** Settings' Light mode switch is a view over the page theme, the Store the shell's control writes. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { closeSession, type Session } from "../../../src/session/session"
import { SettingsScreen } from "../../../src/ui/screens/SettingsScreen"
import copy from "../../../src/ui/screens/SettingsScreen.copy"
import { openTestSession } from "../../support/session"

let host: HTMLDivElement
let root: Root
let session: Session

const lightMode = () =>
  [...host.querySelectorAll(".zkm-settings-row")]
    .find((row) => row.querySelector(".zkm-settings-row__label")?.textContent === copy.lightMode)
    ?.querySelector<HTMLButtonElement>('[role="switch"]')
const on = () => lightMode()?.getAttribute("aria-checked")

beforeEach(async () => {
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
})

describe("Light mode switch", () => {
  it("turns the page theme light and back to dark", () => {
    expect(on()).toBe("false")
    act(() => lightMode()!.click())
    expect(session.page.theme.current.get()).toBe("light")
    expect(on()).toBe("true")
    act(() => lightMode()!.click())
    expect(session.page.theme.current.get()).toBe("dark")
    expect(on()).toBe("false")
  })

  it("follows the theme set from elsewhere, such as the shell's control", () => {
    act(() => session.page.theme.set("light"))
    expect(on()).toBe("true")
    act(() => session.page.theme.set("dark"))
    expect(on()).toBe("false")
  })
})
