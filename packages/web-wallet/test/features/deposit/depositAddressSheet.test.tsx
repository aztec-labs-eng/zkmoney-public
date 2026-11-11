/** Guards: an over-limit or uncapacitated deposit waits; failed reads show; closed sheets stop. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import type { Hex } from "viem"
import { fmt } from "../../../src/lib/fmt"
import { LIMIT, LIMIT_USD, grouped } from "../../support/publicLimit"
import { testScreenings } from "../../support/page"

const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const ADDRESS = "0x7b3E9c41aD02f8B5c6E1d7a9F04c3B8e2A61d9F0"
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"

const aztec = { obsidionWallet: { networkId: "0xnet" } }
// The open's pool read hits: the coin row shows the address with no derivation.
const depositAddress = vi.fn(async () => ({ address: ADDRESS, name: "alice.oxide.eth" }))
const gateway = { depositAddress }

const navigate = vi.hoisted(() => vi.fn())
const fireEvent = vi.hoisted(() => vi.fn())
// What the rail observes at the address, in DAI units: the coin it settles in.
const held = vi.hoisted(() => vi.fn(async () => 0n))
// Plenty of shared capacity, read from a fake bucket instead of the network.
const capacity = vi.hoisted(() => ({
  availableAtomic: 40_000n * 10n ** 18n,
  readFails: false,
  epoch: 0,
}))
vi.mock("../../../src/features/deposit/depositArrival", () => ({
  useDepositArrivalMinutes: () => 5,
}))
vi.mock("../../../src/features/deposit/capacityStore", async () =>
  (await import("../../support/fakeCapacity")).fakeCapacityStore(capacity),
)
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))
vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/analytics")>()),
  fireEvent,
}))
vi.mock("../../../src/ui/usePhoneLayout", () => ({ usePhoneLayout: () => false }))
// The mainnet coin list: DAI settles, USDC and USDT are swapped into it.
vi.mock("../../../src/features/sipa/loadDepositFacts", async (importOriginal) => {
  const { MAINNET_DAI, mainnetTokens, mockLoadDepositFacts } = await import(
    "../../support/depositTokens"
  )
  const tokens = mainnetTokens()
  return mockLoadDepositFacts(
    importOriginal,
    () => tokens,
    async () => ({
      fee: "0.25",
      token: MAINNET_DAI,
      sweepFeeAtomic: 250_000_000_000_000_000n,
      txAmountCap: 5166n * 10n ** 18n,
    }),
  )
})
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))

const { DepositScreen } = await import("../../../src/features/deposit/DepositScreen/DepositScreen")
const { setIdentity } = await import("../../support/identity")
const noClaim = () => async () => {}
const { provideFakeDepositRail } = await import("../../support/fakeDepositRail")
const { openDepositSheet, depositAddressSheet } = await import("../../support/depositFlow")
const { forceSipaDeposit } = await import("../../support/sipaDeposits")
const { MAINNET_DAI } = await import("../../support/depositTokens")
const { default: addressCopy } = await import(
  "../../../src/features/deposit/DepositAddressSheet/DepositAddressSheet.copy"
)
const { default: sendCopy } = await import("../../../src/features/deposit/sendFromWallet.copy")

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`)
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === text)
const sheet = depositAddressSheet
/** The spotted stage's block on show; the others only reserve its height. */
const shownBlock = () => sheet()!.querySelector("[data-testid='deposit-spotted'] [data-active]")

const { closeSession } = await import("../../../src/session/session")
const { openTestSession } = await import("../../support/session")
beforeEach(
  () =>
    openTestSession({ wallet: aztec.obsidionWallet, contractService: {}, sipaAddresses: gateway })
      .registrations.ready,
)
afterEach(closeSession)

