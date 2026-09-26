/**
 * A swap route has to leave the escrow something to swap after the withdrawal relayer tip, the FPC
 * cut and the escrow's relayer tip. Below that floor `planSwapOnWithdraw` throws at submit, so the
 * form must refuse the amount instead. The relayer tip comes from a live simulation, so the floor is
 * whatever the simulator answers — here a fake with the sdk's contract — and the boundaries derive
 * from it.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { formatUnits } from "viem"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { usdFigure } from "../src/ui/format"
import type { FakeSwapControl } from "./fixtures/fakeSwapSimulator"

const RELAYER_TIP = 3n * 10n ** 18n
// What the mocked portal reads back as FPC_FUNDING_CUT.
const CUT = 250_000_000_000_000_000n
const FLOOR = WITHDRAW_RELAYER_TIP + CUT + RELAYER_TIP
const AT_FLOOR = formatUnits(FLOOR, 18)
const BELOW_FLOOR = formatUnits(FLOOR - 10n ** 18n, 18)
const ABOVE_FLOOR = formatUnits(FLOOR + 10n ** 18n, 18)

const control = vi.hoisted<FakeSwapControl>(() => ({ relayerTip: 3n * 10n ** 18n, calls: [] }))

vi.mock("@obsidion/sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@obsidion/sdk")>()
  const { fakeSwapSimulator } = await import("./fixtures/fakeSwapSimulator")
  return { ...sdk, SwapOnWithdrawSimulator: fakeSwapSimulator(sdk, control) }
})
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAccountContext: () => ({ obsidionAccount: {} }),
  useAssetContext: () => ({ tokenService: {} }),
  useAztecContext: () => ({ obsidionWallet: {} }),
  useContractServiceContext: () => ({ contractService: {} }),
  useBalance: () => ({
    walletAsset: { symbol: "DAI", decimals: 18, balance: 500, balanceAtomic: 500n * 10n ** 18n },
    walletBalance: "500",
    assetsLoaded: true,
  }),
  upsertSavedL1WalletContact: vi.fn(),
}))
vi.mock("../src/features/withdraw/withdrawGateway", () => ({
  submitSponsoredWithdrawal: vi.fn(),
}))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ network: "sandbox" }),
  l1Transport: () => ({}),
}))
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({
    portal: `0x${"70".repeat(20)}`,
    token: `0x${"da".repeat(20)}`,
    swapEscrowFactory: `0x${"fa".repeat(20)}`,
    operationExecutor: `0x${"e0".repeat(20)}`,
  }),
  l1PublicClient: () => ({ readContract: async () => CUT }),
}))
vi.mock("../src/lib/analytics", () => ({
  fireEvent: vi.fn(),
  failureCode: () => "x",
  lapTimer: () => () => 0,
  amountBucket: () => "under_50",
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("@obsidion/web-ds", () => ({
  GradientSpinner: () => null,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  TopNavIconButton: () => null,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
  }) => (
    <button onClick={onClick} disabled={isDisabled}>
      {title}
    </button>
  ),
}))

const { WithdrawToWalletModal } = await import("../src/features/withdraw/WithdrawToWalletModal")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const RECIPIENT = `0x${"dd".repeat(20)}` as const

describe("WithdrawToWalletModal — swap floor", () => {
  let container: HTMLDivElement
  let root: Root

  const input = () => container.querySelector("input") as HTMLInputElement
  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title) as
      | HTMLButtonElement
      | undefined

  // The screening verdict and the simulated floor both settle asynchronously, the latter behind
  // the quote debounce.
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
  }

  const type = async (value: string) => {
    await act(async () => {
      const el = input()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
      el.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await settle()
  }

  beforeEach(async () => {
    control.relayerTip = RELAYER_TIP
    control.failure = undefined
    control.calls.length = 0
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <ScreeningProvider screener={passThroughScreener}>
          <WithdrawToWalletModal
            recipient={RECIPIENT}
            receiveAsset="USDC"
            onClose={vi.fn()}
            onDone={vi.fn()}
          />
        </ScreeningProvider>,
      )
    })
    await settle()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("refuses an amount at or below the floor the escrow needs", async () => {
    await type(BELOW_FLOOR)
    expect(button("Withdraw funds")?.disabled).toBe(true)
    await type(AT_FLOOR)
    expect(button("Withdraw funds")?.disabled).toBe(true)
  })

  it("accepts an amount that leaves the escrow something to swap", async () => {
    await type(ABOVE_FLOOR)
    expect(button("Withdraw funds")?.disabled).toBe(false)
  })

  it("simulates the burned amount for the typed recipient", async () => {
    await type(ABOVE_FLOOR)
    const last = control.calls.at(-1)!
    expect(last.recipient).toBe(RECIPIENT)
    // The burn is the typed amount: the tip comes out of it, not on top.
    expect(last.amount).toBe(FLOOR + 10n ** 18n)
    expect(last.deductions).toEqual({
      withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
      proverTip: 0n,
      fpcFundingCut: CUT,
    })
  })

  // The floor doubles as the swap route's all-in fee; the row must show it whole, not the
  // portal's deductions alone, as a deduction from the burn, and say what the relayer's share is.
  it("shows the all-in swap fee and the relayer tip inside it", async () => {
    const fee = Array.from(container.querySelectorAll(".ww-deposit__fact")).find(
      (f) => f.querySelector("span")?.textContent === "Fee",
    )
    expect(fee?.querySelector("b")?.textContent).toBe(`-${usdFigure(formatUnits(FLOOR, 18))}`)
    expect(container.textContent).toContain("Includes 3 DAI for L1 gas")
  })
})
