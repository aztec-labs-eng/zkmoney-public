// Guard (privacy): a link leaves off the tag its creator turned off.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { memoryStore } from "@obsidion/front-core"
import { setIdentity } from "../../support/identity"
import { balancesOf } from "../../support/balances"
import { asOperation } from "../../support/handOff"

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  parseEscrowAmount: (s: string, d: number) => ({
    atomic: BigInt(Math.round(Number(s))) * 10n ** BigInt(d),
    human: Number(s),
  }),
}))
const allowanceGate = vi.hoisted(() => ({ reason: undefined as string | undefined }))
vi.mock("../../../src/features/allowance/SponsoredActionNotice", () => ({
  useSponsoredActionBlock: (enabled: boolean) => (enabled ? allowanceGate.reason : undefined),
  SponsoredActionNotice: ({ reason }: { reason?: string }) =>
    reason ? <p data-testid="sponsored-action-blocked">{reason}</p> : null,
}))
vi.mock("../../../src/features/contacts/SendScreen/SendScreen", () => ({ SendScreen: () => null }))
vi.mock("../../../src/ui/PayModalChrome", () => ({
  PayModalChrome: ({ onBack }: { onBack?: () => void }) =>
    onBack ? <button onClick={onBack}>Back</button> : null,
}))
const deps = {}
vi.mock("../../../src/features/paylink/usePaylinkDeps", () => ({ usePaylinkDeps: () => deps }))
vi.mock("../../../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: () => "x" }))

type Stage = (s: string) => void
type Opts = {
  onLink?: (l: unknown) => void
  voucher?: boolean
  email?: string
  senderTag?: string
}
const link = {
  url: "https://wallet/link#frag",
  fragment: "frag",
  amount: "25",
  status: "unclaimed",
}
const createSponsoredLink = vi.fn(
  async (_deps: unknown, _amount: string, _onStage: Stage, _opts: Opts) => ({
    ...link,
    txHash: "0xcreate",
  }),
)
const voucherAvailable = vi.fn(async () => true)
vi.mock("../../../src/features/paylink/sponsoredPaylink", () => ({
  voucherAvailable: () => voucherAvailable(),
  DEFAULT_CLAIM_WINDOW_DAYS: 30,
  hasPendingDeposits: () => false,
  // Wrapped at the call: the wrapper's module loads the session, which imports this one.
  createSponsoredLink: (...a: Parameters<typeof createSponsoredLink>) =>
    asOperation(createSponsoredLink, "paylink-create")(...a),
}))

const ticket = vi.hoisted(() => ({
  offer: null as { threshold: string; schedule: { fee: string; minDeposit: string } } | null,
}))
vi.mock("../../../src/features/paylink/goldenTicketOffer", () => ({
  useGoldenTicketOffer: () => ({ offer: ticket.offer, failed: false, retry: () => {} }),
}))

const { NewLinkScreen } = await import("../../../src/features/paylink/NewLinkScreen/NewLinkScreen")
const { openTestSession } = await import("../../support/session")

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("NewLinkScreen", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    voucherAvailable.mockResolvedValue(true)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    openTestSession({
      mainToken: memoryStore({ address: "0xd4", name: "DAI", symbol: "DAI", decimals: 18 }).readonly,
      balances: balancesOf({ main: 100n * 10n ** 18n, readThisSession: true, known: true }),
    })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    createSponsoredLink.mockImplementation(
      async (_d: unknown, _a: string, _s: Stage, opts: Opts) => {
        opts.onLink?.(link)
        return { ...link, txHash: "0xcreate" }
      },
    )
    await mount()
  })

  afterEach(async () => {
    allowanceGate.reason = undefined
    await setIdentity({ address: "0xabc" })
    ticket.offer = null
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  const mount = () =>
    act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/create"]}>
          <Routes>
            <Route path="/create" element={<NewLinkScreen />} />
            <Route path="/activity" element={<div>Activity</div>} />
          </Routes>
        </MemoryRouter>,
      )
    })
  /** The ticket offer is read on mount, so a test that sets one opens the screen afresh. */
  const remount = async () => {
    act(() => root.unmount())
    root = createRoot(container)
    await mount()
  }
  const button = (title: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === title)
  const setInput = (value: string) => {
    const input = container.querySelector("input")!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }

  describe("the creator's tag on the link", () => {
    const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]')
    const sentTag = () => createSponsoredLink.mock.lastCall?.[3].senderTag

    it("leaves the tag off a link the creator turns it off for", async () => {
      await setIdentity({ address: "0xabc", handle: "river" })
      await remount()
      await act(async () => setInput("25"))
      await act(async () => button("Next")?.click())
      await act(async () => toggle()?.click())
      expect(toggle()?.getAttribute("aria-checked")).toBe("false")
      await act(async () => button("Confirm")?.click())
      await act(async () => button("Create paylink")?.click())
      expect(createSponsoredLink).toHaveBeenCalledOnce()
      expect(sentTag()).toBeUndefined()
    })
  })
})
