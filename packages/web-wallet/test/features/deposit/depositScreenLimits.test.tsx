/** Guards: copy and scan wait on the fee; the row's own fee, cap and bucket; failed reads show. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import type { Hex } from "viem"
import { testScreenings } from "../../support/page"

const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const MANIFEST_TOKEN = "0x00000000000000000000000000000000000000bb" as Hex
const primed = { tuple: { token: MANIFEST_TOKEN } as never }

const loadDepositDisplayFacts = vi.hoisted(() => vi.fn())
const demo = vi.hoisted(() => ({
  /** A two-row table: DAI and USDC each settle on their own row. */
  rows: false,
  /** A Sky table pinned on its sUSDS row whose Main is offered no row. */
  pinnedSavings: false,
  /** The accepted tokens are not read yet; `failed` once a read failed. */
  unread: false,
  failed: false,
  retry: vi.fn(),
}))

// Plenty of shared capacity, read from a fake bucket instead of the network.
const capacity = vi.hoisted(() => ({
  availableAtomic: 40_000n * 10n ** 18n,
  readFails: false,
  epoch: 0,
  rowTokens: [] as (string | undefined)[],
}))
vi.mock("../../../src/features/deposit/capacityStore", async () =>
  (await import("../../support/fakeCapacity")).fakeCapacityStore(capacity),
)
const gateway = {
  depositAddress: vi.fn(async () => ({ address: "0xp001ed", name: "alice.oxide.eth" })),
}
// The sandbox's one coin, or a case's own table.
vi.mock("../../../src/features/sipa/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, pinnedSavingsRowTokens, singleToken, twoRowTokens } = await import(
    "../../support/depositTokens"
  )
  const sandbox = singleToken(MANIFEST_TOKEN, "TEST")
  return mockLoadDepositFacts(
    importOriginal,
    () =>
      demo.unread
        ? undefined
        : demo.pinnedSavings
        ? pinnedSavingsRowTokens(false)
        : demo.rows
        ? twoRowTokens()
        : sandbox,
    loadDepositDisplayFacts,
    () => ({ failed: demo.failed, retry: demo.retry }),
  )
})

const { DepositScreen } = await import("../../../src/features/deposit/DepositScreen/DepositScreen")
const noClaim = () => async () => {}
const { setIdentity } = await import("../../support/identity")
const { openDepositSheet, depositAddressSheet } = await import("../../support/depositFlow")
import * as copy from "../../../src/features/limits/limitsCopy"
import { ROW_USDC } from "../../support/depositTokens"
import { LIMIT, LIMIT_USD, grouped } from "../../support/publicLimit"

const FACTS = {
  fee: "0.25",
  token: MANIFEST_TOKEN,
  sweepFeeAtomic: 250_000_000_000_000_000n,
  txAmountCap: 5166n * 10n ** 18n,
}

const { closeSession } = await import("../../../src/session/session")
const { openTestSession } = await import("../../support/session")
beforeEach(
  () =>
    openTestSession({ wallet: {}, contractService: {}, sipaAddresses: gateway, primed })
      .registrations.ready,
)
afterEach(closeSession)

