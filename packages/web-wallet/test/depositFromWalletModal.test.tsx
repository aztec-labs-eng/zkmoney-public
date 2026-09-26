/**
 * The wallet-funding sheet's gates: the charged total (amount + fee) against the wallet's balance,
 * the fee having loaded, the per-transaction cap, screening, and the confirm step.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"
import type { L1TokenBalance } from "../src/features/deposit/l1DepositTokenBalance"
import type { DepositTokenOption } from "../src/features/deposit/loadDepositFacts"

const ACCOUNT = "0x00000000000000000000000000000000000000aa" as Hex
const balance: { current: L1TokenBalance | undefined } = { current: undefined }
const screening = { cleared: true }
type DepositParams = {
  amountDisplay: string
  tokenSymbol: string
  token?: { address: Hex; decimals: number }
  onSubmitted?: (h: Hex) => void
}
const deposit = vi.fn(async (_params: DepositParams) => ({
  txHash: "0x01",
  address: "0xdeadbeef",
  name: "alice",
}))

const useL1TokenBalance = vi.hoisted(() => vi.fn())
vi.mock("../src/features/deposit/useL1TokenBalance", () => ({ useL1TokenBalance }))
vi.mock("../src/ui/screening", () => ({
  useScreenedAddress: () => ({ verdict: undefined, cleared: screening.cleared, rescreen: vi.fn() }),
  ScreeningNotice: () => <span>screening-notice</span>,
}))
vi.mock("../src/features/deposit/sipaGateway", () => ({
  getSipaDepositGateway: () => ({ deposit }),
}))
vi.mock("../src/platform/desktopBridge", () => ({ isDesktopL1SubmitActive: () => false }))
// Not sandbox: the balance ceiling only applies where nothing is minted on the way.
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ network: "testnet", l1Chain: { name: "Sepolia" } }),
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
const fireEvent = vi.hoisted(() => vi.fn())
vi.mock("../src/lib/analytics", () => ({
  fireEvent,
  failureCode: () => "x",
  lapTimer: () => () => 0,
  amountBucket: () => "b",
}))
vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
    isLoading,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
    isLoading?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={isDisabled || isLoading}>
      {title}
    </button>
  ),
  TopNavIconButton: ({ onClick }: { onClick?: () => void }) => (
    <button type="button" aria-label="Close" onClick={onClick} />
  ),
}))

const { DepositFromWalletModal } = await import("../src/features/deposit/DepositFromWalletModal")

const l1 = {
  account: ACCOUNT,
  accounts: [ACCOUNT],
  chainId: 1,
  walletName: "Rainbow",
  connecting: false,
  wrongChain: false,
  connect: async () => {},
  disconnect: () => {},
  switchNetwork: async () => {},
  selectAccount: () => {},
  switchAccount: async () => {},
} as never

const token: DepositTokenOption = { symbol: "DAI", decimals: 18, icon: "" }
const holds = (display: string): L1TokenBalance => ({
  raw: BigInt(Math.round(Number(display) * 1e6)) * 10n ** 12n,
  value: Number(display),
  display: `${display} DAI`,
  symbol: "DAI",
  decimals: 18,
})

let container: HTMLDivElement
let root: Root
const onClose = vi.fn()
const onSent = vi.fn()
const onSendFailed = vi.fn()

async function render(fee?: string, pick = token) {
  await act(async () => {
    root.render(
      <DepositFromWalletModal
        l1={l1}
        deposit={{ address: "0xdeadbeef" as Hex, name: "alice" }}
        token={pick}
        fee={fee}
        onClose={onClose}
        onSent={onSent}
        onSendFailed={onSendFailed}
      />,
    )
  })
}
async function type(value: string) {
  const input = container.querySelector("input")!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const button = (title: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title)!

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  balance.current = holds("10")
  useL1TokenBalance.mockReset().mockImplementation(() => balance.current)
  screening.cleared = true
  deposit.mockClear()
  fireEvent.mockClear()
  onClose.mockClear()
  onSent.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe("DepositFromWalletModal", () => {
  it("charges amount + fee and blocks when that total exceeds the balance", async () => {
    await render("0.5")
    await type("9.6")
    expect(button("Deposit funds").disabled).toBe(true)
    expect(container.textContent).toContain("Not enough funds")
    await type("9.5")
    expect(button("Deposit funds").disabled).toBe(false)
    expect(container.textContent).toContain("$10")
  })

  it("stays enabled when the balance could not be read", async () => {
    balance.current = undefined
    await render("0.5")
    await type("5")
    expect(button("Deposit funds").disabled).toBe(false)
  })

  it("cannot submit until the fee is known", async () => {
    await render(undefined)
    await type("5")
    expect(button("Deposit funds").disabled).toBe(true)
  })

  it("refuses a send over the cap and names the maximum it will take", async () => {
    const { TX_AMOUNT_CAP } = await import("@obsidion/sdk")
    const { DEFAULT_DECIMALS } = await import("@obsidion/core/constants")
    const { formatUnits } = await import("viem")
    const cap = formatUnits(TX_AMOUNT_CAP, DEFAULT_DECIMALS)
    balance.current = holds("5000")

    await render("0.5")
    await type(String(Number(cap) + 1))
    expect(button("Deposit funds").disabled).toBe(true)
    expect(container.textContent).toContain("$2583")
    // Nothing lands, so nothing is quoted as received either.
    expect(container.textContent).toContain("$--")

    await type(cap)
    expect(container.textContent).not.toContain("Deposit up to")
    expect(button("Deposit funds").disabled).toBe(false)
  })

  it("is gated on the sender clearing screening", async () => {
    screening.cleared = false
    await render("0.5")
    await type("5")
    expect(button("Deposit funds").disabled).toBe(true)
    expect(container.textContent).toContain("screening-notice")
  })

  it("confirms before transferring the charged total, and cannot be dismissed mid-transfer", async () => {
    let resolveDeposit!: () => void
    deposit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDeposit = () => resolve({ txHash: "0x01", address: "0xdeadbeef", name: "alice" })
        }),
    )
    await render("0.5")
    await type("2")
    await act(async () => button("Deposit funds").click())
    expect(deposit).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Confirm deposit")
    await act(async () => button("Confirm deposit").click())
    expect(deposit.mock.calls[0][0]).toMatchObject({ amountDisplay: "2.5", tokenSymbol: "DAI" })
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(),
    )
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => resolveDeposit())
    // The connected-wallet leg of the deposit funnel: funded is stamped with its funding source.
    expect(fireEvent).toHaveBeenCalledWith(
      "deposit_funded",
      expect.objectContaining({ funding: "wallet" }),
    )
  })

  it("transfers the picked token, not the manifest one", async () => {
    const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex
    await render("0.5", { address: USDC, symbol: "USDC", decimals: 6, icon: "" })
    expect(useL1TokenBalance).toHaveBeenCalledWith(expect.objectContaining({ token: USDC }))
    await type("2")
    await act(async () => button("Deposit funds").click())
    await act(async () => button("Confirm deposit").click())
    expect(deposit.mock.calls[0][0]).toMatchObject({
      amountDisplay: "2.5",
      tokenSymbol: "USDC",
      token: { address: USDC, decimals: 6 },
    })
  })

  it("hands off once broadcast and reports a later confirmation failure to the caller", async () => {
    deposit.mockImplementationOnce(async (params) => {
      params.onSubmitted?.("0xabc")
      throw new Error("reverted")
    })
    await render("0.5")
    await type("2")
    await act(async () => button("Deposit funds").click())
    await act(async () => button("Confirm deposit").click())
    // The charged amount is the whole figure the caller needs; the fee is already inside it.
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ txHash: "0xabc", amount: "2.5" }))
    expect(onSendFailed).toHaveBeenCalled()
    // A reverted confirmation is a failure, never a funded funnel step.
    expect(fireEvent).not.toHaveBeenCalledWith("deposit_funded", expect.anything())
    expect(fireEvent).toHaveBeenCalledWith(
      "action_failed",
      expect.objectContaining({ action: "deposit:send" }),
    )
  })
})
