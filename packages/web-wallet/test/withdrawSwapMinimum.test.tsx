/**
 * A swap route has to leave the escrow something to swap after the withdrawal relayer tip, the FPC
 * cut and the escrow's relayer tip. That floor rides on top of the typed amount, so the escrow
 * always has the typed amount to swap. The relayer tip comes from a live simulation, so the floor
 * is whatever the simulator answers — here a fake with the sdk's contract — and the burn derives
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
    swapEscrowFactoryV2: `0x${"fa".repeat(20)}`,
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
vi.mock("../src/features/allowance/SponsoredActionNotice", () => ({
  useSponsoredActionBlock: () => undefined,
  SponsoredActionNotice: () => null,
}))
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

  it("accepts the $1 minimum: the floor rides on top, so the escrow has the typed amount to swap", async () => {
    await type("1")
    expect(button("Review")?.disabled).toBe(false)
  })

  it("simulates the typed amount plus the floor, for the typed recipient", async () => {
    await type("1")
    // The floor is learned from the first pass over the typed amount alone; the second prices
    // the burn that carries it.
    await settle()
    const last = control.calls.at(-1)!
    expect(last.recipient).toBe(RECIPIENT)
    expect(last.amount).toBe(10n ** 18n + FLOOR)
    expect(last.deductions).toEqual({
      withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
      proverTip: 0n,
      fpcFundingCut: CUT,
    })
  })

  // The floor doubles as the swap route's all-in fee; the row must show it whole, not the
  // portal's deductions alone, and say what the relayer's share is.
  it("shows the all-in swap fee and the relayer tip inside it", async () => {
    const fee = Array.from(container.querySelectorAll(".ww-sheet__fact")).find(
      (f) => f.querySelector("span")?.textContent === "Withdrawal fee",
    )
    expect(fee?.querySelector("b")?.textContent).toBe(usdFigure(formatUnits(FLOOR, 18)))
    expect(container.textContent).toContain("Includes $3 for L1 gas at 1 gwei.")
  })
})
