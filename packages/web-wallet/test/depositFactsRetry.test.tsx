/**
 * The deposit quote is what gates funding: without the fee the wallet would charge the amount
 * alone while the pool still takes its cut. A failed read has to say so and offer another go,
 * rather than leaving every affordance dead.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import type { Hex } from "viem"

const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const MANIFEST_TOKEN = "0x00000000000000000000000000000000000000bb"

const loadDepositDisplayFacts = vi.hoisted(() => vi.fn())
const showReportableError = vi.hoisted(() => vi.fn())

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}))
vi.mock("../src/features/deposit/l1DepositTokenBalance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/deposit/l1DepositTokenBalance")>()),
  readL1TokenBalance: vi.fn(async () => 0n),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => ({ obsidionWallet: {} }),
  useContractServiceContext: () => ({ contractService: {} }),
}))
type Resolved = { address: string; name: string } | undefined
const gateway = {
  depositAddress: vi.fn(async () => ({ address: "0xdeadbeef", name: "alice.oxide.eth" })),
  pooledDepositAddress: vi.fn(
    async (): Promise<Resolved> => ({
      address: "0xp001ed",
      name: "alice.oxide.eth",
    }),
  ),
}
vi.mock("../src/features/deposit/sipaGateway", () => ({ getSipaDepositGateway: () => gateway }))
vi.mock("../src/features/deposit/loadDepositFacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/deposit/loadDepositFacts")>()),
  loadDepositDisplayFacts,
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError }))
const fireEvent = vi.hoisted(() => vi.fn())
vi.mock("../src/lib/analytics", () => ({
  fireEvent,
  failureCode: () => "x",
  lapTimer: () => () => 0,
  amountBucket: () => "b",
}))
const l1 = vi.hoisted(() => ({
  account: null as string | null,
  accounts: [] as string[],
  chainId: null as number | null,
  connecting: false,
  wrongChain: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
}))
vi.mock("../src/features/deposit/l1Wallet", () => ({ useL1Wallet: () => l1 }))
vi.mock("uqr", () => ({ renderSVG: (value: string) => `<svg data-uri="${value}"></svg>` }))
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {title}
    </button>
  ),
  Spinner: () => null,
  TopNavIconButton: () => null,
}))

const { DepositScreen, FEE_UNAVAILABLE_NOTE, QUOTE_PENDING } = await import(
  "../src/features/deposit/DepositScreen"
)
const { saveWalletIdentity } = await import("../src/features/identity/walletIdentity")
const { usdFigure } = await import("../src/ui/format")
import { seedBootConfig } from "./seedBootConfig"

const FACTS = {
  fee: "0.35",
  token: MANIFEST_TOKEN,
  sweepFeeAtomic: 250_000_000_000_000_000n,
  fpcFundingCutAtomic: 100_000_000_000_000_000n,
}

describe("DepositScreen — deposit quote", () => {
  beforeAll(seedBootConfig)

  let container: HTMLDivElement
  let root: Root

  const retry = () =>
    container.querySelector<HTMLButtonElement>("[data-testid='deposit-facts-retry']")
  const feeValue = () => container.querySelector("[data-testid='deposit-fee']")?.textContent?.trim()
  const buttonNamed = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === text)

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

  beforeEach(async () => {
    vi.clearAllMocks()
    gateway.pooledDepositAddress.mockResolvedValue({
      address: "0xp001ed",
      name: "alice.oxide.eth",
    })
    l1.account = null
    localStorage.clear()
    saveWalletIdentity({ handle: "alice", address: L2_ADDRESS, claimedAt: 1 })
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

    expect(retry()).toBeTruthy()
    expect(buttonNamed("Copy")?.disabled).toBe(true)
    // Transient by nature; the retry control is the affordance, not an error report.
    expect(showReportableError).not.toHaveBeenCalled()

    loadDepositDisplayFacts.mockResolvedValue(FACTS)
    await act(async () => retry()!.click())

    expect(loadDepositDisplayFacts).toHaveBeenCalledTimes(2)
    expect(retry()).toBeNull()
    expect(container.textContent).toContain(usdFigure(FACTS.fee))
    expect(buttonNamed("Copy")?.disabled).toBe(false)
  })

  it("holds the funding controls while the quote is unavailable, and frees them on a good retry", async () => {
    loadDepositDisplayFacts.mockRejectedValueOnce(new Error("rpc down"))
    // An empty pool leaves Generate as the address control, which the failed quote also holds.
    gateway.pooledDepositAddress.mockResolvedValue(undefined)
    l1.account = `0x${"a1".repeat(20)}`
    await render()

    const connect = () => container.querySelector<HTMLButtonElement>(".ww-deposit__connect")!
    const note = () => container.querySelector("[data-testid='deposit-fee-unavailable']")
    expect(connect().disabled).toBe(true)
    expect(buttonNamed("Generate")?.disabled).toBe(true)
    expect(note()?.textContent).toBe(FEE_UNAVAILABLE_NOTE)

    loadDepositDisplayFacts.mockResolvedValue(FACTS)
    await act(async () => retry()!.click())

    expect(connect().disabled).toBe(false)
    expect(buttonNamed("Generate")?.disabled).toBe(false)
    expect(note()).toBeNull()
  })

  it("reads as pending from the open, and a connect click while it is out changes nothing", async () => {
    // Never settles: the quote is in flight, so nothing has failed and there is nothing to retry.
    loadDepositDisplayFacts.mockReturnValue(new Promise(() => {}))
    l1.account = `0x${"a1".repeat(20)}`
    await render()

    // No click is needed to earn the row: the read is out, so the row says so.
    expect(feeValue()).toBe(QUOTE_PENDING)
    expect(retry()).toBeNull()

    const connect = container.querySelector<HTMLButtonElement>(".ww-deposit__connect")!
    await act(async () => connect.click())

    expect(feeValue()).toBe(QUOTE_PENDING)
    expect(retry()).toBeNull()
  })

  it("keeps the row pending across a retry rather than blanking it", async () => {
    loadDepositDisplayFacts.mockRejectedValueOnce(new Error("rpc down"))
    await render()
    expect(retry()).toBeTruthy()

    loadDepositDisplayFacts.mockReturnValue(new Promise(() => {}))
    await act(async () => retry()!.click())

    expect(retry()).toBeNull()
    expect(feeValue()).toBe(QUOTE_PENDING)
  })

  it("reports a failed quote read", async () => {
    loadDepositDisplayFacts.mockRejectedValueOnce(new Error("rpc down"))
    await render()

    expect(fireEvent).toHaveBeenCalledWith("action_failed", {
      action: "deposit:facts",
      code: "x",
    })
  })

  it("holds the funding controls while the quote is still out, with nothing to retry", async () => {
    let land: (facts: typeof FACTS) => void = () => {}
    loadDepositDisplayFacts.mockReturnValue(new Promise((resolve) => (land = resolve)))
    gateway.pooledDepositAddress.mockResolvedValue(undefined)
    l1.account = `0x${"a1".repeat(20)}`
    await render()

    const connect = () => container.querySelector<HTMLButtonElement>(".ww-deposit__connect")!
    expect(connect().disabled).toBe(true)
    expect(buttonNamed("Generate")?.disabled).toBe(true)
    // Nothing has failed, so the row says pending and carries no note.
    expect(container.querySelector("[data-testid='deposit-fee-unavailable']")).toBeNull()

    await act(async () => land(FACTS))

    expect(connect().disabled).toBe(false)
    expect(buttonNamed("Generate")?.disabled).toBe(false)
  })

  it("holds the address pill's copy while the fee is unread", async () => {
    loadDepositDisplayFacts.mockReturnValue(new Promise(() => {}))
    await render()

    const pill = container.querySelector<HTMLButtonElement>("[data-testid='deposit-address']")
    expect(pill?.disabled).toBe(true)
  })
})
