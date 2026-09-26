/**
 * The ticket offer read behind the visitor's "Receive to zk.money". A failed `/domain/info` is not
 * a confirmed absence: the hook says so and retries on demand, so the page never starts the paid
 * signup on a network blip.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fetchMock = vi.fn()
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ accountServiceUrl: "http://account.test" }),
}))

const { useGoldenTicketOffer } = await import("../src/features/paylink/goldenTicketOffer")

const OFFER = { threshold: "3", schedule: { fee: "1", minDeposit: "0" } }
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
let retry: () => void
function Probe() {
  const read = useGoldenTicketOffer()
  retry = read.retry
  return (
    <span data-testid="read">
      {read.failed
        ? "failed"
        : read.offer === undefined
        ? "loading"
        : read.offer === null
        ? "none"
        : `offer:${read.offer.threshold}`}
    </span>
  )
}

let container: HTMLDivElement
let root: Root
const state = () => container.querySelector('[data-testid="read"]')?.textContent
const mount = () => act(async () => root.render(<Probe />))

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe("useGoldenTicketOffer", () => {
  it("reads the public offer before the visitor has any credentials", async () => {
    fetchMock.mockResolvedValueOnce(response({ goldenTicket: OFFER }))
    await mount()
    expect(state()).toBe("offer:3")
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith("http://account.test/domain/info", {
      method: "GET",
      signal: expect.any(AbortSignal),
    })
  })

  it.each([
    ["no tickets", { goldenTicket: null }],
    ["a schedule-less server", { goldenTicket: { threshold: "3" } }],
  ])("reads %s as a confirmed absence", async (_label, info) => {
    fetchMock.mockResolvedValueOnce(response(info))
    await mount()
    expect(state()).toBe("none")
  })

  it("keeps a failed read apart from an absent offer, and reads again on retry", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "account service unavailable" }, 503))
    await mount()
    expect(state()).toBe("failed")

    fetchMock.mockResolvedValueOnce(response({ goldenTicket: OFFER }))
    await act(async () => retry())
    expect(state()).toBe("offer:3")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("shows the read in flight again while a retry runs", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "account service unavailable" }, 503))
    await mount()
    expect(state()).toBe("failed")
    let settle!: (v: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (settle = r)))
    act(() => retry())
    expect(state()).toBe("loading")
    await act(async () => settle(response({ goldenTicket: null })))
    expect(state()).toBe("none")
  })
})