describe("DepositScreen with the address sheet", () => {
  let container: HTMLDivElement
  let root: Root
  let check: ReturnType<typeof provideFakeDepositRail>

  const render = () =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <ScreeningProvider screenings={testScreenings(passThroughScreener)}>
            <DepositScreen claimName={noClaim} />
          </ScreeningProvider>
        </MemoryRouter>,
      )
    })
  const openCoin = openDepositSheet
  const closeSheet = () =>
    act(async () => sheet()!.querySelector<HTMLButtonElement>("[aria-label='Close']")!.click())
  const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  beforeEach(async () => {
    vi.clearAllMocks()
    held.mockResolvedValue(0n)
    capacity.availableAtomic = 40_000n * 10n ** 18n
    capacity.readFails = false
    capacity.epoch += 1
    localStorage.clear()
    check = provideFakeDepositRail({ addresses: () => [ADDRESS], held, token: () => USDC as Hex })
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    await setIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    await act(async () => root.unmount())
    container.remove()
  })

  it("waits for capacity, not an arrival, when a deposit lands on zero capacity", async () => {
    vi.useFakeTimers()
    capacity.availableAtomic = 0n
    await render()
    await openCoin("DAI")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    held.mockResolvedValue(50n * 10n ** 18n)
    await act(async () => byTestId("deposit-check-again")!.click())

    expect(shownBlock()!.textContent).toContain(
      fmt(addressCopy.spotted.title, { amount: "50 DAI" }),
    )
    expect(shownBlock()!.textContent).toContain(addressCopy.spotted.capacityChip)
  })

  it("shows the spotted deposit in the private funds once the rail claims its sweep", async () => {
    vi.useFakeTimers()
    // Without motion the stage switches blocks at once; jsdom never ends the ring's animation.
    vi.stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: media === "(prefers-reduced-motion: reduce)",
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    await render()
    await openCoin("DAI")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    held.mockResolvedValue(50n * 10n ** 18n)
    await act(async () => byTestId("deposit-check-again")!.click())
    expect(shownBlock()!.textContent).toContain(sendCopy.arriving.chip)

    await act(() =>
      forceSipaDeposit(ADDRESS, {
        phase: "claimed",
        tokenAddress: MAINNET_DAI,
        tokenSymbol: "DAI",
        amount: "50",
        fee: (25n * 10n ** 16n).toString(),
        netAmount: (4975n * 10n ** 16n).toString(),
        claimedInboxIndexes: ["0"],
      }),
    )

    expect(shownBlock()!.textContent).toContain(sendCopy.arrived.chip)
    expect(shownBlock()!.textContent).toContain("49.75 DAI") // debt-check-ignore: a figure, not copy
  })

  it("forgets a copy's hand-off when the sheet closes before it", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("USDC")
    await act(async () => byTestId("deposit-copy")!.click())
    expect(byTestId("deposit-copy")!.textContent).toBe("Address copied!")
    await closeSheet()
    await openCoin("USDC")
    await tick(2000)
    expect(sheet()!.textContent).toContain("Send USDC to this address")
    expect(sheet()!.textContent).not.toContain("Waiting for your USDC")
    expect(byTestId("deposit-copy")).not.toBeNull()
  })

  it("says the address couldn't be checked after a failed read, until a read succeeds", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("USDC")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)

    held.mockRejectedValueOnce(new Error("rpc down"))
    await act(async () => byTestId("deposit-check-again")!.click())
    expect(byTestId("deposit-balance")!.textContent).toBe(
      "Couldn't check this address. Check your connection and try again.",
    )
    expect(sheet()!.textContent).toContain("Waiting for your USDC")

    // The pill spins for a moment after a press before it takes another.
    await tick(800)
    const passes = check.mock.calls.length
    await act(async () => byTestId("deposit-check-again")!.click())
    expect(check).toHaveBeenCalledTimes(passes + 1)
    expect(byTestId("deposit-balance")!.textContent).toBe(
      "Balance at this address: $0 USDC · Last checked 0s ago",
    )
  })

  it("holds a deposit over the per-transaction limit for recovery from Activity", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("DAI")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    held.mockResolvedValue(BigInt(LIMIT + 100) * 10n ** 18n)
    await act(async () => byTestId("deposit-check-again")!.click())

    expect(shownBlock()!.textContent).toContain(
      fmt(addressCopy.spotted.title, { amount: `${grouped(LIMIT + 100)} DAI` }),
    )
    expect(shownBlock()!.textContent).toContain(
      fmt(addressCopy.spotted.limit, { limit: LIMIT_USD }),
    )
    expect(sheet()!.textContent).not.toContain(sendCopy.arriving.chip)

    await act(async () => button("Open Activity")!.click())
    expect(navigate).toHaveBeenCalledWith("/activity")
  })
})
