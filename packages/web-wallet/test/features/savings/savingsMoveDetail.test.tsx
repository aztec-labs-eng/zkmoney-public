/** A stranded or unreleased Savings move offers its way out; the detail view decides it. */
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  selectMoveState,
  type MoveDeposit,
  type MoveQuote,
  type MoveRecord,
  type WithdrawalRecord,
} from "@obsidion/front-core"

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
import { moveRecord } from "../../support/moves"
import { openTestSession } from "../../support/session"

const ONE = 10n ** 18n
const T0 = 1_700_000_000_000
const move = (extra: Partial<MoveRecord> = {}) =>
  moveRecord({
    amount: 25n * ONE,
    startTime: T0,
    quote: { expectedOut: 25n * ONE, conversionOut: (2335n * ONE) / 100n } as MoveQuote,
    ...extra,
  })
const burn = (phase: WithdrawalRecord["phase"]) =>
  ({ localId: "w1", phase, l2TxHash: `0x${"5a".repeat(32)}`, startTime: T0 } as WithdrawalRecord)
const deposited: MoveDeposit = { inboxIndex: 1n, amount: ONE, at: T0 }
/** The modal's props for `record` and its burn, in the state they put the move in. */
const shown = (record: MoveRecord, withdrawal: WithdrawalRecord) => ({
  move: record,
  state: selectMoveState(record, withdrawal, T0),
  burn: withdrawal,
})

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
    ["a Main source for a move into Savings", [{ savings: false }], deposited],
  ])(
    "says an old version closed before the move finished, without Withdraw for %s",
    (_, list, deposit) => {
      sources.list = list
      act(() =>
        root.render(
          <SavingsMoveDetailModal
            {...shown(move({ phase: "migrated", deposit }), burn("done"))}
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
    act(() =>
      root.render(
        <SavingsMoveDetailModal
          {...shown(move({ phase: "migrated", deposit: deposited }), burn("done"))}
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
          {...shown(move(), burn("finalizing_l1"))}
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
