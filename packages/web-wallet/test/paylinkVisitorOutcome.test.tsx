import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WithdrawalRecord } from "@obsidion/front-core"
import type { PaymentLink } from "../src/features/paylink/types"

const m = vi.hoisted(() => ({
  cashOut: vi.fn(),
  fireEvent: vi.fn(),
  error: vi.fn(),
  uses: 1,
  records: [] as WithdrawalRecord[],
  listeners: new Set<(records: WithdrawalRecord[]) => void>(),
  deps: {},
}))
const store = {
  load: async () => {},
  list: () => m.records,
  failInterruptedSubmissions: async () => [],
  onListChanged: (listener: (records: WithdrawalRecord[]) => void) => {
    m.listeners.add(listener)
    return () => {
      m.listeners.delete(listener)
    }
  },
}
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => ({}),
}))
// Keep the real useLinkWithdrawal, useWithdrawals and useCachedRecords subscriptions.
vi.mock("../src/features/paylink/usePaylinkDeps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/paylink/usePaylinkDeps")>()),
  useLinkVoucher: () => ({ uses: m.uses, deps: m.deps }),
}))
vi.mock("../src/features/withdraw/withdrawGateway", () => ({
  getWithdrawalStore: () => store,
  ensureWithdrawalTracker: vi.fn(),
}))
vi.mock("../src/features/withdraw/withdrawFunnel", () => ({ reportWithdrawFunnel: vi.fn() }))
vi.mock("../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
vi.mock("../src/features/paylink/paylinkExit", () => ({
  cashOutLink: m.cashOut,
  linkWithdrawalIdentity: () => ({ id: "paylink-id" }),
}))
vi.mock("../src/features/paylink/claimStash", () => ({ stashClaimLink: vi.fn() }))
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }))
vi.mock("../src/lib/analytics", () => ({ fireEvent: m.fireEvent }))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: m.error }))
vi.mock("../src/ui/screens/WithdrawalDetailModal", () => ({
  withdrawalStatus: () => ({ label: "Releasing on Ethereum" }),
}))
vi.mock("../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("../src/features/onboarding/OnboardingScreen", () => ({ OnboardingScreen: () => null }))
vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  Spinner: () => null,
  GradientSpinner: () => null,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
}))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))
vi.mock("../src/ui/screening", () => ({
  useScreenedAddress: () => ({ cleared: true, screener: {} }),
  ScreeningNotice: () => null,
}))
vi.mock("../src/features/deposit/l1Wallet", () => ({ useL1Wallet: () => ({}) }))
vi.mock("../src/features/withdraw/WithdrawScreen", () => ({ useSavedL1Wallets: () => [] }))
// A priced direct route: the modal only offers Confirm once the fee is known.
vi.mock("../src/features/withdraw/withdrawQuote", () => ({
  withdrawalFeeDisplay: () => "0.35",
  useSwapSimulation: () => ({
    status: "ready",
    fee: {
      withdrawalRelayerTip: 100_000_000_000_000_000n,
      fpcFundingCut: 250_000_000_000_000_000n,
      swapRelayerTip: 0n,
      floorAtomic: 350_000_000_000_000_000n,
    },
  }),
  swapFloorAtomic: () => 350_000_000_000_000_000n,
  WithdrawalEstimate: () => null,
}))
vi.mock("../src/features/paylink/emailClaim", () => ({ obtainEmailL1Proof: vi.fn() }))
vi.mock("../src/platform/desktopBridge", () => ({ isDesktopL1SubmitActive: () => true }))
vi.mock("../src/ui/format", () => ({ shortAddr: (v: string) => v, usdFigure: (v: string) => v }))

import { PaylinkVisitorScreen } from "../src/features/paylink/PaylinkVisitorScreen"

const recipient = "0x2222222222222222222222222222222222222222"
const record: WithdrawalRecord = {
  localId: "withdrawal-1",
  paylinkId: "paylink-id",
  recipient,
  recipientProvenance: "saved-recipient",
  source: "paylink",
  amount: "24.9",
  tokenSymbol: "DAI",
  startTime: 1_700_000_000_000,
  phase: "submitting",
}
let container: HTMLDivElement
let root: Root
let link: PaymentLink
let resolveCashOut: (record: WithdrawalRecord) => void
let rejectCashOut: (error: Error) => void
const publish = (records: WithdrawalRecord[]) => {
  m.records = records
  for (const listener of m.listeners) listener(records)
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.startsWith(label) || b.getAttribute("aria-label") === label,
  )
const click = async (label: string) => {
  expect(button(label)).toBeDefined()
  await act(async () => button(label)!.click())
}
const outcomes = () =>
  m.fireEvent.mock.calls.filter(
    ([name]) => name === "proving_cancelled" || name === "proving_abandoned",
  )
async function startCashOut() {
  await act(async () => root.render(<PaylinkVisitorScreen link={link} />))
  await click("Claim to an Ethereum wallet")
  const input = container.querySelector('input[placeholder="Paste an address"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      recipient,
    )
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await click("Claim 24.65")
  await click("Confirm and claim 24.65")
  expect(m.cashOut).toHaveBeenCalledOnce()
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  m.records = []
  m.listeners.clear()
  m.uses = 1
  m.cashOut.mockImplementation(
    () =>
      new Promise<WithdrawalRecord>((resolve, reject) => {
        resolveCashOut = resolve
        rejectCashOut = reject
      }),
  )
  link = { fragment: "fragment", url: "", amount: "25", status: "unclaimed", flavor: "direct" }
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("visitor cash-out outcome tracking", () => {
  it("keeps the real claim modal mounted across withdrawal updates until completion", async () => {
    await startCashOut()
    await act(async () => publish([record]))
    expect(container.textContent).toContain("Preparing transaction")
    expect(outcomes()).toEqual([])

    // The voucher and link status can also refresh before the cash-out promise settles.
    m.uses = 0
    link = { ...link, status: "claimed" }
    await act(async () => root.render(<PaylinkVisitorScreen link={link} />))
    expect(container.textContent).toContain("Preparing transaction")
    await act(async () => resolveCashOut(record))
    expect(container.textContent).not.toContain("Preparing transaction")
    expect(container.textContent).toContain("You withdrew")
    await act(async () => root.render(null))
    expect(outcomes()).toEqual([])
  })

  it("still reports real navigation while the cash-out is pending", async () => {
    await startCashOut()
    await act(async () => publish([record]))
    expect(outcomes()).toEqual([])
    await act(async () => root.render(null))
    expect(outcomes()).toEqual([
      ["proving_cancelled", { flow: "paylink-claim-l1", stage: "building" }],
    ])
    await act(async () => resolveCashOut(record))
    expect(outcomes()).toHaveLength(1)
  })

  it("returns to confirmation after a failed cash-out without reporting cancellation", async () => {
    await startCashOut()
    await act(async () => publish([record]))
    const error = new Error("Cash-out failed")
    await act(async () => {
      publish([{ ...record, phase: "failed" }])
      rejectCashOut(error)
    })
    expect(m.error).toHaveBeenCalledWith(error, "paylink:claim-l1")
    expect(button("Confirm and claim 24.65")).toBeDefined()
    await act(async () => root.render(null))
    expect(outcomes()).toEqual([])
  })
})
