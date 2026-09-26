import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PaymentLink } from "../src/features/paylink/types"

import { fireEvent } from "../src/lib/analytics"
import { asOperation, endSigningAndHandOff } from "./support/handOff"

vi.mock("../src/lib/analytics", () => ({ fireEvent: vi.fn(), failureCode: vi.fn() }))

const m = vi.hoisted(() => ({
  verify: vi.fn(),
  caller: vi.fn(async (_executor: string, payee: string) => ({ bound: payee })),
  executor: "0xe8ec000000000000000000000000000000000e8c",
  confirm: vi.fn(),
  close: vi.fn(),
  handOff: vi.fn(),
  error: vi.fn(),
  config: { network: "sandbox" },
  screening: { cleared: true, screener: {} },
}))
vi.mock("@obsidion/web-ds", () => ({
  GradientSpinner: () => null,
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({
    title,
    isDisabled,
    onClick,
  }: {
    title: string
    isDisabled: boolean
    onClick: () => void
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
}))
vi.mock("../src/features/paylink/emailClaim", () => ({
  obtainEmailL1Proof: m.verify,
  emailL1Caller: m.caller,
}))
vi.mock("../src/features/paylink/paylinkSource", () => ({
  paylinkTuple: async () => ({ plainWithdrawalExecutor: m.executor }),
}))
vi.mock("../src/config/env", () => ({ getConfig: () => m.config }))
vi.mock("../src/ui/screening", () => ({
  useScreenedAddress: () => m.screening,
  ScreeningNotice: () => <p>Screening</p>,
}))
vi.mock("../src/features/deposit/l1Wallet", () => ({ useL1Wallet: () => ({}) }))
vi.mock("../src/features/withdraw/WithdrawScreen", () => ({ useSavedL1Wallets: () => [] }))
// A priced direct route: the withdrawal relayer tip plus the portal's cut, and no swap. `route` switches it
// to the two states where the fee is missing — still being read, and reported as unreadable.
const DIRECT_FEE = vi.hoisted(() => 350_000_000_000_000_000n)
const route = vi.hoisted(() => ({ state: "ready" as "ready" | "pending" | "unavailable" }))
const FEE_COPY = "The fee can't be read right now. Check your connection and try again."
vi.mock("../src/features/withdraw/withdrawQuote", () => ({
  FEE_UNAVAILABLE_COPY: "The fee can't be read right now. Check your connection and try again.",
  withdrawalFeeDisplay: () => (route.state === "ready" ? "0.35" : undefined),
  useSwapSimulation: () =>
    route.state === "ready"
      ? {
          status: "ready",
          fee: {
            withdrawalRelayerTip: 100_000_000_000_000_000n,
            fpcFundingCut: 250_000_000_000_000_000n,
            swapRelayerTip: 0n,
            floorAtomic: DIRECT_FEE,
          },
        }
      : { status: route.state === "unavailable" ? "unavailable" : "ready" },
  swapFloorAtomic: () => (route.state === "ready" ? DIRECT_FEE : 0n),
  WithdrawalEstimate: () => null,
}))
vi.mock("../src/platform/desktopBridge", () => ({ isDesktopL1SubmitActive: () => true }))
vi.mock("../src/ui/format", () => ({ shortAddr: (v: string) => v, usdFigure: (v: string) => v }))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: m.error }))
const { ClaimToL1Modal } = await import("../src/features/paylink/ClaimToL1Modal")
const proof = { vkey: ["key"], proof: ["proof"], public_inputs: ["caller"] }
const address = "0x2222222222222222222222222222222222222222"
let container: HTMLDivElement
let root: Root
let link: PaymentLink
function render() {
  act(() =>
    root.render(
      <ClaimToL1Modal
        link={link}
        ready
        onClose={m.close}
        onHandOff={m.handOff}
        onConfirm={m.confirm}
        planSwap={async () => undefined}
      />,
    ),
  )
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  )!
  expect(button).toBeTruthy()
  await act(async () => button.click())
}
function button(label: string) {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)!
}
// What the CTA promises on the direct route: the escrow less the 0.35 fee once it is priced, else the
// escrow itself.
const payout = (amount?: string) => (amount === "25" && route.state === "ready" ? "24.65" : amount)
async function review() {
  render()
  const input = container.querySelector('input[placeholder="Paste an address"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, address)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await click(link.amount ? `Claim ${payout(link.amount)}` : "Claim")
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  m.close.mockReset()
  m.handOff.mockReset()
  m.screening.cleared = true
  m.config.network = "sandbox"
  route.state = "ready"
  m.verify.mockResolvedValue(proof)
  m.confirm.mockReturnValue(new Promise(() => {}))
  link = {
    fragment: "fragment",
    url: "",
    amount: "25",
    status: "unclaimed",
    flavor: "email",
    tokenAddress: `0x${"5c".repeat(32)}`,
  }
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("email external-wallet claim modal", () => {
  it("verifies before confirmation and submits only once with the proof", async () => {
    await review()
    expect(button("Confirm and claim 24.65")).toBeUndefined()
    await click("Verify email with Google")
    // The proof binds the source deployment's executor and the payload paying the recipient.
    expect(m.caller).toHaveBeenCalledWith(m.executor, address)
    expect(m.verify.mock.calls[0]![0]).toEqual({ bound: address })
    expect(m.confirm).not.toHaveBeenCalled()
    const confirm = button("Confirm and claim 24.65")
    await act(async () => {
      confirm.click()
      confirm.click()
    })
    expect(m.confirm).toHaveBeenCalledTimes(1)
    expect(m.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: address, zkProof: proof }),
      expect.any(Function),
    )
  })

  it("holds verification until the proof's caller is hashed", async () => {
    let finish!: (caller: { bound: string }) => void
    m.caller.mockReturnValueOnce(new Promise((r) => (finish = r)))
    await review()
    expect(button("Verify email with Google").disabled).toBe(true)
    await act(async () => finish({ bound: address }))
    expect(button("Verify email with Google").disabled).toBe(false)
  })

  it("discards verification when returning to edit the address", async () => {
    await review()
    await click("Verify email with Google")
    await click("Cancel")
    expect((m.verify.mock.calls[0]![4] as AbortSignal).aborted).toBe(true)
    await click("Claim 24.65")
    expect(button("Verify email with Google")).toBeTruthy()
    expect(button("Confirm and claim 24.65")).toBeUndefined()
  })

  it("ignores a late proof after close and prevents duplicate verification", async () => {
    let finish!: (value: typeof proof) => void
    m.verify.mockReturnValue(
      new Promise((r) => {
        finish = r
      }),
    )
    await review()
    await click("Verify email with Google")
    await click("Verify email with Google")
    expect(m.verify).toHaveBeenCalledTimes(1)
    await click("Close")
    const isActive = m.verify.mock.calls[0]![3] as () => boolean
    expect(isActive()).toBe(false)
    expect((m.verify.mock.calls[0]![4] as AbortSignal).aborted).toBe(true)
    await act(async () => finish(proof))
    expect(m.confirm).not.toHaveBeenCalled()
    expect(button("Confirm and claim 24.65")).toBeUndefined()
  })

  it("invalidates a proof on network change and permits retry after a popup error", async () => {
    await review()
    m.verify.mockRejectedValueOnce(new Error("Popup closed"))
    await click("Verify email with Google")
    expect(container.textContent).toContain("Popup closed")
    await click("Verify email with Google")
    m.config.network = "testnet"
    render()
    expect(button("Confirm and claim 24.65")).toBeUndefined()
  })

  it("does not submit when screening changes after review", async () => {
    await review()
    await click("Verify email with Google")
    m.screening.cleared = false
    render()
    expect(button("Confirm and claim 24.65").disabled).toBe(true)
    expect(m.confirm).not.toHaveBeenCalled()
  })

  it.each(["email", "direct"] as const)(
    "waits for the escrow amount before a %s withdrawal",
    async (flavor) => {
      link.flavor = flavor
      link.amount = undefined
      await review()
      expect(button("Connecting…").disabled).toBe(true)
      expect(container.textContent).not.toContain("too little")
      await click("Connecting…")
      expect(m.verify).not.toHaveBeenCalled()
      expect(m.confirm).not.toHaveBeenCalled()

      link.amount = "25"
      render()
      const title = flavor === "email" ? "Verify email with Google" : "Confirm and claim 24.65"
      expect(button(title).disabled).toBe(false)
      await click(title)
      if (flavor === "email") await click("Confirm and claim 24.65")
      expect(m.confirm).toHaveBeenCalledTimes(1)
    },
  )

  it("keeps direct links free of email verification", async () => {
    link.flavor = "direct"
    await review()
    await click("Confirm and claim 24.65")
    expect(m.verify).not.toHaveBeenCalled()
    expect(m.confirm).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])(
    "does not report cancellation on a normal claim exit (signing: %s)",
    async (signing) => {
      let settle!: () => void
      m.confirm.mockImplementation(
        asOperation((_choice: unknown, onStage: (stage: string) => void) => {
          onStage("proving")
          return new Promise<void>((resolve) => {
            settle = resolve
          })
        }, "paylink-claim-l1"),
      )
      m.close.mockImplementation(() => root.render(null))
      m.handOff.mockImplementation(() => root.render(null))
      link.flavor = "direct"
      await review()
      await click("Confirm and claim 24.65")
      if (signing) await endSigningAndHandOff()
      await act(async () => settle())
      expect(container.textContent).toBe("")
      expect(m.handOff).toHaveBeenCalledTimes(1)
      expect(m.close).not.toHaveBeenCalled()
      expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
    },
  )
  it("closes when the confirm ran no operation to hand off", async () => {
    m.confirm.mockResolvedValue(undefined)
    link.flavor = "direct"
    await review()
    await click("Confirm and claim 24.65")
    expect(m.close).toHaveBeenCalledTimes(1)
    expect(m.handOff).not.toHaveBeenCalled()
  })
  it("reports an accepted pre-prove cancellation exactly once", async () => {
    let continueClaim!: () => void
    m.confirm.mockImplementation(async (_choice, onStage) => {
      await new Promise<void>((resolve) => {
        continueClaim = resolve
      })
      onStage("proving")
    })
    link.flavor = "direct"
    await review()
    await click("Confirm and claim 24.65")
    await click("Cancel")
    await act(async () => continueClaim())
    expect(button("Confirm and claim 24.65")).toBeDefined()
    expect(m.error).not.toHaveBeenCalled()
    expect(m.close).not.toHaveBeenCalled()
    await act(async () => root.render(null))
    expect(
      vi.mocked(fireEvent).mock.calls.filter(([name]) => name === "proving_cancelled"),
    ).toEqual([["proving_cancelled", { flow: "paylink-claim-l1", stage: "building" }]])
  })

  it("preserves a failure after a Cancel click that was too late to abort", async () => {
    let advance!: (stage: string) => void
    let rejectClaim!: (error: Error) => void
    m.confirm.mockImplementation((_choice, onStage) => {
      advance = onStage
      return new Promise((_, reject) => {
        rejectClaim = reject
      })
    })
    link.flavor = "direct"
    await review()
    await click("Confirm and claim 24.65")
    const cancel = button("Cancel")
    expect(cancel.disabled).toBe(false)
    const error = new Error("Claim failed")
    await act(async () => {
      advance("proving")
      // React has not yet removed the Cancel handler for the new stage.
      cancel.click()
      rejectClaim(error)
    })
    expect(m.error).toHaveBeenCalledWith(error, "paylink:claim-l1")
    await act(async () => root.render(null))
    expect(fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })

  it("takes the whole fee off what a direct link releases", async () => {
    link.flavor = "direct"
    await review()
    // The escrow holds 25; the fee row and what lands agree on the same figure.
    expect(container.textContent).toContain("0.35")
    expect(container.textContent).toContain("24.65")
  })

  it("refuses a link the fee would consume", async () => {
    link.flavor = "direct"
    link.amount = "0.3"
    await review()
    expect(container.textContent).toContain("too little")
    expect(button("Confirm and claim 0.3").disabled).toBe(true)
  })
})

describe("external-wallet claim — the direct route's fee", () => {
  it("waits on the portal's cut rather than naming a figure it does not have", async () => {
    route.state = "pending"
    await review()

    expect(button("Connecting…")).toBeTruthy()
    expect(button("Connecting…").disabled).toBe(true)
    expect(container.textContent).not.toContain(FEE_COPY)
  })

  it("says why there is no figure once the cut is reported unreadable", async () => {
    route.state = "unavailable"
    await review()

    expect(container.textContent).toContain(FEE_COPY)
    // Not a wait any more, and nothing the sheet can price: the CTA stays shut.
    expect(button("Connecting…")).toBeUndefined()
    expect(button("Verify email with Google").disabled).toBe(true)
  })
})
