/** Guards: the sheet takes a deposit over the floor, asks the whole ask, then the shortfall. */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RegistrationKind } from "@obsidion/core/types"
import { LIMIT, LIMIT_USD } from "../../../support/publicLimit"

vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  ConfirmationSheetDetailRow: ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      {label}:{value}
    </div>
  ),
}))
vi.mock("../../../../src/features/onboarding/OnboardingCard", () => ({
  OnboardingCard: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock(
  "../../../../src/features/onboarding/steps/DepositAddress/DepositAddress",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../src/features/onboarding/steps/DepositAddress/DepositAddress")
    >()),
    DepositAddressRow: ({ overLimit }: { overLimit?: string }) => (
      <div data-testid="address-row" data-over-limit={overLimit ?? ""} />
    ),
    DepositPayBlock: ({
      total,
      note,
      overLimit,
    }: {
      total: bigint
      note?: React.ReactNode
      overLimit?: string
    }) => (
      <div data-testid="pay-block" data-total={String(total)} data-over-limit={overLimit ?? ""}>
        {note}
      </div>
    ),
  }),
)

// The mainnet table: DAI settles, USDC and USDT are swapped into it. `usdcFee`: a table whose fee token is USDC.
const table = vi.hoisted(() => ({ usdcFee: false }))
vi.mock("../../../../src/features/sipa/loadDepositFacts", async (importOriginal) => {
  const { mainnetTokens, mockLoadDepositFacts, usdcFeeTokens } = await import(
    "../../../support/depositTokens"
  )
  return mockLoadDepositFacts(importOriginal, () =>
    table.usdcFee ? usdcFeeTokens() : mainnetTokens(),
  )
})

vi.mock("../../../../src/features/token/useTxAmountCap", () => ({
  useTxAmountCap: () => 10_000n * 10n ** 18n,
  useRowTxAmountCap: () => 10_000n * 10n ** 18n,
}))

const { RegistrationSheet } = await import(
  "../../../../src/features/onboarding/RegistrationSheet/RegistrationSheet"
)
const { DEPOSIT_TERMS_PENDING } = await import(
  "../../../../src/features/deposit/DepositTermsRows/DepositTermsRows"
)
const { formatDepositDue, formatDepositSeen } = await import(
  "../../../../src/features/registration/depositAmounts"
)
const { closeSession } = await import("../../../../src/session/session")
const { openTestSession } = await import("../../../support/session")
beforeEach(() => void openTestSession())
afterEach(closeSession)

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
/** Figures are built from the formatters the sheet prices with, never from its sentences. */
const due = (amount: bigint) => formatDepositDue(amount, 18)
const seen = (amount: bigint) => formatDepositSeen(amount, 18)
/** A standard schedule under the asked deposit: a 14.5 floor, a 15 total. */
const address = `0x${"ab".repeat(20)}` as const
const payment = {
  chainLabel: "Sepolia",
  address,
  token: `0x${"cd".repeat(20)}` as `0x${string}`,
  chainId: 11155111,
  total: dai(15) as bigint | undefined,
  fee: dai(5) as bigint | undefined,
  sweepFee: dai(0.5) as bigint | undefined,
  floor: dai(14.5) as bigint | undefined,
  kind: "standard" as RegistrationKind,
  tokenSymbol: "DAI",
  tokenDecimals: 18,
}

let container: HTMLDivElement
let root: Root

const termsValue = (id: string) =>
  container.querySelector(`[data-testid="deposit-terms-${id}"]`)?.textContent ?? undefined
const payBlock = () => container.querySelector('[data-testid="pay-block"]')

const render = (over: Partial<typeof payment> & { received?: bigint }) =>
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
  table.usdcFee = false
})

describe("the sheet asks the quoted deposit and settles on the floor", () => {
  it("takes a deposit that clears the floor without reaching the ask", async () => {
    await render({ received: dai(14.7) })
    expect(container.textContent).toContain(seen(dai(14.7)))
    expect(container.textContent).not.toContain("Send at least")
  })

  it("asks the full total before any chain read lands", async () => {
    await render({ fee: undefined, sweepFee: undefined, floor: undefined })
    expect(termsValue("total")).toBe(due(dai(15)))
    // Every figure derived from the reads waits for them rather than guessing.
    expect(termsValue("tag-price")).toBe(DEPOSIT_TERMS_PENDING)
    expect(termsValue("network-funding")).toBe(DEPOSIT_TERMS_PENDING)
    expect(termsValue("opening-balance")).toBe(DEPOSIT_TERMS_PENDING)
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
})

describe("a table whose fee token is USDC", () => {
  it("asks for USDC, with no swap line and no DAI", async () => {
    table.usdcFee = true
    await render({ tokenSymbol: "USDC" })
    const funding = container.querySelector('[data-testid="registration-sheet-funding"]')
    expect(funding?.textContent).toContain("USDC")
    expect(container.querySelectorAll('[data-testid="registration-swap-warning"]').length).toBe(0)
    expect(container.textContent).not.toContain("DAI")
  })
})

describe("the sheet's per-deposit limit", () => {
  const overLimit = (id: string) =>
    container.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-over-limit")

  it(`holds copy and payment for an ask over ${LIMIT_USD}, the whole ask counted`, async () => {
    // Part has arrived, so the pay block asks only the rest; the limit still counts the whole ask.
    await render({ total: dai(LIMIT) + 1n, floor: dai(LIMIT), received: dai(1000) })
    expect(overLimit("address-row")).toBe("public")
    expect(overLimit("pay-block")).toBe("public")
    expect(payBlock()?.getAttribute("data-total")).toBe(String(dai(LIMIT - 1000) + 1n))
  })
})
