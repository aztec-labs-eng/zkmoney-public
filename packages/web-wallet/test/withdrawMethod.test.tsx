import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { Network } from "@obsidion/core/constants"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  network: "sandbox" as string,
  tuple: undefined as (() => Promise<object>) | undefined,
}))
/** Every contract a fresh-address quote or burn reads. */
const STACK = {
  swapEscrowFactoryV2: "0x11",
  operationExecutor: "0x12",
  accountFactory: "0x13",
  l2Broadcaster: "0x14",
  plainWithdrawalExecutor: "0x15",
}

vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: env.network }) }))
vi.mock("../src/config/oxideTuple", () => ({
  getOxideTuple: () => env.tuple?.() ?? new Promise(() => {}),
}))

const { WithdrawMethodScreen } = await import("../src/features/withdraw/WithdrawMethodScreen")

const Probe = () => <output data-location>{useLocation().pathname}</output>

describe("WithdrawMethodScreen", () => {
  let container: HTMLDivElement
  let root: Root

  const text = () => container.textContent ?? ""
  const options = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>(".ww-deposit__connect"))
  const titles = () => options().map((o) => o.querySelector("b")!.textContent)
  const location = () => container.querySelector("[data-location]")?.textContent
  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)!
  const click = (el: Element) => act(async () => (el as HTMLElement).click())
  const render = (path = "/withdraw") =>
    act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <Probe />
          <Routes>
            <Route path="/withdraw" element={<WithdrawMethodScreen />}>
              <Route path="existing" element={<p data-sheet />} />
            </Route>
            <Route path="*" element={null} />
          </Routes>
        </MemoryRouter>,
      )
    })

  beforeEach(() => {
    env.network = Network.SANDBOX
    env.tuple = () => Promise.resolve(STACK)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("offers both methods, fresh framed, with the how-to when the manifest names the stack", async () => {
    await render()
    expect(titles()).toEqual(["Withdraw to a fresh address", "Withdraw to an existing address"])
    expect(options().map((o) => o.classList.contains("ww-paymethod--best"))).toEqual([true, false])

    expect(text()).not.toContain("Open MetaMask")
    await click(button("Need a fresh address? See how to create one."))
    expect(text()).toContain("Open MetaMask and click the account name at the top.")
    await click(button("Rabby"))
    expect(text()).toContain("Open Rabby and click the address at the top.")
    expect(text()).not.toContain("Open MetaMask")
  })

  it.each([
    ["the manifest has no factory", Network.SANDBOX, () => Promise.resolve({})],
    [
      "the manifest has no executor to price the swaps against",
      Network.SANDBOX,
      () => Promise.resolve({ ...STACK, operationExecutor: undefined }),
    ],
    ["the tuple cannot be read", Network.SANDBOX, () => Promise.reject(new Error("down"))],
    ["the network has no swap stack and no manifest", Network.TESTNET, undefined],
  ])("offers the existing address alone when %s", async (_, network, tuple) => {
    env.network = network
    env.tuple = tuple
    await render()
    expect(titles()).toEqual(["Withdraw to an existing address"])
    expect(container.querySelector("[aria-expanded]")).toBeNull()
    await click(options()[0]!)
    expect(location()).toBe("/withdraw/existing")
  })

  it("keeps the cards under the sheet on /withdraw/existing", async () => {
    await render("/withdraw/existing")
    expect(titles()).toHaveLength(2)
    expect(container.querySelector("[data-sheet]")).not.toBeNull()
  })

  it("shows the frame with no options while the tuple is pending", async () => {
    env.tuple = undefined
    await render()
    expect(text()).toContain("Select withdrawal method")
    expect(options()).toHaveLength(0)
  })

  it.each([
    ["fresh address", "/withdraw/fresh"],
    ["existing address", "/withdraw/existing"],
  ])("opens the %s branch from its card", async (name, route) => {
    await render()
    await click(options().find((o) => o.textContent!.includes(name))!)
    expect(location()).toBe(route)
  })
})
