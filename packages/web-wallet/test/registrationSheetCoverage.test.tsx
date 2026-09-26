/**
 * What the registration sheet asks for, and when it stops asking: the quoted deposit while the
 * address is short, the schedule's fee and balance rows beneath it once each figure is read, and a
 * row left out where no read will bring one.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RegistrationKind } from "@obsidion/core/types"

vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label}:{value}
    </div>
  ),
}))
vi.mock("../src/features/onboarding/OnboardingCard", () => ({
  OnboardingCard: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("../src/features/onboarding/steps/DepositAddress", () => ({
  DepositAddressRow: () => null,
  DepositPayBlock: ({ total, note }: { total: bigint; note?: React.ReactNode }) => (
    <div data-testid="pay-block" data-total={String(total)}>
      {note}
    </div>
  ),
}))

const { RegistrationSheet } = await import("../src/features/onboarding/RegistrationSheet")
const { DEPOSIT_TERMS_PENDING, formatDepositAmount, formatDepositDue, formatDepositSeen } =
  await import("../src/features/onboarding/steps/DepositTermsRows")

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
/** Figures are built from the formatters the sheet prices with, never from its sentences. */
const usd = (amount: bigint) => formatDepositAmount(amount, 18)
const due = (amount: bigint) => formatDepositDue(amount, 18)
const seen = (amount: bigint) => formatDepositSeen(amount, 18)
/** Staging's schedule under the asked deposit: a 14.5 floor, a 15 total. */
const address = `0x${"ab".repeat(20)}` as const
const payment = {
  chainLabel: "Sepolia",
  address,
  token: `0x${"cd".repeat(20)}` as `0x${string}`,
  chainId: 11155111,
  total: dai(15) as bigint | undefined,
  fee: dai(5) as bigint | undefined,
  sweepFee: dai(0.5) as bigint | undefined,
  fpcCut: dai(0.25) as bigint | undefined,
  floor: dai(14.5) as bigint | undefined,
  kind: "standard" as RegistrationKind,
  tokenSymbol: "DAI",
  fundingAssets: "DAI, USDC or USDT",
  tokenDecimals: 18,
}

let container: HTMLDivElement
let root: Root

const termsValue = (id: string) =>
  container.querySelector(`[data-testid="deposit-terms-${id}"]`)?.textContent ?? undefined
const payBlock = () => container.querySelector('[data-testid="pay-block"]')
const summary = () =>
  container.querySelector('[data-testid="registration-sheet-summary"]')?.textContent ?? ""

