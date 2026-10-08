import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import { Network } from "@obsidion/core/constants"
import { getOxideTuple } from "../src/config/oxideTuple"
import { useFreshAddressAvailable } from "../src/features/withdraw/freshAddressAvailability"

vi.hoisted(() => vi.stubEnv("VITE_FRESH_ADDRESS_SHOWCASE", "true"))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: Network.TESTNET }) }))
vi.mock("../src/config/oxideTuple", () => ({ getOxideTuple: vi.fn() }))

describe("useFreshAddressAvailable", () => {
  it("opens under the showcase flag without reading the manifest", async () => {
    const host = document.createElement("div")
    const Probe = () => createElement("span", null, String(useFreshAddressAvailable()))
    await act(async () => createRoot(host).render(createElement(Probe)))
    expect(host.textContent).toBe("true")
    expect(getOxideTuple).not.toHaveBeenCalled()
  })
})
