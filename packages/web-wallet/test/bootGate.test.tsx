import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WebBootConfig } from "../src/config/env"
import { discardIncompatiblePasskeyState } from "../src/platform/auth/discardIncompatiblePasskeyState"
import { WebPasskeyIdentityMap } from "../src/platform/auth/WebPasskeyIdentityMap"
import { UNSUPPORTED_BROWSER_MESSAGE } from "@obsidion/passkey-web"

const h = vi.hoisted(() => ({ app: vi.fn() }))
vi.mock("../src/App", () => ({
  App: (props: unknown) => {
    h.app(props)
    return <div>Wallet ready</div>
  },
}))
vi.mock("../src/ui/PxeBoot", () => ({ BootSplash: () => <div>Loading wallet</div> }))
const { BootGate } = await import("../src/BootGate")

const boot = { config: { rpId: "auth.zk.money" } } as WebBootConfig
const locks = Object.getOwnPropertyDescriptor(navigator, "locks")!
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  h.app.mockClear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  Object.defineProperty(navigator, "locks", locks)
  vi.restoreAllMocks()
})

const resolveBoot = () =>
  vi.fn(async () => {
    await discardIncompatiblePasskeyState(boot.config.rpId)
    return boot
  })
const render = (resolve: ReturnType<typeof resolveBoot>) =>
  act(async () => {
    root.render(
      <React.StrictMode>
        <BootGate resolveBoot={resolve} />
      </React.StrictMode>,
    )
  })

describe("boot after session cleanup", () => {
  it("shows browser compatibility guidance without mounting account consumers when Web Locks are missing", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined })
    const resolve = resolveBoot()
    await render(resolve)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      UNSUPPORTED_BROWSER_MESSAGE,
    )
    expect(container.textContent).not.toContain("could not load its configuration")
    expect(container.querySelector("button")).toBeNull()
    expect(h.app).not.toHaveBeenCalled()
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it("waits for cleanup to finish and shares one attempt across StrictMode effects", async () => {
    let finish!: () => void
    const cleanup = vi
      .spyOn(WebPasskeyIdentityMap.prototype, "discardOtherRps")
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
    const resolve = resolveBoot()
    await render(resolve)
    expect(container.textContent).toContain("Loading wallet")
    expect(h.app).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(container.textContent).toContain("Wallet ready")
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it("keeps cleanup failures fatal and retries cleanup before mounting the wallet", async () => {
    const cleanup = vi
      .spyOn(WebPasskeyIdentityMap.prototype, "discardOtherRps")
      .mockRejectedValueOnce(new Error("Cannot clear incompatible state"))
      .mockResolvedValueOnce()
    const resolve = resolveBoot()
    await render(resolve)
    expect(container.textContent).toContain("Cannot clear incompatible state")
    expect(h.app).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click())
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("Wallet ready")
  })
})