describe("DepositScreen limits in the address sheet", () => {
  let container: HTMLDivElement
  let root: Root

  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`)
  const limits = () => byTestId("address-limits")
  const copyButton = () => byTestId("deposit-copy") as HTMLButtonElement | null
  const aboutLimits = () => document.querySelector(`dialog[aria-label="${copy.SHEET_TITLE}"]`)
  const warningDialog = () =>
    document.querySelector("dialog[aria-label='One-time deposit address']")
  /** Opens the sheet for the one coin the sandbox lists, or the named one. */
  const openSheet = (symbol = "TEST") => openDepositSheet(symbol)
  const openDrawer = () =>
    act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="address-limits"] button')!.click(),
    )
  /** Opens the limit's details from the drawer and returns them. */
  const openLimit = async () => {
    await act(async () =>
      limits()!.querySelector<HTMLButtonElement>("[data-testid='about-limits-link']")!.click(),
    )
    for (let i = 0; i < 3; i++) await act(async () => {})
    return aboutLimits()!
  }
  const maxSend = (scope: ParentNode) =>
    scope.querySelector("[data-testid='address-limits-max-send']")?.textContent
  const maxCredit = (scope: ParentNode) =>
    scope.querySelector("[data-testid='address-limits-max-credit']")?.textContent
  const limitNow = () => byTestId("deposit-limit-now")?.textContent
  const capacityNote = () => byTestId("deposit-capacity-note")

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
  const renderOverHome = () =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <ScreeningProvider screenings={testScreenings(passThroughScreener)}>
            <DepositScreen claimName={noClaim} onClose={() => {}} />
          </ScreeningProvider>
        </MemoryRouter>,
      )
    })

  beforeEach(async () => {
    vi.clearAllMocks()
    capacity.availableAtomic = 40_000n * 10n ** 18n
    capacity.readFails = false
    capacity.epoch += 1
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    demo.unread = false
    demo.failed = false
    demo.rows = false
    demo.pinnedSavings = false
    capacity.rowTokens = []
    localStorage.clear()
    await setIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const loadDepositFacts = () => loadDepositDisplayFacts.mockResolvedValue(FACTS)

  it("names no maximum and holds copy and scan while the fee is unavailable", async () => {
    loadDepositDisplayFacts.mockRejectedValue(new Error("rpc down"))
    await render()
    await openSheet()

    expect(limits()?.textContent).toContain(LIMIT_USD)
    expect(copyButton()?.disabled).toBe(true)
    expect(document.querySelector("[aria-label='Deposit address QR code']")).toBeNull()
    await openDrawer()
    const details = await openLimit()
    expect(maxSend(details)).toBe(copy.UNAVAILABLE)
    expect(maxCredit(details)).toBe(copy.UNAVAILABLE)
  })

  describe("shared capacity", () => {
    it("says capacity could not be checked, and still copies at once", async () => {
      capacity.readFails = true
      loadDepositFacts()
      await render()
      await openSheet()
      await openDrawer()
      expect(limitNow()).toBe("Could not check")
      expect(capacityNote()?.textContent).toContain(copy.CAPACITY_UNAVAILABLE)
      await act(async () => copyButton()!.click())
      expect(warningDialog()).toBeNull()
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    })
  })

  describe("a two-row table", () => {
    const usdcFacts = {
      fee: "0.1",
      token: ROW_USDC,
      sweepFeeAtomic: 100_000n,
      txAmountCap: 5_166n * 10n ** 6n,
    }
    const sheet = () => depositAddressSheet()!

    it("says the USDC row credits USDC, prices its fee in dollars and names no DAI", async () => {
      demo.rows = true
      loadDepositDisplayFacts.mockImplementation(async (_page, token?: { settlesIn: string }) =>
        token?.settlesIn === ROW_USDC ? usdcFacts : FACTS,
      )
      await render()
      await openSheet("USDC")
      await openDrawer()

      expect(byTestId("deposit-fee")?.textContent).toBe("$0.10")
      expect(byTestId("deposit-swap-note")).toBeNull()
      expect(sheet().textContent).not.toContain("DAI")
      const credit = maxCredit(await openLimit())
      expect(credit).toContain(grouped(LIMIT - 0.1))
      expect(credit).toContain("USDC")
      // The quote, the cap and the capacity bucket are the USDC row's.
      expect(loadDepositDisplayFacts).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ settlesIn: ROW_USDC }),
        "deposit",
      )
      expect(capacity.rowTokens).toContain(ROW_USDC)
    })
  })

  it("offers nothing to deposit when Main is offered no row", async () => {
    demo.pinnedSavings = true
    await renderOverHome()
    expect(byTestId("deposit-tokens-failed")).not.toBeNull()
    expect(byTestId("deposit-coin-select")).toBeNull()
  })

  describe("before the accepted tokens are read", () => {
    it("says it is loading and names no token", async () => {
      demo.unread = true
      await render()
      expect(byTestId("deposit-tokens-loading")?.textContent).toContain(
        "Loading the tokens you can deposit",
      )
      expect(byTestId("deposit-coin-TEST")).toBeNull()
      expect(container.textContent).not.toContain("DAI")
    })

    it("says the read failed, and Retry reads again", async () => {
      demo.unread = true
      demo.failed = true
      await render()
      expect(byTestId("deposit-tokens-loading")).toBeNull()
      expect(byTestId("deposit-tokens-failed")?.textContent).toContain(
        "Couldn't load the tokens you can deposit",
      )
      await act(async () => byTestId("deposit-tokens-retry")!.click())
      expect(demo.retry).toHaveBeenCalledOnce()
    })
  })
})
