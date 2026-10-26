import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

const portals = vi.hoisted(() => ({
  main: { refundable: 30n, links: 5n, waiting: 10n },
  savings: { refundable: 9n, links: 0n, waiting: 0n } as object | undefined | Error,
}))

// Each runtime holds what its portal had when the scan started.
vi.mock("../src/features/withdraw/frozenExit", () => ({
  frozenExitRuntime: async () => ({ held: portals.main }),
  frozenSavingsRuntime: async () => {
    if (portals.savings instanceof Error) throw portals.savings
    return portals.savings && { held: portals.savings }
  },
  recordSentFrozenRefunds: async () => {},
  openLinksHeld: async () => 10n,
}))
const hookChain = vi.hoisted(() => ({ wallet: {}, account: { getAddress: () => "0xhook" } }))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAztecContext: () => ({ obsidionWallet: hookChain.wallet }),
  useAccountContext: () => ({ obsidionAccount: hookChain.account }),
}))
vi.mock("../src/features/withdraw/portalFrozen", () => ({ usePortalFrozen: () => true }))
vi.mock("../src/features/withdraw/frozenExitRun", () => ({
  frozenExitSummary: async (runtime: { held: object }) => runtime.held,
}))

const { lastFrozenScan, scanFrozenFunds, useFrozenFunds } = await import(
  "../src/features/withdraw/frozenFunds"
)

let n = 0
const chain = () => ({ wallet: {}, account: { getAddress: () => `0x${++n}` } } as never)

describe("the frozen-portal funds scan", () => {
  beforeEach(() => {
    portals.main = { refundable: 30n, links: 5n, waiting: 10n }
    portals.savings = { refundable: 9n, links: 0n, waiting: 0n }
  })

  it("reads Main and Savings", async () => {
    await scanFrozenFunds(chain())
    expect(lastFrozenScan()).toMatchObject({
      failed: false,
      funds: { main: portals.main, savings: portals.savings, openLinks: 10n },
    })
  })

  it("leaves Savings out while its portal is live", async () => {
    portals.savings = undefined
    await scanFrozenFunds(chain())
    expect(lastFrozenScan().funds).toEqual({ main: portals.main, openLinks: 10n })
  })

  it("keeps Main when the Savings read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    portals.savings = new Error("Savings enclave down")
    await scanFrozenFunds(chain())
    expect(lastFrozenScan().funds).toEqual({
      main: portals.main,
      openLinks: 10n,
      savingsFailed: true,
    })
    warn.mockRestore()
  })

  it("queues a fresh scan behind a running one, so a sent batch shows", async () => {
    const c = chain()
    const first = scanFrozenFunds(c)
    portals.main = { refundable: 0n, links: 0n, waiting: 10n }
    await Promise.all([first, scanFrozenFunds(c, true)])
    expect(lastFrozenScan().funds?.main).toEqual({ refundable: 0n, links: 0n, waiting: 10n })
  })

  it("rescans a finished scan when Withdraw opens, so a deposit that became refundable shows", async () => {
    await scanFrozenFunds(hookChain as never)
    portals.main = { refundable: 40n, links: 0n, waiting: 0n }
    const Withdraw = () => (useFrozenFunds({ rescanOnMount: true }), null)
    const root = createRoot(document.createElement("div"))
    await act(async () => root.render(createElement(Withdraw)))
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(lastFrozenScan().funds?.main).toEqual({ refundable: 40n, links: 0n, waiting: 0n })
    act(() => root.unmount())
  })
})
