/** A stranded or unreleased Savings move offers its way out; the detail view decides it. */
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SavingsMoveRecord, WithdrawalRecord } from "@obsidion/front-core"

vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  ActivityListRow: ({
    counterparty,
    timestamp,
    statusLabel,
    amount,
  }: {
    counterparty: string
    timestamp: string
    statusLabel?: string
    amount: string
  }) => (
    <div className="row">
      {counterparty} <small>{timestamp}</small> {statusLabel} {amount}
    </div>
  ),
  Spinner: () => null,
  GradientText: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
}))
vi.mock("../../../src/ui/Modal", () => ({
  Modal: ({ children, label }: { children: ReactNode; label: string }) => (
    <div role="dialog" aria-label={label}>
      {children}
    </div>
  ),
}))
vi.mock("../../../src/features/operations/TabLine", () => ({ TabLine: () => null }))
const sources = vi.hoisted(() => ({ list: [] as { savings: boolean }[] }))
vi.mock("../../../src/features/migration/oldVersionWithdraw", () => ({
  useWithdrawableSources: () => sources.list,
}))
import { SavingsMoveDetailModal } from "../../../src/features/savings/SavingsMoveDetailModal"
import { closeSession } from "../../../src/session/session"
import { openTestSession } from "../../support/session"

const ONE = 10n ** 18n
const move = (extra: Partial<SavingsMoveRecord> = {}): SavingsMoveRecord =>
  ({
    direction: "in",
    withdrawalLocalId: "w1",
    escrow: "0x00000000000000000000000000000000000000ee",
    nonce: `0x${"03".repeat(32)}`,
    recipientCommitment: `0x${"01".repeat(32)}`,
    amount: (25n * ONE).toString(),
    startTime: 1_700_000_000_000,
    value: (25n * ONE).toString(),
    net: ((2335n * ONE) / 100n).toString(),
    ...extra,
  } as SavingsMoveRecord)
const burn = (phase: WithdrawalRecord["phase"]) =>
  ({ localId: "w1", phase, l2TxHash: `0x${"5a".repeat(32)}` } as WithdrawalRecord)

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  openTestSession()
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  closeSession()
  host.remove()
  sources.list = []
})

describe("SavingsMoveDetailModal", () => {
  it.each([
    ["no old Savings source", [], undefined],
    ["an escrow that never ran", [{ savings: true }], undefined],
    [
      "a Main source for a move into Savings",
      [{ savings: false }],
      { inboxIndex: "1", amount: "1", claimed: false },
    ],
  ])(
    "says an old version closed before the move finished, without Withdraw for %s",
    (_, list, deposit) => {
      sources.list = list
      act(() =>
        root.render(
          <SavingsMoveDetailModal
            move={move({ retired: true, deposit })}
            burn={burn("done")}
            onWithdraw={() => {}}
            onClose={() => {}}
          />,
        ),
      )
      expect(host.textContent).toContain("Didn't finish")
      expect(host.textContent).toContain("This version can't return them yet.")
      expect([...host.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
        "Withdraw",
      )
    },
  )

  it("offers Withdraw for a stranded move whose deposit reached an old Savings portal", () => {
    sources.list = [{ savings: true }]
    const onWithdraw = vi.fn()
    const deposit = { inboxIndex: "1", amount: "1", claimed: false }
    act(() =>
      root.render(
        <SavingsMoveDetailModal
          move={move({ retired: true, deposit })}
          burn={burn("done")}
          onWithdraw={onWithdraw}
          onClose={() => {}}
        />,
      ),
    )
    expect(host.textContent).toContain("Withdraw sends them to an Ethereum address.")
    act(() =>
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Withdraw")!.click(),
    )
    expect(onWithdraw).toHaveBeenCalled()
  })

  it("offers the exit it is given for a burn the relayer has not released", () => {
    const onStart = vi.fn()
    act(() =>
      root.render(
        <SavingsMoveDetailModal
          move={move()}
          burn={burn("finalizing_l1")}
          exit={{ title: "Finalize manually", onStart }}
          onClose={() => {}}
        />,
      ),
    )
    const finalize = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Finalize manually",
    )!
    act(() => finalize.click())
    expect(onStart).toHaveBeenCalledOnce()
  })
})
