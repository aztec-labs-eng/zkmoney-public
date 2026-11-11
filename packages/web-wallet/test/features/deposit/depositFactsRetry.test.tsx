/** Guards: funding controls wait on the fee quote; a failed quote shows as failed, not blank. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import type { Hex } from "viem"
import { testScreenings } from "../../support/page"

const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const MANIFEST_TOKEN = "0x00000000000000000000000000000000000000bb" as Hex

const loadDepositDisplayFacts = vi.hoisted(() => vi.fn())
const showReportableError = vi.hoisted(() => vi.fn())

// Plenty of shared capacity, read from a fake bucket instead of the network.
const capacity = vi.hoisted(() => ({ availableAtomic: 40_000n * 10n ** 18n }))
vi.mock("../../../src/features/deposit/capacityStore", async () =>
  (await import("../../support/fakeCapacity")).fakeCapacityStore(capacity),
)
const gateway = {
  depositAddress: vi.fn(async () => ({ address: "0xp001ed", name: "alice.oxide.eth" })),
}
vi.mock("../../../src/features/sipa/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, singleToken } = await import("../../support/depositTokens")
  const tokens = singleToken(MANIFEST_TOKEN, "TEST")
  return mockLoadDepositFacts(importOriginal, () => tokens, loadDepositDisplayFacts)
})
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError }))

const { DepositScreen } = await import("../../../src/features/deposit/DepositScreen/DepositScreen")
const noClaim = () => async () => {}
const { default: depositCopy } = await import(
  "../../../src/features/deposit/DepositScreen/DepositScreen.copy"
)
const { setIdentity } = await import("../../support/identity")
const { usdFigure } = await import("../../../src/ui/format")
const { backToMethod, openDepositSheet, pickL1Coin, walletMethod } = await import(
  "../../support/depositFlow"
)

const FACTS = {
  fee: "0.25",
  token: MANIFEST_TOKEN,
  sweepFeeAtomic: 250_000_000_000_000_000n,
  txAmountCap: 5166n * 10n ** 18n,
}

const { closeSession } = await import("../../../src/session/session")
const { openTestSession } = await import("../../support/session")
const { fakeL1Wallet, withL1Wallet } = await import("../../support/fakeL1Wallet")
let wallet: ReturnType<typeof fakeL1Wallet>
beforeEach(() => {
  const session = openTestSession({ wallet: {}, contractService: {}, sipaAddresses: gateway })
  wallet = fakeL1Wallet()
  withL1Wallet(session, wallet.wallet)
  return session.registrations.ready
})
afterEach(closeSession)

describe("DepositScreen — deposit quote", () => {
  let container: HTMLDivElement
  let root: Root

  const retry = () =>
    container.querySelector<HTMLButtonElement>("[data-testid='deposit-facts-retry']")
  const feeValue = () => container.querySelector("[data-testid='deposit-fee']")?.textContent?.trim()
  const copyButton = () =>
    container.querySelector<HTMLButtonElement>("[data-testid='deposit-copy']")
  /** Opens the sheet for the one coin the sandbox lists, and its limits drawer, where the fee is. */
  const openDrawer = async () => {
    await openDepositSheet("TEST")
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="address-limits"] button')!.click(),
    )
  }

  /** The flow's first step, then the L1 coin: the method step, whose wallet row funds. */
  const toMethod = async () => {
    await render({ startDeposit: true })
    await pickL1Coin("TEST")
  }
  const render = (state?: object) =>
    act(async () => {
      root.render(
        <MemoryRouter initialEntries={[{ pathname: "/deposit", state }]}>
          <ScreeningProvider screenings={testScreenings(passThroughScreener)}>
            <DepositScreen claimName={noClaim} />
          </ScreeningProvider>
        </MemoryRouter>,
      )
    })

  beforeEach(async () => {
    vi.clearAllMocks()
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

  it("offers another go when the quote fails, and quotes once it lands", async () => {
    loadDepositDisplayFacts.mockRejectedValueOnce(new Error("rpc down"))
    await render()
    await openDrawer()

    expect(retry()).toBeTruthy()
    expect(copyButton()?.disabled).toBe(true)
    // Transient by nature; the retry control is the affordance, not an error report.
    expect(showReportableError).not.toHaveBeenCalled()

    loadDepositDisplayFacts.mockResolvedValue(FACTS)
    await act(async () => retry()!.click())

    expect(loadDepositDisplayFacts).toHaveBeenCalledTimes(2)
    expect(retry()).toBeNull()
    expect(feeValue()).toBe(usdFigure(FACTS.fee))
    expect(copyButton()?.disabled).toBe(false)
  })

  it("holds the funding controls while the quote is unavailable, and frees them on a good retry", async () => {
    loadDepositDisplayFacts.mockRejectedValueOnce(new Error("rpc down"))
    wallet.connect(`0x${"a1".repeat(20)}`)
    await toMethod()

    const note = () => container.querySelector("[data-testid='deposit-fee-unavailable']")
    expect(walletMethod()!.disabled).toBe(true)
    await openDrawer()
    expect(gateway.depositAddress).toHaveBeenCalledOnce()
    expect(copyButton()?.disabled).toBe(true)
    expect(note()?.textContent).toBe(depositCopy.feeUnavailableNote)

    loadDepositDisplayFacts.mockResolvedValue(FACTS)
    await act(async () => retry()!.click())

    expect(copyButton()?.disabled).toBe(false)
    expect(note()).toBeNull()
    await backToMethod()
    expect(walletMethod()!.disabled).toBe(false)
  })

  it("keeps the row pending across a retry rather than blanking it", async () => {
    loadDepositDisplayFacts.mockRejectedValueOnce(new Error("rpc down"))
    await render()
    await openDrawer()
    expect(retry()).toBeTruthy()

    loadDepositDisplayFacts.mockReturnValue(new Promise(() => {}))
    await act(async () => retry()!.click())

    expect(retry()).toBeNull()
    expect(feeValue()).toBe(depositCopy.quotePending)
  })

  it("holds the funding controls while the quote is still out, with nothing to retry", async () => {
    let land: (facts: typeof FACTS) => void = () => {}
    loadDepositDisplayFacts.mockReturnValue(new Promise((resolve) => (land = resolve)))
    wallet.connect(`0x${"a1".repeat(20)}`)
    await toMethod()

    expect(walletMethod()!.disabled).toBe(true)
    await openDrawer()
    expect(copyButton()?.disabled).toBe(true)
    // Nothing has failed, so the row says pending and carries no note.
    expect(container.querySelector("[data-testid='deposit-fee-unavailable']")).toBeNull()

    await act(async () => land(FACTS))

    expect(copyButton()?.disabled).toBe(false)
    await backToMethod()
    expect(walletMethod()!.disabled).toBe(false)
  })
})
