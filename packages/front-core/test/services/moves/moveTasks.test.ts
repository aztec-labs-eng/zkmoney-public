// @vitest-environment node
import { createPace } from "@obsidion/core/cadence"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getAddress } from "viem"
import { recoverableRails, selectMoveRecoverable } from "../../../src/core/services/moves/openMoves"
import { replayMoves } from "../../../src/core/services/moves/replayMoves"
import { settleMoves } from "../../../src/core/services/moves/settleMoves"
import { openDatabase } from "../../../src/engine/database"
import { memoryBackend } from "../../../src/engine/memoryBackend"
import type { Milestone } from "../../../src/engine/milestones"
import { RELAYER_MAX_PENDING_AGE_MS } from "../../../src/engine/moveState"
import { startRuntime, type Runtime, type Task } from "../../../src/engine/runtime"
import { fixed } from "../../../src/engine/service"
import { memoryStore } from "../../../src/engine/store"
import { table } from "../../engine/taskTable"
import { DAI_PORTAL, SKY_HOLDING, VAULT_HOLDING } from "./fixtures"
import { moveWorld, runRoute, type MoveWorld } from "./moveWorld"

const runtimes: Runtime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop()
})

function start(tasks: Task[], visible = memoryStore(true)) {
  const runtime = startRuntime(tasks, {
    db: openDatabase(memoryBackend()),
    milestones: { after: async () => true, reached: () => true },
    visible: visible.readonly,
    pace: createPace(),
    now: () => Date.now(),
    sinceLoad: () => performance.now(),
  })
  runtimes.push(runtime)
  return runtime
}

const settleTask = (world: MoveWorld) =>
  settleMoves({
    ...world.deps,
    refreshBalance: async () => undefined,
    ports: fixed("ports", world.ports),
  })

function run(world: MoveWorld, marked: Milestone[]) {
  const ports = fixed("ports", world.ports)
  const milestones = { mark: (m: Milestone) => void marked.push(m) }
  const settle = settleTask(world)
  const replay = replayMoves({ ...world.deps, ports, milestones, settle })
  return { runtime: start([replay, settle]), settle }
}

describe("the moves' tasks", () => {
  it("replay a fresh device's moves, mark them replayed, and settle what they rebuilt", async () => {
    const first = await moveWorld()
    const made = await first.service.add(SKY_HOLDING.id, 100n, "op-1")
    await runRoute(first, made, { assets: 97n, deposit: 90n })
    const fresh = await moveWorld({ l1: first.l1, account: first.account })
    const marked: Milestone[] = []

    const { runtime, settle } = run(fresh, marked)
    await vi.waitFor(() => expect(marked).toEqual(["movesReplayed"]))
    await runtime.wake(settle)
    const [move] = (await fresh.moves.view.get()).records
    expect(move?.phase).toBe("claimed")
  })

  it("replay again once a rail binds, so a fresh device rebuilds a vault move it can recover", async () => {
    const amount = 1_000n * 10n ** 18n
    const first = await moveWorld({ rail: "executor", balances: { [DAI_PORTAL]: amount } })
    const made = await first.service.add(VAULT_HOLDING.id, amount, "op-1")
    const fresh = await moveWorld({
      rail: "executor",
      unbound: true,
      l1: first.l1,
      account: first.account,
    })
    const marked: Milestone[] = []

    run(fresh, marked)
    await vi.waitFor(() => expect(marked).toEqual(["movesReplayed"]))
    expect((await fresh.moves.view.get()).records).toEqual([])
    fresh.bind()
    await vi.waitFor(() => expect(marked).toEqual(["movesReplayed", "movesReplayed"]))
    const [move] = (await fresh.moves.view.get()).records
    if (!move) throw new Error("the move is not rebuilt")
    expect(move).toMatchObject({ nonce: made.nonce, phase: "burned" })
    expect(selectMoveRecoverable(move, recoverableRails(fresh.ports.rails.get()))).toBe(true)
    fresh.clock.now += RELAYER_MAX_PENDING_AGE_MS
    await fresh.service.recover(move.id, getAddress(`0x${"70".repeat(20)}`))
    expect((await fresh.read(move.id)).phase).toBe("recovered")
  })

  it("replay a burn the node indexed late on the backoff, after marking the milestone", async () => {
    vi.useFakeTimers()
    try {
      const first = await moveWorld()
      const made = await first.service.add(SKY_HOLDING.id, 100n, "op-1")
      const hash = (await first.withdrawals.get(made.withdrawalLocalId ?? ""))?.l2TxHash ?? ""
      first.l1.unread.add(hash)
      const fresh = await moveWorld({ l1: first.l1, account: first.account })
      const marked: Milestone[] = []

      run(fresh, marked)
      await vi.waitFor(() => expect(marked).toEqual(["movesReplayed"]))
      expect((await fresh.moves.view.get()).records).toEqual([])
      first.l1.unread.delete(hash)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      const [move] = (await fresh.moves.view.get()).records
      expect(move?.nonce).toBe(made.nonce)
    } finally {
      vi.useRealTimers()
    }
  })

  it("settle every 10 s, and every 30 s while the tab is hidden", async () => {
    let passes = 0
    const world = await moveWorld({
      routes: (routes) => ({ ...routes, head: async () => (passes++, routes.head()) }),
    })
    await world.service.add(SKY_HOLDING.id, 100n, "op-1")
    const visible = memoryStore(true)
    vi.useFakeTimers()
    try {
      passes = 0
      await table(
        [
          ["start", () => void start([settleTask(world)], visible), 0, 1],
          ["visible", () => {}, 10_000, 2],
          ["hidden: the visible timer stands", () => visible.set(false), 10_000, 3],
          ["hidden: 30 s apart", () => {}, 29_999, 3],
          ["hidden pace", () => {}, 1, 4],
          ["show", () => visible.set(true), 0, 5],
        ],
        () => passes,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("keep settling every 10 s while one move's claim faults", async () => {
    const first = await moveWorld()
    let attempts = 0
    const world = await moveWorld({
      l1: first.l1,
      account: {
        ...first.account,
        claim: async () => {
          attempts++
          throw new Error("the claim faulted")
        },
      },
    })
    const move = await world.service.add(SKY_HOLDING.id, 100n, "op-1")
    await runRoute(world, move, { assets: 97n, deposit: 90n })
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await table(
        [
          ["start", () => void start([settleTask(world)]), 0, 1],
          ["10 s", () => {}, 10_000, 2],
          ["20 s", () => {}, 10_000, 3],
          ["30 s", () => {}, 10_000, 4],
        ],
        () => attempts,
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
