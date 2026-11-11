/** Guards: the unlock gate hides the wallet surface while the account record is unread. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Each test re-imports the front-core graph; the first one pays the cold transform.
vi.setConfig({ testTimeout: 30_000 })

let container: HTMLDivElement
let root: Root

async function render(): Promise<string> {
  const { UnlockGate } = await import("../../../src/features/identity/UnlockGate/UnlockGate")
  const { memoryStore } = await import("@obsidion/front-core")
  const { openTestSession } = await import("../../support/session")
  // A cold session before the account record loads: no wallet, no account, no error to retry from.
  const unread = memoryStore({ value: undefined, loaded: false }).readonly
  openTestSession({ accountRecord: { view: unread } })
  await act(async () => {
    root.render(
      <MemoryRouter>
        <UnlockGate>
          <span>wallet surface</span>
        </UnlockGate>
      </MemoryRouter>,
    )
  })
  return container.textContent ?? ""
}

beforeEach(async () => {
  vi.resetModules()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("UnlockGate", () => {
  it("holds the wallet surface behind the splash otherwise", async () => {
    window.history.replaceState({}, "", "/")
    const text = await render()
    expect(text).not.toContain("wallet surface")
    expect(text).toContain("Loading zk.money")
  })
})
