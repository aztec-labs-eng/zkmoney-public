/** Guards: the endpoints pill waits out a PXE boot and every hold, and a hold ends on unmount. */
import { StrictMode, act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { endpointsHeld, useHoldEndpoints } from "../../../src/session/endpointsHold"

const h = vi.hoisted(() => ({ bootStatus: "ready" as "booting" | "ready" | "error" }))

vi.mock("../../../src/config/env", () => ({
  getConfig: () => ({
    endpoints: Object.fromEntries(
      ["node", "l1Rpc", "enclave"].map((kind) => [kind, { source: "default", isDefault: true }]),
    ),
  }),
}))
vi.mock("../../../src/ui/BrandLockup", () => ({ BrandLockup: () => null }))
vi.mock("../../../src/ui/PxeBoot", () => ({
  usePxeBoot: () => ({ bootStatus: h.bootStatus }),
}))

const { InvitationChrome } = await import("../../../src/features/onboarding/InvitationChrome")
const config = () =>
  ({
    endpoints: Object.fromEntries(
      ["node", "l1Rpc", "enclave"].map((kind) => [kind, { source: "default", isDefault: true }]),
    ),
  } as never)

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  h.bootStatus = "ready"
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

const mount = (holders: boolean[] = []) =>
  act(async () =>
    root.render(
      <>
        {holders.map((active, i) => (
          <Holder key={i} active={active} />
        ))}
        <InvitationChrome page={{ config: config() } as never}>content</InvitationChrome>
      </>,
    ),
  )
const pill = () => container.querySelector<HTMLButtonElement>('[data-testid="invite-endpoints"]')

describe("InvitationChrome endpoints pill", () => {
  it("is disabled while the PXE boots, and enabled once the boot has failed", async () => {
    h.bootStatus = "booting"
    await mount()
    expect(pill()!.disabled).toBe(true)
    h.bootStatus = "error"
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
})
