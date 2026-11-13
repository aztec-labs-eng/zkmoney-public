import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import { Network } from "@obsidion/core/constants"
import { useFreshAddressAvailable } from "../../../../src/features/withdraw/freshAddressAvailability"
import { openTestSession } from "../../../support/session"

vi.hoisted(() => vi.stubEnv("VITE_FRESH_ADDRESS_SHOWCASE", "true"))

describe.each([["useFreshAddressAvailable", useFreshAddressAvailable]])("%s", (_, hook) => {
  it("opens under the showcase flag without reading the manifest", async () => {
    const { chain } = openTestSession({
      config: { network: Network.TESTNET, features: {} } as never,
    }).page
    const host = document.createElement("div")
    const Probe = () => createElement("span", null, String(hook()))
    await act(async () => createRoot(host).render(createElement(Probe)))
    expect(host.textContent).toBe("true")
    expect(chain.oxideTuple.get()).toEqual({ status: "pending" })
  })
})
