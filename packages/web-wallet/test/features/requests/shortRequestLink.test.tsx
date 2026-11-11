/** The hook's no-double-send guard: one announce per request, across remounts and racing taps. */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")
const h = vi.hoisted(() => ({
  sendTx: vi.fn(),
  enabled: true,
  announced: [] as string[],
}))
const wallet = { sendTx: h.sendTx }
const account = { getAddress: () => "0xuser" }

vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  buildClaimSponsorPayload: async () => ({}),
  claimFpcSponsoredFee: () => ({}),
  shortLinksEnabled: async () => h.enabled,
  linkAnnounceInteraction: async (
    _wallet: unknown,
    _contractService: unknown,
    _kind: number,
    key: { seed: Uint8Array },
  ) => {
    h.announced.push(hex(key.seed))
    return { request: async () => ({ calls: [] }) }
  },
}))
vi.mock("../../../src/features/registration/claimSponsorship", () => ({
  claimSponsorContext: async () => ({ fpcAddress: "0xfpc", railId: 1, policy: {} }),
  noteSubscribed: () => {},
}))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: () => {} }))
vi.mock("../../../src/features/requests/requestLinkCreation", () => ({
  requestLinkOrigin: () => "https://wallet.zk.money",
}))

const { decodeLinkFragment } = await import("@obsidion/sdk")
const { useShortRequestLink } = await import("../../../src/features/requests/shortRequestLink")
const { closeSession } = await import("../../../src/session/session")
const { openTestSession } = await import("../../support/session")

let CODE = {
  requestId: "0x0a1b",
  url: "https://wallet.zk.money/pay/someone#oWFhAQ",
  amount: 0,
  expiresAt: 0,
}
let requests = 0

/** The seed a short URL carries, as the announce sees it. */
function seedOf(url: string): string {
  return hex(decodeLinkFragment(url.slice(url.indexOf("#") + 1))!.seed)
}

/** Every mounted probe: each unmounts before its session closes. */
const roots: ReturnType<typeof createRoot>[] = []

async function mount() {
  let seen: ReturnType<typeof useShortRequestLink> | undefined
  const Probe = () => {
    seen = useShortRequestLink(CODE)
    return null
  }
  const root = createRoot(document.createElement("div"))
  roots.push(root)
  await act(async () => root.render(<Probe />))
  const hook = () => seen!
  hook.unmount = () => act(async () => root.unmount())
  return hook
}

describe("useShortRequestLink", () => {
  beforeEach(() => {
    // Links are kept per request for the session, so each case shares a request of its own.
    CODE = { ...CODE, requestId: `0x0a1b${++requests}` }
    h.announced.length = 0
    h.sendTx.mockReset()
    h.enabled = true
    openTestSession({ wallet, account, contractService: {} })
  })
  afterEach(async () => {
    await act(async () => roots.splice(0).forEach((root) => root.unmount()))
    closeSession()
  })

  it("publishes the link it shares, once", async () => {
    h.sendTx.mockResolvedValue({})
    const hook = await mount()
    const url = hook().url!
    expect(url).toMatch(/^https:\/\/wallet\.zk\.money\/request#/)
    await act(async () => hook().publish())
    await act(async () => hook().publish())
    expect(h.announced).toEqual([seedOf(url)])
  })

  it("a tap on a remounted or second sheet joins the publish in flight", async () => {
    let land!: () => void
    h.sendTx.mockReturnValue(new Promise((resolve) => (land = () => resolve({}))))
    const first = await mount()
    const url = first().url!
    await act(async () => first().publish())
    await first.unmount()
    const again = await mount()
    const beside = await mount()
    expect(again().url).toBe(url)
    expect(again().status).toBe("publishing")
    await act(async () => again().publish())
    await act(async () => beside().publish())
    await act(async () => land())
    expect(h.announced).toEqual([seedOf(url)])
    expect(h.sendTx).toHaveBeenCalledTimes(1)
    expect(again().status).toBe("ready")
    expect(beside().status).toBe("ready")
  })
})
