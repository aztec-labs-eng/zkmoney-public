/**
 * What the amount step says about the relayer tip: a warning where the tip would eat more than a
 * fifth of the amount, and a closed route — no committable tip, no CTA — where the simulation fails.
 * There is deliberately no fallback figure: a tip nobody simulated is a tip the relayer may never act
 * on.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { formatUnits, parseUnits } from "viem"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { SWAP_UNAVAILABLE_COPY } from "../src/features/withdraw/withdrawQuote"
import type { FakeSwapControl } from "./fixtures/fakeSwapSimulator"

const control = vi.hoisted<FakeSwapControl>(() => ({ relayerTip: 3n * 10n ** 18n, calls: [] }))
// What the mocked portal reads back as FPC_FUNDING_CUT.
const CUT = vi.hoisted(() => 250_000_000_000_000_000n)
const submit = vi.hoisted(() => vi.fn())

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
  submitSponsoredWithdrawal: submit,
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
const HIGH_TIP_WARNING = /over 20% of this amount/

describe("WithdrawToWalletModal — swap fee note", () => {
  let container: HTMLDivElement
  let root: Root

  const input = () => container.querySelector("input") as HTMLInputElement
  const button = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === title) as
      | HTMLButtonElement
      | undefined

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

  const mount = async () => {
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
  }

  beforeEach(() => {
    control.relayerTip = 3n * 10n ** 18n
    control.failure = undefined
    control.calls.length = 0
    submit.mockReset()
    submit.mockImplementation(() => new Promise(() => {}))
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("warns when the relayer tip is over a fifth of the amount, and stops once it is not", async () => {
    await mount()
    // 3 DAI tip on a 12 DAI burn: 25%.
    await type("12")
    expect(container.textContent).toMatch(HIGH_TIP_WARNING)
    expect(button("Withdraw funds")?.disabled).toBe(false)

    await type("50")
    expect(container.textContent).not.toMatch(HIGH_TIP_WARNING)
  })

  it("closes the route when the simulation fails: no fee, no tip to commit, no CTA", async () => {
    control.failure = new Error("eth_estimateGas: execution reverted")
    await mount()
    await type("50")
    expect(container.textContent).toContain(SWAP_UNAVAILABLE_COPY)
    expect(container.textContent).toContain("Estimate unavailable")
    const fee = Array.from(container.querySelectorAll(".ww-deposit__fact")).find(
      (f) => f.querySelector("span")?.textContent === "Fee",
    )
    expect(fee?.querySelector("b")?.textContent).toBe("$--")
    expect(button("Withdraw funds")?.disabled).toBe(true)
  })

  it("commits the simulated tip and estimate the confirm step showed", async () => {
    await mount()
    await type("50")
    expect(container.textContent).toContain(`Includes ${formatUnits(3n * 10n ** 18n, 18)} DAI`)
    await act(async () => button("Withdraw funds")!.click())
    await act(async () => button("Confirm withdrawal")!.click())

    expect(submit).toHaveBeenCalledTimes(1)
    const [, recipient, charged, , , receiveAsset, swapCommit] = submit.mock.calls[0]!
    expect(recipient).toBe(RECIPIENT)
    // The burn is what was typed; the tip comes out of it rather than on top.
    expect(charged).toBe("50")
    expect(receiveAsset).toBe("USDC")
    // The fake pays (burn - withdrawal tip - portal cut - swap tip) * 0.99 in 6-dp USDC.
    const swapInput = parseUnits("50", 18) - WITHDRAW_RELAYER_TIP - CUT - 3n * 10n ** 18n
    expect(swapCommit).toEqual({
      relayerTip: 3n * 10n ** 18n,
      amountOut: (swapInput * 99n) / 100n / 10n ** 12n,
      decimals: 6,
    })
  })
})