const render = (
  over: Partial<typeof payment> & { received?: bigint; scheduleUnavailable?: boolean },
) =>
  act(() => {
    root.render(
      <RegistrationSheet tag="taga" title="Get instant access" payment={{ ...payment, ...over }} />,
    )
  })

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("the sheet asks the quoted deposit and settles on the floor", () => {
  it("quotes the ask while nothing has arrived", async () => {
    await render({})
    expect(container.textContent).toContain(due(dai(15)))
    expect(container.textContent).not.toContain("14.5")
  })

  it("keeps asking for the quoted figure while the deposit is short", async () => {
    await render({ received: dai(5) })
    expect(container.textContent).toContain(`${seen(dai(5))} of ${due(dai(15))} received`)
    expect(container.textContent).toContain(due(dai(10)))
  })

  it("takes a deposit that clears the floor without reaching the ask", async () => {
    await render({ received: dai(14.7) })
    expect(container.textContent).toContain(seen(dai(14.7)))
    expect(container.textContent).not.toContain("Send at least")
  })

  it("asks the full total before any schedule read lands", async () => {
    await render({ fee: undefined, fpcCut: undefined, floor: undefined })
    expect(termsValue("total")).toBe(due(dai(15)))
    // Every figure derived from the schedule waits for it rather than guessing.
    expect(termsValue("tag-price")).toBe(DEPOSIT_TERMS_PENDING)
    expect(termsValue("network-funding")).toBe(DEPOSIT_TERMS_PENDING)
    expect(termsValue("opening-balance")).toBe(DEPOSIT_TERMS_PENDING)
  })

  it("asks the total alone when no schedule is being read for it", async () => {
    await render({ fee: undefined, fpcCut: undefined, floor: undefined, scheduleUnavailable: true })
    expect(termsValue("total")).toBe(due(dai(15)))
    // A row nothing will fill is left out, not held open on a placeholder.
    for (const row of ["tag-price", "network-fee", "network-funding", "opening-balance"]) {
      expect(termsValue(row)).toBeUndefined()
    }
    expect(container.textContent).not.toContain(DEPOSIT_TERMS_PENDING)
    expect(container.textContent).not.toContain("opening balance")
  })

  it("keeps the waiver visible with no schedule to price the rest", async () => {
    await render({
      fee: undefined,
      fpcCut: undefined,
      floor: undefined,
      kind: "earned_tag",
      scheduleUnavailable: true,
    })
    expect(termsValue("tag-price")).toBe("Waived")
    expect(termsValue("network-fee")).toBeUndefined()
    expect(termsValue("opening-balance")).toBeUndefined()
    expect(container.textContent).toContain("The tag is free.")
  })

  describe("what a free schedule waives, from the figures", () => {
    // A free schedule's fee is the relayer's sweep fee alone.
    const earned = {
      kind: "earned_tag" as RegistrationKind,
      fee: dai(0.5),
      sweepFee: dai(0.5),
      fpcCut: dai(0.1),
      total: dai(5),
    }

    it("waives the tag and folds the sweep fee into network funding", async () => {
      await render({ ...earned })
      expect(termsValue("tag-price")).toBe("Waived")
      expect(termsValue("network-fee")).toBeUndefined()
      expect(termsValue("network-funding")).toBe(usd(dai(0.6)))
      expect(termsValue("opening-balance")).toBe(usd(dai(4.4)))
    })

    it("keeps the tag waived however the deployment prices the sweep", async () => {
      await render({ ...earned, fee: dai(1), sweepFee: dai(1) })
      expect(termsValue("tag-price")).toBe("Waived")
      expect(termsValue("network-funding")).toBe(usd(dai(1.1)))
      expect(termsValue("opening-balance")).toBe(usd(dai(3.9)))
    })

    it("holds each figure open until its own read lands, the waiver already certain", async () => {
      await render({ ...earned, fee: undefined })
      expect(termsValue("tag-price")).toBe("Waived")
      expect(termsValue("network-funding")).toBe(usd(dai(0.6)))
      expect(termsValue("opening-balance")).toBe(DEPOSIT_TERMS_PENDING)
      await render({ ...earned, sweepFee: undefined })
      expect(termsValue("network-funding")).toBe(DEPOSIT_TERMS_PENDING)
    })
  })

  it("prices the tag above the sweep fee on a standard schedule, the network's share in one row", async () => {
    await render({ fee: dai(4.9), sweepFee: dai(0.5), fpcCut: dai(0.1), total: dai(15) })
    expect(termsValue("tag-price")).toBe(usd(dai(4.4)))
    expect(termsValue("network-fee")).toBeUndefined()
    expect(termsValue("network-funding")).toBe(usd(dai(0.6)))
    expect(termsValue("opening-balance")).toBe(usd(dai(10)))
  })

  it("quotes the same network funding on a free and a paid schedule", async () => {
    await render({ fee: dai(4.9), sweepFee: dai(0.5), fpcCut: dai(0.1), total: dai(15) })
    const paid = termsValue("network-funding")
    await render({
      kind: "earned_tag",
      fee: dai(0.5),
      sweepFee: dai(0.5),
      fpcCut: dai(0.1),
      total: dai(5),
    })
    expect(termsValue("network-funding")).toBe(paid)
  })

  it("withholds the balance while only the funding cut is missing", async () => {
    await render({ fpcCut: undefined })
    expect(termsValue("tag-price")).toBe(usd(dai(4.5)))
    expect(termsValue("network-funding")).toBe(DEPOSIT_TERMS_PENDING)
    expect(termsValue("opening-balance")).toBe(DEPOSIT_TERMS_PENDING)
  })

  it("nets the balance off the fee and the funding cut once both are read", async () => {
    await render({})
    expect(termsValue("opening-balance")).toBe(usd(dai(9.75)))
  })

  it("encodes the quoted total in the pay block, and the shortfall once part has arrived", async () => {
    await render({})
    expect(payBlock()?.getAttribute("data-total")).toBe(String(dai(15)))
    await render({ received: dai(5) })
    expect(payBlock()?.getAttribute("data-total")).toBe(String(dai(10)))
  })

  it("asks for nothing while the total is unsettled: no figure shown, none to pay", async () => {
    await render({ total: undefined, floor: undefined })
    expect(termsValue("total")).toBe(DEPOSIT_TERMS_PENDING)
    expect(payBlock()).toBeNull()
  })

  it("names a part-paid deposit while the total is still unsettled", async () => {
    // An earned tag's total waits on the portal cut. What is already at the address is named
    // meanwhile, so a short deposit is not met with silence.
    await render({
      kind: "earned_tag",
      total: undefined,
      fee: undefined,
      fpcCut: undefined,
      floor: undefined,
      received: dai(4),
    })
    expect(summary()).toContain(`The tag is free. ${seen(dai(4))} received.`)
    expect(payBlock()).toBeNull()
  })

  it("keeps asking rather than reporting a deposit against an unknown floor", async () => {
    await render({ floor: undefined, received: dai(14.7) })
    expect(container.textContent).not.toContain("Deposit received")
    expect(container.textContent).toContain(`${seen(dai(14.7))} of ${due(dai(15))} received`)
  })

  it("acknowledges the whole ask while the floor is still unread", async () => {
    // The ask is priced above any floor it could be weighed against, so a deposit at it is covered
    // whatever the read says. Nothing is left to pay.
    await render({ floor: undefined, received: dai(15) })
    expect(container.textContent).toContain(`Deposit received: ${seen(dai(15))}`)
    expect(container.textContent).not.toContain("Send")
    expect(payBlock()).toBeNull()
  })

  it("adds a line about the arrival for a deposit sent in another stablecoin", async () => {
    const notes = () => container.querySelectorAll(".ww-reg-sheet__warn").length
    await render({})
    expect(notes()).toBe(1)
    await render({ tokenSymbol: "USDC" })
    expect(notes()).toBe(2)
    expect(container.textContent).toContain("USDC")
  })
})
