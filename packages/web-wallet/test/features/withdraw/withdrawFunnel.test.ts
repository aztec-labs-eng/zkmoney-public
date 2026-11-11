import { describe, expect, it, vi } from "vitest"
import {
  createWithdrawFunnel,
  memoryBackend,
  openDatabase,
  type ReportedPhases,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import {
  reportWithdrawFunnel,
  withdrawTransitions,
} from "../../../src/features/withdraw/withdrawFunnel"
import { fireEvent } from "../../../src/lib/analytics"

vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fireEvent: vi.fn(),
}))

function record(over: Partial<WithdrawalRecord>): WithdrawalRecord {
  return {
    localId: "wdraw_a",
    recipient: "0x1111111111111111111111111111111111111111",
    recipientProvenance: "saved-recipient",
    amount: "10",
    tokenSymbol: "DAI",
    phase: "finalizing_l1",
    startTime: 1_000,
    phaseEnteredAt: 61_000,
    ...over,
  } as WithdrawalRecord
}

describe("withdrawTransitions", () => {
  it("reports finalization-ready once, with the confirm→ready duration", () => {
    const first = withdrawTransitions([record({})], {})
    expect(first.events).toEqual([
      { event: "withdraw_finalization_ready", props: { since_confirm_ms: 60_000 } },
    ])
    const second = withdrawTransitions([record({})], first.next)
    expect(second.events).toEqual([])
  })

  it("reports finalized with the L1 wait and total, once", () => {
    const reported: ReportedPhases = { wdraw_a: "finalizing_l1" }
    const done = record({ phase: "done", endTime: 3_661_000 })
    const { events, next } = withdrawTransitions([done], reported)
    expect(events).toEqual([
      { event: "withdraw_finalized", props: { l1_wait_ms: 3_600_000, total_ms: 3_660_000 } },
    ])
    expect(withdrawTransitions([done], next).events).toEqual([])
  })

  it("a swap record counts as finalized at its release, and not again when the swap lands", () => {
    const released = record({ phase: "swapping", swapOutput: "USDC" })
    const { events, next } = withdrawTransitions([released], { wdraw_a: "finalizing_l1" })
    expect(events.map((e) => e.event)).toEqual(["withdraw_finalized"])
    const done = record({ phase: "done", swapOutput: "USDC", endTime: 3_661_000 })
    expect(withdrawTransitions([done], next).events).toEqual([])
  })

  it("prunes ids no longer in the store and keeps marks through a reorg demote", () => {
    const reported: ReportedPhases = { wdraw_gone: "done", wdraw_a: "finalizing_l1" }
    const demoted = record({ phase: "awaiting_proven" })
    const { events, next } = withdrawTransitions([demoted], reported)
    expect(events).toEqual([])
    expect(next).toEqual({ wdraw_a: "finalizing_l1" })
    // Re-entry after the demote does not re-report.
    expect(withdrawTransitions([record({})], next).events).toEqual([])
  })

  it("reports only the user's own cash-outs, and a split withdrawal once, by its funds leg", () => {
    const done = { phase: "done" as const, endTime: 3_661_000 }
    const records = [
      record({ ...done, localId: "sky", skyMove: {} as WithdrawalRecord["skyMove"] }),
      record({ ...done, localId: "link", source: "paylink" }),
      record({ ...done, localId: "reg", intent: "registration" }),
      record({ ...done, localId: "mig", intent: "migration" }),
      record({ ...done, localId: "gas", groupId: "0x01", groupLeg: "gas" }),
      record({ ...done, localId: "funds", groupId: "0x01", groupLeg: "funds" }),
    ]
    const { events, next } = withdrawTransitions(records, {})
    expect(events.map((e) => e.event)).toEqual([
      "withdraw_finalization_ready",
      "withdraw_finalized",
    ])
    expect(next).toEqual({ funds: "done" })
  })

  it("omits durations it cannot compute rather than guessing", () => {
    const { events } = withdrawTransitions(
      [record({ phase: "done", phaseEnteredAt: undefined, endTime: undefined })],
      {},
    )
    expect(events).toEqual([
      { event: "withdraw_finalization_ready", props: { since_confirm_ms: undefined } },
      { event: "withdraw_finalized", props: { l1_wait_ms: undefined, total_ms: undefined } },
    ])
  })
})

describe("reportWithdrawFunnel", () => {
  it("reports each phase once, across a reload and two reports at once", async () => {
    const backend = memoryBackend()
    const funnel = () => createWithdrawFunnel({ db: openDatabase(backend) })
    const fired = vi.mocked(fireEvent)
    fired.mockClear()

    const open = funnel()
    await Promise.all([
      reportWithdrawFunnel([record({})], open),
      reportWithdrawFunnel([record({})], open),
    ])
    expect(fired).toHaveBeenCalledTimes(1)

    await reportWithdrawFunnel([record({})], funnel())
    expect(fired).toHaveBeenCalledTimes(1)
    await reportWithdrawFunnel([record({ phase: "done", endTime: 2_000 })], funnel())
    expect(fired.mock.calls.map(([event]) => event)).toEqual([
      "withdraw_finalization_ready",
      "withdraw_finalized",
    ])
  })
})
