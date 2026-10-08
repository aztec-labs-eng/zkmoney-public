/**
 * The way to the endpoint editor before sign-in: Settings is behind sign-in, so the invitation frame
 * always offers the editor, except while the PXE boots or a screen's work would be cut short by the
 * reload a save makes.
 */
import { StrictMode, act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { endpointsHeld, useHoldEndpoints } from "../src/ui/endpointsHold"

const h = vi.hoisted(() => ({
  sources: { node: "default", l1Rpc: "default", enclave: "default" } as Record<string, string>,
  defaults: {} as Record<string, boolean>,
  bootStatus: "ready" as "booting" | "ready" | "error",
  bridge: null as unknown,
}))

vi.mock("../src/config/env", () => ({
  getConfig: () => ({
    endpoints: Object.fromEntries(
      Object.entries(h.sources).map(([kind, source]) => [
        kind,
        { source, isDefault: h.defaults[kind] ?? source === "default" },
      ]),
    ),
  }),
}))
vi.mock("../src/ui/EndpointsModal", async (original) => ({
  ...(await original<typeof import("../src/ui/EndpointsModal")>()),
  EndpointsModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="endpoints-modal">
      <button onClick={onClose}>close</button>
    </div>
  ),
}))
vi.mock("../src/ui/BrandLockup", () => ({ BrandLockup: () => null }))
vi.mock("../src/ui/PxeBoot", () => ({
  usePxeBoot: () => ({ bootStatus: h.bootStatus }),
}))
vi.mock("../src/platform/desktopBridge", () => ({ getDesktopL1Bridge: () => h.bridge }))

const { InvitationChrome } = await import("../src/features/onboarding/InvitationChrome")

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  h.sources = { node: "default", l1Rpc: "default", enclave: "default" }
  h.defaults = {}
  h.bootStatus = "ready"
  h.bridge = null
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function Holder({ active = true }: { active?: boolean }) {
  useHoldEndpoints(active)
  return null
}

const mount = (holders: boolean[] = [], topBar = true) =>
  act(async () =>
    root.render(
      <>
        {holders.map((active, i) => (
          <Holder key={i} active={active} />
        ))}
        <InvitationChrome topBar={topBar}>content</InvitationChrome>
      </>,
    ),
  )
const pill = () => container.querySelector<HTMLButtonElement>('[data-testid="invite-endpoints"]')
const modal = () => container.querySelector('[data-testid="endpoints-modal"]')

describe("InvitationChrome endpoints pill", () => {
  it("shows with every endpoint the default and opens the editor", async () => {
    await mount()
    expect(pill()!.textContent).toBe("ENDPOINTS")
    expect(pill()!.disabled).toBe(false)
    await act(async () => pill()!.click())
    expect(modal()).not.toBeNull()
  })

  it("names the saved endpoints and opens the editor", async () => {
    h.sources.l1Rpc = "settings"
    await mount()
    expect(pill()!.textContent).toBe("CUSTOM RPC")
    await act(async () => pill()!.click())
    expect(modal()).not.toBeNull()
  })

  it("reads ENDPOINTS for a saved value equal to the default", async () => {
    h.sources.node = "settings"
    h.defaults.node = true
    await mount()
    expect(pill()!.textContent).toBe("ENDPOINTS")
  })

  it("is disabled while the PXE boots, and enabled once the boot has failed", async () => {
    h.bootStatus = "booting"
    await mount()
    expect(pill()!.disabled).toBe(true)
    h.bootStatus = "error"
    await mount()
    expect(pill()!.disabled).toBe(false)
  })

  it("is disabled while a screen holds it, and not again once the holder is gone", async () => {
    await mount([true])
    expect(pill()!.disabled).toBe(true)
    await act(async () => pill()!.click())
    expect(modal()).toBeNull()
    await mount()
    expect(pill()!.disabled).toBe(false)
  })

  it("stays disabled until the last of two holders lets go", async () => {
    await mount([true, true])
    await mount([true, false])
    expect(pill()!.disabled).toBe(true)
    await mount([false, false])
    expect(pill()!.disabled).toBe(false)
  })

  it("shows under the desktop bridge too", async () => {
    h.bridge = { l1SubmitPath: "/desktop/l1-submit" }
    h.sources.node = "settings"
    await mount()
    expect(pill()!.textContent).toBe("CUSTOM NODE")
    await act(async () => pill()!.click())
    expect(modal()).not.toBeNull()
  })

  it("has no pill without a top bar", async () => {
    await mount([], false)
    expect(pill()).toBeNull()
  })
})

describe("the endpoints hold", () => {
  const render = (node: ReactNode) => act(async () => root.render(node))

  it("counts one hold under StrictMode's double effects, and none after unmount", async () => {
    await render(
      <StrictMode>
        <Holder />
      </StrictMode>,
    )
    expect(endpointsHeld()).toBe(true)
    await render(<StrictMode />)
    expect(endpointsHeld()).toBe(false)
  })

  it("keeps one hold across re-renders, and holds again after a release", async () => {
    await render(<Holder active />)
    await render(<Holder active />)
    expect(endpointsHeld()).toBe(true)
    await render(<Holder active={false} />)
    expect(endpointsHeld()).toBe(false)
    await render(<Holder active />)
    expect(endpointsHeld()).toBe(true)
    await render(null)
    expect(endpointsHeld()).toBe(false)
  })
})
