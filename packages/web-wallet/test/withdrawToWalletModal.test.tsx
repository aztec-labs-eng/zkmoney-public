/**
 * The withdraw modal's money path: the typed amount is what lands, so the burn is charged that plus
 * the whole fee (the relayer tip and the portal's cut), MAX leaves room for that fee in exact
 * token units, and only amounts the decimal-safe parse accepts can reach the gateway. Plus the
 * hand-off: the modal holds the user through the prepare and sign beats, then closes and lets the
 * burn finish without it.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseUnits } from "viem"
import { ScreeningProvider, passThroughScreener } from "@obsidion/front-core"
import { fireEvent } from "../src/lib/analytics"
import { provingProgress } from "@obsidion/proving-progress"
import { asOperation, endSigningAndHandOff } from "./support/handOff"

const submit = vi.fn()
// What the mocked portal reads back as FPC_FUNDING_CUT, so the fee is the tip plus a quarter.
const CUT = vi.hoisted(() => 250_000_000_000_000_000n)
const FEE = "0.35"
const balance = { walletAsset: null as { balance: number; balanceAtomic: bigint } | null }
// The cut is cached per portal, so a case wanting a different read names its own portal.
const DEFAULT_PORTAL = `0x${"70".repeat(20)}`
const portalControl = vi.hoisted(() => ({
  address: `0x${"70".repeat(20)}`,
  cut: 250_000_000_000_000_000n,
  fail: false,
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAccountContext: () => ({ obsidionAccount: {} }),
  useAssetContext: () => ({ tokenService: {} }),
  useAztecContext: () => ({ obsidionWallet: {} }),
  useContractServiceContext: () => ({ contractService: {} }),
  useBalance: () => ({ ...balance, walletBalance: "0", assetsLoaded: true }),
  upsertSavedL1WalletContact: vi.fn(),
}))
vi.mock("../src/features/withdraw/withdrawGateway", () => ({ submitSponsoredWithdrawal: submit }))
// Config resolves only after boot; the sandbox network is what the quote path below expects.
vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))
// A tuple with the portal alone prices the direct route off the mocked FPC_FUNDING_CUT read and
// leaves the swap simulation's own fields missing, so a swap route is deterministically unavailable
// with no network fetch.
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ portal: portalControl.address }),
  l1PublicClient: () => ({
    readContract: async () => {
      if (portalControl.fail) throw new Error("portal read refused")
      return portalControl.cut
    },
  }),
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
    isDisabled,
    onClick,
  }: {
    title: string
    isDisabled?: boolean
    onClick?: () => void
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
}))

// Records what the modal hands the simulation while leaving the real hook and estimate in place.
const quotedAmounts: (bigint | undefined)[] = []
vi.mock("../src/features/withdraw/withdrawQuote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/features/withdraw/withdrawQuote")>()
  return {
    ...actual,
    useSwapSimulation: (args: Parameters<typeof actual.useSwapSimulation>[0]) => {
      quotedAmounts.push(args.amountAtomic)
      return actual.useSwapSimulation(args)
    },
  }
})

const { FEE_UNAVAILABLE_COPY } = await import("../src/features/withdraw/withdrawQuote")
const { WithdrawToWalletModal } = await import("../src/features/withdraw/WithdrawToWalletModal")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const RECIPIENT = "0x1111111111111111111111111111111111111111" as const

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

describe("WithdrawToWalletModal", () => {
  let container: HTMLDivElement
  let root: Root
  const onClose = vi.fn()
  const onDone = vi.fn()

  const input = () => container.querySelector("input") as HTMLInputElement
  const button = (text: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text)!
  const type = (value: string) => act(async () => typeInto(input(), value))
  const click = (text: string) => act(async () => button(text).click())
  /** The confirm CTA whatever case its label carries: reaching it is setup here, and the copy
   *  itself is asserted by the tests that are about the copy. */
  const clickConfirm = () =>
    act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((b) => /^confirm withdrawal$/i.test(b.textContent ?? ""))!
        .click(),
    )
  const renderSwapRoute = () =>
    act(async () => {
      root.render(
        <ScreeningProvider screener={passThroughScreener}>
          <WithdrawToWalletModal
            recipient={RECIPIENT}
            walletName="Rainbow"
            receiveAsset="USDC"
            onClose={onClose}
            onDone={onDone}
          />
        </ScreeningProvider>,
      )
    })

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.mocked(fireEvent).mockClear()
    submit.mockReset()
    submit.mockImplementation(() => new Promise(() => {}))
    onClose.mockReset()
    onDone.mockReset()
    balance.walletAsset = { balance: 4.11, balanceAtomic: parseUnits("4.11", 18) }
    portalControl.address = DEFAULT_PORTAL
    portalControl.cut = CUT
    portalControl.fail = false
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <ScreeningProvider screener={passThroughScreener}>
          <WithdrawToWalletModal
            recipient={RECIPIENT}
            walletName="Rainbow"
            receiveAsset="DAI"
            onClose={onClose}
            onDone={onDone}
          />
        </ScreeningProvider>,
      )
    })
    // The modal screens the recipient before its CTA can enable.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350))
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("burns the typed amount and carries the wallet name", async () => {
    await type("2")
    await click("Withdraw funds")
    await click("Confirm withdrawal")
    expect(submit).toHaveBeenCalledTimes(1)
    const [, recipient, charged, , alias] = submit.mock.calls[0]
    expect(recipient).toBe(RECIPIENT)
    // The fee comes out of the burn, so the burn is what was typed.
    expect(charged).toBe("2")
    expect(alias).toBe("Rainbow")
  })

  it("burns what was typed and pays the recipient what is left after the fee", async () => {
    await type("2")
    const row = (label: string) =>
      Array.from(container.querySelectorAll(".ww-deposit__fact"))
        .find((f) => f.querySelector("span")?.textContent === label)
        ?.querySelector("b")?.textContent
    expect(row("Fee")).toBe(`-$${FEE}`)
    await click("Withdraw funds")
    expect(row("Total withdrawn")).toBe("$2")
    expect(row("You receive")).toBe("$1.65")
  })

  // A swap escrow's simulation nets the relayer tip off its own input, so it is handed the burn.
  // Simulate the typed amount instead and the tip comes off twice, under-stating every estimate.
  it("simulates the amount that is burned", async () => {
    await renderSwapRoute()
    quotedAmounts.length = 0
    await type("2")
    expect(quotedAmounts.at(-1)).toBe(parseUnits("2", 18))
  })

  it("raises the direct route's minimum above a portal cut that would leave nothing", async () => {
    // The fee comes out of the burn, so a withdrawal at or below it pays the recipient nothing:
    // the floor is the fee, not the flat $1.
    portalControl.address = `0x${"72".repeat(20)}`
    portalControl.cut = parseUnits("2", 18)
    await type("1.5")
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    expect(input().placeholder).toBe("Minimum $2.10")
    expect(button("Withdraw funds").disabled).toBe(true)
  })

  it("says why the direct route has no figure when the portal's cut cannot be read", async () => {
    portalControl.address = `0x${"73".repeat(20)}`
    portalControl.fail = true
    await type("2")
    // The read is retried twice more before it is reported.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1_800))
    })

    const row = (label: string) =>
      Array.from(container.querySelectorAll(".ww-deposit__fact"))
        .find((f) => f.querySelector("span")?.textContent === label)
        ?.querySelector("b")?.textContent
    expect(row("Fee")).toBe("$--")
    expect(container.textContent).toContain(FEE_UNAVAILABLE_COPY)
    expect(button("Withdraw funds").disabled).toBe(true)
  })

  it("closes a swap route whose fee cannot be simulated instead of guessing one", async () => {
    await renderSwapRoute()
    await type("2")
    expect(container.textContent).toContain("Receive asUSDC")
    // Unavailability (the swap fields missing from the tuple above) lands only after the debounce.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350))
    })
    expect(container.textContent).toContain("Estimate unavailable")
    expect(container.textContent).toContain("Swap fee unavailable. Withdraw DAI instead.")
    // The dollar-denominated "You receive" row would restate the DAI INPUT, contradicting the
    // estimate directly above it. The estimate is the only honest statement of what a swap delivers.
    expect(container.textContent).not.toContain("You receive")
    // No simulated tip, nothing to commit the escrow to: the route is closed, not defaulted.
    expect(button("Withdraw funds").disabled).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })

  it("keeps the dollar You receive row on the direct DAI route", async () => {
    await type("2")
    await click("Withdraw funds")
    expect(container.textContent).toContain("You receive")
    // The fee comes out of the burn, so the recipient is paid the remainder.
    expect(container.textContent).toContain("$1.65")
  })

  it("MAX is the whole balance, and the whole balance is not overspent", async () => {
    await click("MAX")
    expect(input().value).toBe("4.11")
    expect(container.textContent).not.toContain("Balance not enough")
    expect(button("Withdraw funds").disabled).toBe(false)
  })

  it("blocks a burn above the balance by one atomic unit", async () => {
    balance.walletAsset = { balance: 4.11, balanceAtomic: parseUnits("4.11", 18) - 1n }
    await type("4.11")
    expect(button("Withdraw funds").disabled).toBe(true)
  })

  it("hands off to the bell after the passkey and resets the form only then", async () => {
    onDone.mockImplementation(() => root.render(null))
    let settle: (record: unknown) => void = () => {}
    submit.mockImplementation(asOperation(() => new Promise((resolve) => (settle = resolve)), "withdraw"))
    await type("2")
    await click("Withdraw funds")
    await click("Confirm withdrawal")

    // The prepare beat holds the user until the ceremony starts, then names what it is waiting on.
    expect(container.textContent).toContain("Preparing transaction…")
    await act(async () => provingProgress.emitSigningStart())
    expect(container.textContent).toContain("Confirm with passkey…")
    expect(onDone).not.toHaveBeenCalled()

    await endSigningAndHandOff()
    expect(onDone).toHaveBeenCalledOnce()
    expect(container.textContent).toBe("")
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())

    // The burn landing later must not reset a form the user has moved on to.
    await act(async () => settle({ localId: "w1" }))
    expect(onDone).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })

  it("refuses amounts the decimal-safe parse rejects even when parseFloat accepts them", async () => {
    await type("10,5")
    expect(button("Withdraw funds").disabled).toBe(true)
    await type("1e2")
    expect(button("Withdraw funds").disabled).toBe(true)
  })

  it("does not report cancellation when completion closes the modal without signing", async () => {
    let settle!: (record: unknown) => void
    submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        }),
    )
    onDone.mockImplementation(() => root.render(null))
    await type("2")
    await click("Withdraw funds")
    await click("Confirm withdrawal")
    await act(async () => settle({ localId: "w1" }))
    expect(container.textContent).toBe("")
    expect(fireEvent).toHaveBeenCalledWith("withdraw_submitted", expect.anything())
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })
  it("reports an accepted pre-prove cancellation exactly once", async () => {
    let continueWithdrawal!: () => void
    submit.mockImplementation(async (_deps, _recipient, _amount, onStage) => {
      await new Promise<void>((resolve) => {
        continueWithdrawal = resolve
      })
      onStage("proving")
      return { localId: "w1" }
    })
    await type("2")
    await click("Withdraw funds")
    await click("Confirm withdrawal")
    await click("Cancel")
    await act(async () => continueWithdrawal())
    expect(button("Confirm withdrawal")).toBeDefined()
    expect(onDone).not.toHaveBeenCalled()
    await act(async () => root.render(null))
    expect(
      vi.mocked(fireEvent).mock.calls.filter(([name]) => name === "proving_cancelled"),
    ).toEqual([["proving_cancelled", { flow: "withdraw", stage: "building" }]])
  })

  it("never cancels once the burn has mined, so the record survives", async () => {
    // `submitting` lands after `exitToL1PrivateSponsored` has mined. A cancel thrown there makes
    // the gateway drop the record for a withdrawal that is already irreversible on chain.
    let advance!: (stage: string) => void
    let settle!: (record: unknown) => void
    submit.mockImplementation((_deps, _recipient, _amount, onStage) => {
      advance = onStage
      return new Promise((resolve) => {
        settle = resolve
      })
    })
    await type("2")
    await click("Withdraw funds")
    await clickConfirm()

    // Cancelled while the button still offers it, but the burn got away before any stage landed.
    await act(async () => button("Cancel").click())
    await act(async () => advance("submitting"))
    await act(async () => settle({ localId: "w1" }))

    expect(onDone).toHaveBeenCalledOnce()
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
    expect(fireEvent).not.toHaveBeenCalledWith("action_failed", expect.anything())
  })

  it("preserves a failure after a Cancel click that was too late to abort", async () => {
    let advance!: (stage: string) => void
    let rejectWithdrawal!: (error: Error) => void
    submit.mockImplementation((_deps, _recipient, _amount, onStage) => {
      advance = onStage
      return new Promise((_, reject) => {
        rejectWithdrawal = reject
      })
    })
    await type("2")
    await click("Withdraw funds")
    await click("Confirm withdrawal")
    const cancel = button("Cancel")
    expect(cancel.disabled).toBe(false)
    await act(async () => {
      advance("proving")
      // React has not yet removed the Cancel handler for the new stage.
      cancel.click()
      rejectWithdrawal(new Error("Withdrawal failed"))
    })
    expect(fireEvent).toHaveBeenCalledWith("action_failed", {
      action: "withdraw:submit",
      code: "x",
    })
    await act(async () => root.render(null))
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })
})
