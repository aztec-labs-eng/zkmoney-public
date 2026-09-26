import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ scenario: "empty", setAssets: vi.fn() }))
vi.mock("@obsidion/front-core", () => ({
  useAssetContext: () => ({ assets: null, setAssets: state.setAssets }),
}))
vi.mock("../src/dev/demoFlag", () => ({ demoScenario: () => state.scenario }))
vi.mock("../src/dev/demoFixtures", () => ({ DEMO_L2_TOKEN: "0x01" }))
import DemoEmptyBalance from "../src/dev/DemoEmptyBalance"

afterEach(() => state.setAssets.mockClear())

describe("offline zero balance", () => {
  it.each(["empty", "fresh"])("handles unhydrated assets for %s", (scenario) => {
    state.scenario = scenario
    const host = document.createElement("div")
    const root = createRoot(host)
    act(() => root.render(<DemoEmptyBalance />))
    if (scenario === "empty") {
      expect(state.setAssets).toHaveBeenCalledWith([
        expect.objectContaining({ balance: 0, balanceAtomic: 0n, address: "0x01" }),
      ])
    } else {
      expect(state.setAssets).not.toHaveBeenCalled()
    }
    act(() => root.unmount())
  })
})
