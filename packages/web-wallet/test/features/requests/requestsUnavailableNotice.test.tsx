// Guard: a failed contacts read shows unavailable, not empty.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { memoryStore } from "@obsidion/front-core"
import { NonContactRequestsScreen } from "../../../src/features/requests/NonContactRequestsScreen"
import { closeSession } from "../../../src/session/session"
import { openTestSession } from "../../support/session"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  closeSession()
})

const tryAgain = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="requests-unavailable"] button') ??
  undefined

describe("RequestsUnavailableNotice", () => {
  it("shows on a failed contact book with a Try again", async () => {
    const view = memoryStore({ records: [], loaded: false, failed: true }).readonly
    await openTestSession({ contacts: { view } }).registrations.ready
    await act(async () =>
      root.render(
        <MemoryRouter>
          <NonContactRequestsScreen />
        </MemoryRouter>,
      ),
    )
    expect(container.querySelector('[data-testid="requests-unavailable"]')).not.toBeNull()
    expect(tryAgain()).toBeDefined()
  })
})
