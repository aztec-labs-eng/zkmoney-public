// @vitest-environment node
/**
 * The Savings settle pass is a session task: while a move waits on it, it passes at once, every
 * 30 s, shown or hidden, and when the page is shown again. Its passes run one at a time.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { memoryStore, startRuntime, type SavingsSource, type SettleDue } from "@obsidion/front-core"
import { savingsSettle } from "../../../src/features/savings/savingsTasks"
import {
  fakeClock,
  flush,
  later,
  sessions,
  table,
} from "../../../../front-core/test/engine/taskTable"

const TICK = 30_000
const ends: (() => void)[] = []
fakeClock()
afterEach(() => ends.splice(0).forEach((end) => end()))

function harness() {
  const h = sessions(startRuntime)
  ends.push(h.end)
  const savings = later<SavingsSource | null>("savings")
  const settle = vi.fn(async (_signal: AbortSignal) => {})
  const due = memoryStore<SettleDue>({ due: false, unadopted: 0 })
  h.tasks.push(savingsSettle(savings.service, due.readonly))
  const ready = () => savings.ready({ settle } as never)
  const waits = (next: boolean) => due.set({ due: next, unadopted: 0 })
  return { h, savings, settle, ready, waits }
}

describe("savingsSettle", () => {
  it("passes when a move starts waiting, then every 30 s while it waits, hidden too", async () => {
    const s = harness()
    await table(
      [
        ["start, Savings pending", s.h.start, TICK, 0],
        ["Savings is ready", s.ready, 0, 0],
        ["nothing waits", () => {}, 3 * TICK, 0],
        ["a move waits", () => s.waits(true), 0, 1],
        ["it waits on", () => {}, TICK, 2],
        ["hidden", s.h.hide, 2 * TICK, 4],
        ["stop", s.h.stop, 2 * TICK, 4],
        ["restart", s.h.start, 0, 5],
        ["nothing waits again", () => s.waits(false), 3 * TICK, 5],
      ],
      () => s.settle.mock.calls.length,
    )
  })

  it("passes when the page is shown again while a move waits", async () => {
    const s = harness()
    s.ready()
    s.waits(true)
    await table(
      [
        ["start", s.h.start, 0, 1],
        ["hidden", s.h.hide, 0, 1],
        ["shown again", s.h.show, 0, 2],
      ],
      () => s.settle.mock.calls.length,
    )
  })

  it("stops its pass once nothing waits, so the next pass starts at once", async () => {
    const s = harness()
    // A pass that ends only when its run aborts it.
    s.settle.mockImplementationOnce(
      (signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
    )
    s.ready()
    s.waits(true)
    s.h.start()
    await flush()
    s.waits(false)
    await flush()
    s.waits(true)
    await flush()
    expect(s.settle).toHaveBeenCalledTimes(2)
  })

  it("starts no pass while a pass a replaced source left running goes on", async () => {
    const s = harness()
    let finish!: () => void
    const first = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    s.savings.ready({ settle: first } as never)
    s.waits(true)
    s.h.start()
    await flush()
    expect(first).toHaveBeenCalledTimes(1)
    s.ready()
    await flush()
    expect(s.settle).not.toHaveBeenCalled()
    finish()
    await flush()
    expect(s.settle).toHaveBeenCalledTimes(1)
  })

  it("fails its run when a pass fails, and passes again after a growing backoff", async () => {
    const s = harness()
    s.settle
      .mockRejectedValueOnce(new Error("moves unreadable"))
      .mockRejectedValueOnce(new Error("moves unreadable"))
    s.ready()
    s.waits(true)
    await table(
      [
        ["start, the pass fails", s.h.start, TICK - 1, 1],
        ["the first retry fails", () => {}, 1, 2],
        ["the backoff doubles", () => {}, 2 * TICK - 1, 2],
        ["the second retry passes", () => {}, 1, 3],
        ["it waits on", () => {}, TICK, 4],
      ],
      () => s.settle.mock.calls.length,
    )
  })

  it("never passes where the profile has no Savings", async () => {
    const s = harness()
    s.waits(true)
    s.savings.ready(null)
    s.h.start()
    await vi.advanceTimersByTimeAsync(3 * TICK)
    expect(s.settle).not.toHaveBeenCalled()
  })
})
