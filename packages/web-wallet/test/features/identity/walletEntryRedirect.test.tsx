/** Guards: the wallet entry holds the signed-in page while a sign-out leaves it. */
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, expect, it, vi } from "vitest"

vi.mock("../../../src/ui/PxeBoot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/PxeBoot")>()),
  usePxeBoot: () => ({ bootStatus: "booting" }),
}))

const { WalletEntryGate } = await import("../../../src/App")
const { openTestSession } = await import("../../support/session")

const reactEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
const added: HTMLElement[] = []

afterEach(() => {
  reactEnv.IS_REACT_ACT_ENVIRONMENT = true
  for (const el of added.splice(0)) el.remove()
})

function element(id?: string): HTMLDivElement {
  const el = document.createElement("div")
  if (id) el.id = id
  document.body.append(el)
  added.push(el)
  return el
}

it("holds the signed-in page while a sign-out leaves it", async () => {
  const open = openTestSession()
  open.leaving.set(true)
  const app = element()
  reactEnv.IS_REACT_ACT_ENVIRONMENT = false
  const root = createRoot(app)
  root.render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<WalletEntryGate />}>
          <Route index element={<i data-testid="home" />} />
        </Route>
        <Route path="claim" element={<i data-testid="claim" />} />
      </Routes>
    </MemoryRouter>,
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(app.querySelector('[data-testid="home"]')).not.toBeNull()
  expect(app.querySelector('[data-testid="claim"]')).toBeNull()
  root.unmount()
})
