/**
 * The ETH route pays its recipient with a plain call, and route/recipient/tip are immutable clone
 * args in the escrow's CREATE2 address — so a recipient that rejects ETH strands the DAI at the
 * escrow with no re-route. The probe warns; it must never block, because a delegated EOA has code
 * and accepts ETH fine.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const getCode = vi.fn()
vi.mock("../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../src/config/oxideTuple", () => ({ l1PublicClient: () => ({ getCode }) }))

const { useEthRecipientHasCode } = await import("../src/features/withdraw/ethRecipientCheck")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const EOA = `0x${"dd".repeat(20)}`

describe("useEthRecipientHasCode", () => {
  let container: HTMLDivElement
  let root: Root
  let seen: boolean | undefined

  const Probe = ({ recipient, enabled }: { recipient: string; enabled: boolean }) => {
    seen = useEthRecipientHasCode(recipient, enabled)
    return null
  }

  const render = async (recipient: string, enabled: boolean) => {
    await act(async () => {
      root.render(<Probe recipient={recipient} enabled={enabled} />)
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    seen = undefined
    getCode.mockReset()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("flags a recipient carrying code", async () => {
    getCode.mockResolvedValue("0x60006000")
    await render(EOA, true)
    expect(seen).toBe(true)
  })

  it("stays quiet for a plain EOA", async () => {
    getCode.mockResolvedValue("0x")
    await render(EOA, true)
    expect(seen).toBe(false)
  })

  it("never probes when the route is not ETH", async () => {
    await render(EOA, false)
    expect(getCode).not.toHaveBeenCalled()
    expect(seen).toBe(false)
  })

  it("stays quiet when the RPC will not answer, rather than blocking the flow", async () => {
    getCode.mockRejectedValue(new Error("rpc down"))
    await render(EOA, true)
    expect(seen).toBe(false)
  })

  it("does not probe a half-typed address", async () => {
    await render("0x1234", true)
    expect(getCode).not.toHaveBeenCalled()
  })
})
