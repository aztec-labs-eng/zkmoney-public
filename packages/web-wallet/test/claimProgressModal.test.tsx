/**
 * The visitor's post-mine sheet: one waiting state for every Ethereum leg, then the claimed detail
 * with the L1 hash linked out.
 */
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  GradientSpinner: () => <div data-testid="spinner" />,
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
}))
vi.mock("../src/ui/detailRows", () => ({
  l1TxUrl: (hash: string) => `https://etherscan.io/tx/${hash}`,
  whenLabel: () => "Today, 14:32",
}))
vi.mock("../src/ui/screens/WithdrawalDetailModal", () => ({
  withdrawalStatus: (r: { phase: string }) =>
    r.phase === "done"
      ? { label: "Paid", badge: "awaitingClaim" }
      : { label: "Releasing on Ethereum", badge: "pending" },
}))
vi.mock("../src/ui/screens/DepositStatusValue", () => ({
  DepositStatusValue: ({ label }: { label: string }) => <b>{label}</b>,
}))

const { ClaimProgressModal } = await import("../src/features/paylink/ClaimProgressModal")

const record = (over: Record<string, unknown> = {}) =>
  ({
    localId: "w1",
    recipient: `0x${"ab".repeat(20)}`,
    recipientProvenance: "saved-recipient",
    amount: "19.9",
    rawAmount: "20000000000000000000",
    relayerTip: "100000000000000000",
    fpcFundingCut: "0",
    tokenSymbol: "zkUSD",
    phase: "finalizing_l1",
    startTime: 0,
    ...over,
  } as never)

let container: HTMLDivElement
let root: Root
const onClose = vi.fn()

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  onClose.mockReset()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("ClaimProgressModal", () => {
  it("waits on the Ethereum legs with the live status", () => {
    act(() => root.render(<ClaimProgressModal record={record()} memo="Pizza" onClose={onClose} />))
    expect(container.textContent).toContain("Claiming payment")
    expect(container.textContent).toContain("Releasing on Ethereum")
    expect(container.querySelector('[data-testid="spinner"]')).toBeTruthy()
    expect(container.textContent).not.toContain("View on Etherscan")
  })

  it("names the held DAI, not a receipt, while a swap awaits recovery", () => {
    act(() =>
      root.render(
        <ClaimProgressModal
          record={record({
            phase: "recoverable",
            swapOutput: "USDC",
            swapEscrow: `0x${"ee".repeat(20)}`,
            fpcFundingCut: "50000000000000000",
            swapRelayerTip: "200000000000000000",
            swapEstimatedOut: "19400000",
            swapOutputDecimals: 6,
          })}
          onClose={onClose}
        />,
      ),
    )
    expect(container.textContent).toContain("Claim needs recovery")
    expect(container.textContent).not.toContain("You received")
    expect(container.textContent).not.toContain("USDC")
    expect(container.textContent).toContain("Amount")
    expect(container.textContent).toContain("DAI")
    // 20 − 0.10 withdrawal relayer tip − 0.05 FPC cut − 0.20 swap relayer tip: what the escrow holds.
    expect(container.textContent).toContain("$19.65")
    expect(container.textContent).not.toContain("$19.90")
  })

  it("points a recovered swap at the recovery target", () => {
    const target = `0x${"77".repeat(20)}`
    act(() =>
      root.render(
        <ClaimProgressModal
          record={record({
            phase: "recovered",
            swapOutput: "USDC",
            fpcFundingCut: "50000000000000000",
            swapRelayerTip: "200000000000000000",
            recoveryTarget: target,
            recoveryTxHash: `0x${"aa".repeat(32)}`,
          })}
          onClose={onClose}
        />,
      ),
    )
    expect(container.textContent).toContain("Claim recovered")
    expect(container.textContent).toContain("$19.65")
    expect(container.textContent).toContain("Recovered to")
    expect(container.textContent).toContain(`${target.slice(0, 6)}…${target.slice(-4)}`)
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      `https://etherscan.io/tx/0x${"aa".repeat(32)}`,
    )
  })

  it("shows the claimed detail with the L1 release linked out", () => {
    act(() =>
      root.render(
        <ClaimProgressModal
          record={record({ phase: "done", finalizeTxHash: `0x${"cd".repeat(32)}`, endTime: 1 })}
          memo="Pizza"
          onClose={onClose}
        />,
      ),
    )
    expect(container.textContent).toContain("Payment claimed")
    expect(container.textContent).toContain("$19.90")
    expect(container.textContent).toContain("Pizza")
    expect(container.textContent).toContain("Paid")
    const link = container.querySelector("a")!
    expect(link.textContent).toContain("View on Etherscan")
    expect(link.getAttribute("href")).toBe(`https://etherscan.io/tx/0x${"cd".repeat(32)}`)
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click())
    expect(onClose).toHaveBeenCalledOnce()
  })
})
