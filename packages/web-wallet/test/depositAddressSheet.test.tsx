/**
 * The deposit screen lists the coins; a coin row opens the address sheet, which carries the address
 * from creating to spotted and holds the limits drawer. The screen and the sheet render for real.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, afterEach, describe, expect, it, vi, beforeAll } from "vitest"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import type { Hex } from "viem"

const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const MANIFEST_TOKEN = "0x00000000000000000000000000000000000000bb"
const ADDRESS = "0x7b3E9c41aD02f8B5c6E1d7a9F04c3B8e2A61d9F0"
const ACCOUNT = `0x${"a1".repeat(20)}` as Hex
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"

const aztec = { obsidionWallet: {} }
const contracts = { contractService: {} }
// The open's pool read hits: the coin row shows the address with no derivation.
const depositAddress = vi.fn(async () => ({ address: ADDRESS, name: "alice.oxide.eth" }))
const wakeDeposit = vi.fn(async () => {})
const gateway = { depositAddress, wakeDeposit }

const navigate = vi.hoisted(() => vi.fn())
const fireEvent = vi.hoisted(() => vi.fn())
const readL1TokenBalance = vi.hoisted(() => vi.fn(async () => 0n))
const layout = vi.hoisted(() => ({ phone: false }))
// Plenty of shared capacity, read from a fake bucket instead of the network.
const capacity = vi.hoisted(() => ({
  availableAtomic: 40_000n * 10n ** 18n,
  readFails: false,
  epoch: 0,
}))
// The chain's timing, as the arrival hook reads it; undefined while unread.
const arrival = vi.hoisted(() => ({ minutes: 5 as number | undefined }))
vi.mock("../src/features/deposit/depositArrival", () => ({
  useDepositArrivalMinutes: () => arrival.minutes,
}))
vi.mock("../src/features/deposit/capacityStore", async () =>
  (await import("./fakeCapacity")).fakeCapacityStore(capacity),
)
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))
vi.mock("../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/analytics")>()),
  fireEvent,
}))
vi.mock("../src/features/deposit/l1DepositTokenBalance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/deposit/l1DepositTokenBalance")>()),
  readL1TokenBalance,
}))
vi.mock("../src/ui/usePhoneLayout", () => ({ usePhoneLayout: () => layout.phone }))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => aztec,
  useContractServiceContext: () => contracts,
}))
vi.mock("../src/features/deposit/sipaGateway", () => ({ getSipaDepositGateway: () => gateway }))
// The mainnet coin list: DAI settles, USDC and USDT are swapped into it.
vi.mock("../src/features/deposit/loadDepositFacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/deposit/loadDepositFacts")>()),
  depositTokensFor: () => [
    { symbol: "DAI", decimals: 18, icon: "dai.svg" },
    { address: USDC, symbol: "USDC", decimals: 6, icon: "usdc.svg" },
    {
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      decimals: 6,
      icon: "usdt.svg",
    },
  ],
  loadDepositDisplayFacts: async () => ({
    fee: "0.25",
    token: MANIFEST_TOKEN,
    sweepFeeAtomic: 150_000_000_000_000_000n,
    fpcFundingCutAtomic: 100_000_000_000_000_000n,
  }),
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
// No WagmiProvider in the test tree: `connect` raises the picker, the tests land the account by hand.
const l1 = vi.hoisted(() => ({
  account: null as Hex | null,
  accounts: [] as Hex[],
  chainId: null as number | null,
  connecting: false,
  wrongChain: false,
  walletName: null as string | null,
  pickerOpen: false,
  connect: vi.fn(async () => {
    l1.pickerOpen = true
  }),
  disconnect: vi.fn(),
}))
vi.mock("../src/features/deposit/l1Wallet", () => ({ useL1Wallet: () => l1 }))
// Which surface shows is the question; the funding sheet has its own suite.
vi.mock("../src/features/deposit/DepositFromWalletModal", () => ({
  DepositFromWalletModal: () => <div data-testid="fund-sheet" />,
}))
vi.mock("uqr", () => ({
  // A blank 21-module code: the sheet draws it itself and stamps the value on the svg.
  encode: () => ({ size: 21, data: Array.from({ length: 21 }, () => Array(21).fill(false)) }),
}))
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({
    title,
    onClick,
    isLoading,
    isDisabled,
    testId,
  }: {
    title: string
    onClick?: () => void
    isLoading?: boolean
    isDisabled?: boolean
    testId?: string
  }) => (
    <button type="button" disabled={isLoading || isDisabled} data-testid={testId} onClick={onClick}>
      {title}
    </button>
  ),
  Spinner: () => null,
  TopNavIconButton: ({ onClick, ariaLabel }: { onClick?: () => void; ariaLabel?: string }) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick} />
  ),
}))

const { DepositScreen } = await import("../src/features/deposit/DepositScreen")
const { saveWalletIdentity } = await import("../src/features/identity/walletIdentity")
const { getConfig } = await import("../src/config/env")
const { seedBootConfig } = await import("./seedBootConfig")

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`)
const copyButton = () => byTestId("deposit-copy") as HTMLButtonElement | null
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === text)
const sheet = () => document.querySelector("dialog[aria-label='Deposit address']")
const qr = () => document.querySelector("[aria-label='Deposit address QR code']")

describe("DepositScreen with the address sheet", () => {
  beforeAll(seedBootConfig)

  let container: HTMLDivElement
  let root: Root

  const render = () =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <ScreeningProvider screener={passThroughScreener}>
            <DepositScreen />
          </ScreeningProvider>
        </MemoryRouter>,
      )
    })
  const openCoin = (symbol: string) => act(async () => byTestId(`deposit-coin-${symbol}`)!.click())
  const openDrawer = () =>
    act(async () =>
      document.querySelector<HTMLButtonElement>(".ww-deposit-sheet__limits-head")!.click(),
    )
  const closeSheet = () =>
    act(async () => sheet()!.querySelector<HTMLButtonElement>("[aria-label='Close']")!.click())
  const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  beforeEach(() => {
    vi.clearAllMocks()
    readL1TokenBalance.mockResolvedValue(0n)
    capacity.availableAtomic = 40_000n * 10n ** 18n
    capacity.readFails = false
    capacity.epoch += 1
    arrival.minutes = 5
    l1.account = null
    l1.accounts = []
    l1.pickerOpen = false
    layout.phone = false
    localStorage.clear()
    localStorage.setItem("webwallet.hide-deposit-privacy-disclaimer", "true")
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    vi.useRealTimers()
    await act(async () => root.unmount())
    container.remove()
  })

  it("lists the coins in order, with the network row and the two information points", async () => {
    await render()
    expect(container.textContent).toContain("Deposit funds")
    expect(container.textContent).toContain("Which token are you sending?")
    const rows = [...container.querySelectorAll("[data-testid^='deposit-coin-']")]
    expect(rows.map((r) => r.textContent)).toEqual(["USDCUSDC", "USDTTether", "DAIDAI"])
    const network = container.querySelector(".ww-deposit__network")!
    expect(network.textContent).toBe(`Network${getConfig().l1Chain.name}`)
    for (const point of ["Risk of loss", "Each deposit gets a new address"]) {
      expect(container.textContent).toContain(point)
    }
    expect(sheet()).toBeNull()
    // The open reads the pool only; nothing derives until a coin row is pressed.
    expect(depositAddress).toHaveBeenCalledTimes(1)
    expect(depositAddress).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "alice", {
      onStage: expect.any(Function),
      publishingLimit: 0,
    })
  })

  it("opens the sheet creating when no address exists, then ready once resolved", async () => {
    let land: (next: { address: string; name: string }) => void = () => {}
    depositAddress.mockReturnValueOnce(new Promise((resolve) => (land = resolve)))
    await render()
    await openCoin("USDC")

    expect(sheet()).not.toBeNull()
    expect(sheet()!.textContent).toContain("Creating your address...")
    expect(sheet()!.textContent).toContain("Waiting for address...")
    expect(button("Waiting...")!.disabled).toBe(true)
    expect(byTestId("deposit-address")).toBeNull()

    await act(async () => land({ address: ADDRESS, name: "alice.oxide.eth" }))
    expect(sheet()!.textContent).toContain("Send USDC to this address")
    expect(sheet()!.textContent).toContain(
      "Copy it into your exchange or wallet and send USDC on Ethereum.",
    )
    const address = byTestId("deposit-address")!
    expect(address.title).toBe(ADDRESS)
    expect(address.textContent).toBe(ADDRESS)
    expect([...address.querySelectorAll("b")].map((b) => b.textContent)).toEqual(["0x7b3E", "d9F0"])
    expect(address.querySelector("em")!.textContent).toBe("61")
    expect(qr()?.innerHTML).toContain(
      `ethereum:${USDC}@${getConfig().l1ChainId}/transfer?address=${ADDRESS}`,
    )
    expect(byTestId("address-limits")!.textContent).toContain("Up to $2,500 right now")
    expect(copyButton()!.disabled).toBe(false)
  })

  it("colors the coin's ring like the bell: gold while this page runs an operation, green otherwise", async () => {
    const { getOperationStore } = await import("../src/features/operations/operations")
    const store = getOperationStore()
    let land: (next: { address: string; name: string }) => void = () => {}
    depositAddress.mockReturnValueOnce(new Promise((resolve) => (land = resolve)))
    await render()
    await openCoin("USDC")
    const ring = () => sheet()!.querySelector(".ww-deposit-sheet__coin-ring")!
    expect(ring().classList.contains("is-safe")).toBe(true)

    await act(async () => {
      await store.begin({
        operationId: "op-derive",
        flow: "deposit",
        summary: "Deposit address",
        scope: null,
      })
    })
    expect(ring().classList.contains("is-tab-bound")).toBe(true)

    await act(async () => {
      store.release("op-derive")
      await store.remove("op-derive")
    })
    expect(ring().classList.contains("is-safe")).toBe(true)
    await act(async () => land({ address: ADDRESS, name: "alice.oxide.eth" }))
  })

  it("opens the drawer with the four rows, and the DAI note only for a non-DAI token", async () => {
    await render()
    await openCoin("USDC")
    await openDrawer()
    const drawer = byTestId("address-limits")!
    for (const row of [
      "Minimum deposit$1",
      "Limit right now$2,500 incl. feesCheck again",
      "Fee$0.25",
      "Deposit arrival time~5 minutes",
    ]) {
      expect(drawer.textContent).toContain(row)
    }
    expect(byTestId("deposit-swap-note")!.textContent).toBe(
      "Your balance is stored in DAI. Sending another token will automatically convert it to DAI at the current market price, so your balance might differ.",
    )

    await closeSheet()
    await openCoin("DAI")
    await openDrawer()
    expect(byTestId("address-limits")!.textContent).toContain("Fee$0.25")
    expect(byTestId("deposit-swap-note")).toBeNull()
  })

  it("copies, says the address was copied, and then waits for the funds", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("USDC")
    await act(async () => byTestId("deposit-copy")!.click())
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ADDRESS)
    expect(byTestId("deposit-copy")!.textContent).toBe("Address copied!")
    expect(sheet()!.querySelector(".ww-deposit-sheet__chip")!.textContent).toBe("Copied")

    await tick(2000)
    expect(sheet()!.textContent).toContain("Waiting for your USDC")
    expect(sheet()!.textContent).toContain("Send USDC on Ethereum to the address below.")
    expect(sheet()!.textContent).toContain("Waiting for deposit")
    expect(byTestId("deposit-balance")!.textContent).toBe("Balance at this address: $0 USDC")
    expect(byTestId("address-limits")).toBeNull()
    expect(byTestId("deposit-address")!.title).toBe(ADDRESS)

    // Copying again is only feedback.
    await act(async () => button("Copy address again")!.click())
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2)
    expect(button("Address copied!")).toBeDefined()
    expect(sheet()!.textContent).toContain("Waiting for your USDC")
  })

  it("stays on the address when the clipboard refuses the copy", async () => {
    vi.useFakeTimers()
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    })
    await render()
    await openCoin("USDC")
    await act(async () => byTestId("deposit-copy")!.click())
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ADDRESS)
    expect(byTestId("deposit-copy")!.textContent).toBe("Copy address")
    expect(sheet()!.querySelector(".ww-deposit-sheet__chip")).toBeNull()

    await tick(2000)
    expect(sheet()!.textContent).toContain("Send USDC to this address")
    expect(sheet()!.textContent).not.toContain("Waiting for your USDC")
    expect(byTestId("address-limits")).not.toBeNull()
  })

  it("reads the balance on Check again and on the poll, and counts the seconds since", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("USDC")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    expect(readL1TokenBalance).not.toHaveBeenCalled()

    await act(async () => byTestId("deposit-check-again")!.click())
    expect(readL1TokenBalance).toHaveBeenCalledWith(USDC, ADDRESS)
    expect(byTestId("deposit-balance")!.textContent).toBe(
      "Balance at this address: $0 USDC · Last checked 0s ago",
    )
    await tick(3000)
    expect(byTestId("deposit-balance")!.textContent).toContain("Last checked 3s ago")
    expect(fireEvent).not.toHaveBeenCalledWith("deposit_funded", expect.anything())

    // The screen's own poll, ten seconds after the address was shown, feeds the same line.
    await tick(7000)
    expect(readL1TokenBalance).toHaveBeenCalledTimes(2)
    expect(byTestId("deposit-balance")!.textContent).toContain("Last checked 2s ago")
  })

  it("spots a balance once, and Close goes Home", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("DAI")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    readL1TokenBalance.mockResolvedValue(50n * 10n ** 18n)
    await act(async () => byTestId("deposit-check-again")!.click())

    expect(sheet()!.textContent).toContain("50 DAI spotted")
    expect(sheet()!.textContent).toContain("should arrive in about 5 minutes")
    expect(byTestId("deposit-arriving")!.textContent).toBe("50 DAI sent · $49.75 arriving · ~5 min")
    expect(byTestId("deposit-swap-line")).toBeNull()
    expect(sheet()!.textContent).toContain("You can close this screen.")
    expect(fireEvent.mock.calls.filter(([e]) => e === "deposit_funded")).toHaveLength(1)
    expect(navigate).not.toHaveBeenCalled()
    expect(wakeDeposit).toHaveBeenCalledWith(ADDRESS)

    await act(async () => button("Close")!.click())
    expect(sheet()).toBeNull()
    expect(navigate).toHaveBeenCalledWith("/")
    expect(depositAddress).toHaveBeenCalledOnce()
  })

  it("says a few minutes while the chain's timing is unread", async () => {
    vi.useFakeTimers()
    arrival.minutes = undefined
    await render()
    await openCoin("USDC")
    await openDrawer()
    expect(byTestId("address-limits")!.textContent).toContain("Deposit arrival timeA few minutes")

    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    readL1TokenBalance.mockResolvedValue(50n * 10n ** 6n)
    await act(async () => byTestId("deposit-check-again")!.click())
    expect(sheet()!.textContent).toContain("should arrive in about a few minutes")
    expect(byTestId("deposit-arriving")!.textContent).toBe("50 USDC sent · a few min")
  })

  it("names no $ figure for a swapped coin: the credit is set by the swap", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("USDC")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    readL1TokenBalance.mockResolvedValue(50n * 10n ** 6n)
    await act(async () => byTestId("deposit-check-again")!.click())

    expect(sheet()!.textContent).toContain("50 USDC spotted")
    expect(byTestId("deposit-arriving")!.textContent).toBe("50 USDC sent · ~5 min")
    expect(byTestId("deposit-swap-line")!.textContent).toBe(
      "Swapped to DAI at the market rate, less the fee.",
    )
    expect(sheet()!.textContent).not.toContain("$")
  })

  it("says in plain view when capacity holds a deposit, and copies all the same", async () => {
    vi.useFakeTimers()
    capacity.availableAtomic = 0n
    await render()
    await openCoin("USDC")
    const note = byTestId("deposit-capacity-note")!
    expect(note.textContent).toBe("No network capacity is available right now.")
    expect(note.getAttribute("role")).toBe("alert")
    expect(byTestId("address-limits")!.textContent).toContain("Up to $0 right now")
    expect(copyButton()!.disabled).toBe(false)
    // The note sits above Copy.
    expect(
      note.compareDocumentPosition(copyButton()!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    await act(async () => copyButton()!.click())
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ADDRESS)
    await tick(2000)
    expect(sheet()!.textContent).toContain("Waiting for your USDC")
    expect(byTestId("deposit-capacity-note")!.textContent).toBe(
      "No network capacity is available right now.",
    )
  })

  it("says when capacity could not be checked, and nothing when it is fine", async () => {
    capacity.readFails = true
    await render()
    await openCoin("USDC")
    expect(byTestId("deposit-capacity-note")!.textContent).toBe("Capacity could not be checked.")
    expect(copyButton()!.disabled).toBe(false)

    await closeSheet()
    capacity.readFails = false
    const { depositCapacityStore } = await import("../src/features/deposit/capacityStore")
    const { FAKE_ACTIVE_KEY } = await import("./fakeCapacity")
    await act(async () => {
      await depositCapacityStore(FAKE_ACTIVE_KEY).retry()
    })
    await openCoin("USDC")
    expect(byTestId("deposit-capacity-note")).toBeNull()
  })

  it("waits for capacity, not an arrival, when a deposit lands on zero capacity", async () => {
    vi.useFakeTimers()
    capacity.availableAtomic = 0n
    await render()
    await openCoin("DAI")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    readL1TokenBalance.mockResolvedValue(50n * 10n ** 18n)
    await act(async () => byTestId("deposit-check-again")!.click())

    expect(sheet()!.textContent).toContain("50 DAI spotted")
    expect(sheet()!.textContent).toContain("over what the network can take right now")
    expect(sheet()!.textContent).toContain("Waiting for capacity")
    expect(sheet()!.textContent).not.toContain("should arrive in about")
    expect(byTestId("deposit-arriving")!.textContent).toBe(
      "50 DAI sent · $49.75 arriving · once capacity frees up",
    )
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

  it("Pay with wallet closes the sheet and funds once the picked wallet lands", async () => {
    await render()
    await openCoin("USDC")
    const pay = byTestId("deposit-pay-with-wallet") as HTMLButtonElement
    expect(pay.textContent).toBe("Pay with wallet")
    expect(pay.disabled).toBe(false)
    await act(async () => pay.click())
    expect(sheet()).toBeNull()
    expect(l1.connect).toHaveBeenCalledOnce()
    expect(byTestId("fund-sheet")).toBeNull()

    l1.account = ACCOUNT
    l1.accounts = [ACCOUNT]
    await render()
    expect(byTestId("fund-sheet")).not.toBeNull()
    expect(sheet()).toBeNull()
  })

  it("says the address couldn't be checked after a failed read, until a read succeeds", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("USDC")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)

    readL1TokenBalance.mockRejectedValueOnce(new Error("rpc down"))
    await act(async () => byTestId("deposit-check-again")!.click())
    expect(byTestId("deposit-balance")!.textContent).toBe(
      "Couldn't check this address. Check your connection and try again.",
    )
    expect(sheet()!.textContent).toContain("Waiting for your USDC")

    // The pill spins for a moment after a press before it takes another.
    await tick(800)
    await act(async () => byTestId("deposit-check-again")!.click())
    expect(readL1TokenBalance).toHaveBeenCalledTimes(2)
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
    readL1TokenBalance.mockResolvedValue(3_000n * 10n ** 18n)
    await act(async () => byTestId("deposit-check-again")!.click())

    expect(sheet()!.textContent).toContain("3,000 DAI spotted")
    expect(sheet()!.textContent).toContain("This deposit is over the $2,500 limit")
    expect(sheet()!.textContent).toContain("Over the limit")
    expect(byTestId("deposit-arriving")!.textContent).toBe("3,000 DAI sent · recovery needed")
    expect(sheet()!.textContent).not.toContain("arriving")
    expect(sheet()!.querySelector(".ww-deposit-sheet__status .zkm-spinner-icon")).toBeNull()
    expect(sheet()!.textContent).toContain("Recovery sends the whole amount")

    await act(async () => button("Open Activity")!.click())
    expect(navigate).toHaveBeenCalledWith("/activity")
  })

  it("waits for capacity when the deposit is over what the network takes right now", async () => {
    vi.useFakeTimers()
    capacity.availableAtomic = 100n * 10n ** 18n
    await render()
    await openCoin("DAI")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    readL1TokenBalance.mockResolvedValue(500n * 10n ** 18n)
    await act(async () => byTestId("deposit-check-again")!.click())

    expect(sheet()!.textContent).toContain("500 DAI spotted")
    expect(sheet()!.textContent).toContain("over what the network can take right now")
    expect(sheet()!.textContent).toContain("can take longer than 5 minutes")
    expect(sheet()!.textContent).toContain("Waiting for capacity")
    expect(byTestId("deposit-arriving")!.textContent).toBe(
      "500 DAI sent · $499.75 arriving · once capacity frees up",
    )
    expect(button("Close")).toBeDefined()
    expect(button("Open Activity")).toBeUndefined()
  })

  it("renders no QR code on a phone", async () => {
    layout.phone = true
    await render()
    await openCoin("USDC")
    expect(qr()).toBeNull()
    expect(byTestId("deposit-address")!.title).toBe(ADDRESS)
    expect(byTestId("deposit-copy")).not.toBeNull()
  })

  it("keeps waiting when the same coin is opened again, and starts another coin at its address", async () => {
    vi.useFakeTimers()
    await render()
    await openCoin("USDC")
    await act(async () => byTestId("deposit-copy")!.click())
    await tick(2000)
    expect(sheet()!.textContent).toContain("Waiting for your USDC")
    await closeSheet()
    await openCoin("USDC")
    expect(sheet()!.textContent).toContain("Waiting for your USDC")
    expect(byTestId("deposit-check-again")).not.toBeNull()
    await closeSheet()
    await openCoin("USDT")
    expect(sheet()!.textContent).toContain("Send USDT to this address")
    expect(sheet()!.textContent).not.toContain("Waiting for your")
  })

  it("shows the same address when the sheet is closed and opened again", async () => {
    await render()
    await openCoin("USDC")
    expect(byTestId("deposit-address")!.title).toBe(ADDRESS)
    await closeSheet()
    expect(sheet()).toBeNull()

    await openCoin("USDT")
    expect(sheet()!.textContent).toContain("Send USDT to this address")
    expect(byTestId("deposit-address")!.title).toBe(ADDRESS)
    expect(depositAddress).toHaveBeenCalledOnce()
  })

  it("keeps the small connect link on the screen", async () => {
    await render()
    const link = container.querySelector<HTMLButtonElement>("[data-testid='deposit-connect-link']")
    expect(link?.textContent).toBe("Or connect a wallet to fund")
    expect(link?.disabled).toBe(false)
    expect(container.textContent).not.toContain("Connect your wallet")
  })
})
