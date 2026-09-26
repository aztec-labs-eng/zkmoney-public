import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { EthAddress } from "@aztec/foundation/eth-address"
import { TeeSignerNotApprovedError } from "@obsidion/sdk"

const m = vi.hoisted(() => ({ asset: { teeSignerError: null as Error | null } }))
vi.mock("@obsidion/front-core", () => ({ useAssetContext: () => m.asset }))
vi.mock("@obsidion/web-ds", () => ({ Icon: () => null }))

import { TeeSignerNotice } from "../src/ui/TeeSignerNotice"

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
})

const render = () => act(async () => root.render(<TeeSignerNotice />))

describe("TeeSignerNotice", () => {
  it("says payments are unavailable while the pinned enclave is not approved", async () => {
    m.asset.teeSignerError = new TeeSignerNotApprovedError(
      AztecAddress.fromStringUnsafe("0x" + "11".repeat(31) + "01"),
      EthAddress.fromString("0x" + "ab".repeat(20)),
      "0x01",
    )
    await render()

    const status = container.querySelector('[role="status"]')
    expect(status?.textContent).toContain("Payments are unavailable")
    expect(status?.textContent).toContain("not approved yet")
    expect(status?.textContent).toContain("retrying")
  })

  it("renders nothing without a refusal", async () => {
    m.asset.teeSignerError = null
    await render()
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it("renders nothing for a connect failure that is not a refusal", async () => {
    m.asset.teeSignerError = new Error("enclave hiccup")
    await render()
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})
