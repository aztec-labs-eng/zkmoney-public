// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import { RELAYER_MAX_PENDING_AGE_MS, selectMoveState } from "../../src/engine/moveState"

const MINED = 10_000
const LATE = MINED + RELAYER_MAX_PENDING_AGE_MS

type Move = Parameters<typeof selectMoveState>[0]
const move = (over: Partial<Move> = {}): Move => ({
  phase: "burned",
  rail: "executor",
  startTime: 0,
  ...over,
})
const burn = (phase: WithdrawalRecord["phase"], over: Partial<WithdrawalRecord> = {}) => ({
  phase,
  startTime: 0,
  minedAt: MINED,
  ...over,
})

describe("selectMoveState", () => {
  it.each([
    ["proving", burn("submitting"), "proving"],
    ["submitting", burn("submitting", { l2TxHash: "0x01" }), "submitting"],
    ["mined", burn("l2_mined"), "pending"],
  ] as const)("reads the burn's %s withdrawal as %s", (_, withdrawal, kind) => {
    expect(selectMoveState(move(), withdrawal, LATE).kind).toBe(kind)
  })

  it("reads a failed burn's failure, not the move's", () => {
    const failure = { code: "withdrawal.dropped" } as const
    expect(selectMoveState(move(), burn("failed", { failure }), MINED)).toEqual({
      kind: "failed",
      failure,
    })
  })

  it("marks the relayer's drop at its max pending age", () => {
    expect(selectMoveState(move(), burn("finalizing_l1"), LATE - 1).kind).toBe("pending")
    expect(selectMoveState(move(), burn("finalizing_l1"), LATE)).toEqual({
      kind: "delayed",
      reason: "relayerDropped",
      dropped: true,
    })
  })

  it("counts the wait from the burn's start when it was never seen mined", () => {
    const unseen = burn("finalizing_l1", { minedAt: undefined, startTime: MINED + 1 })
    expect(selectMoveState(move(), unseen, LATE).kind).toBe("pending")
    expect(selectMoveState(move(), unseen, LATE + 1).kind).toBe("delayed")
  })

  it("waits on whoever runs the escrow once its burn is spent, on the escrow rail only", () => {
    expect(selectMoveState(move({ rail: "executor" }), burn("done"), LATE).kind).toBe("pending")
    expect(selectMoveState(move({ rail: "skyEscrow" }), burn("done"), LATE)).toEqual({
      kind: "delayed",
      reason: "relayerDropped",
      dropped: true,
    })
  })

  it.each([
    ["burning", "proving"],
    ["burned", "pending"],
    ["released", "pending"],
    ["migrated", "done"],
    ["recovered", "recovered"],
    ["dropped", "dropped"],
  ] as const)("reads a %s move with no burn record as %s", (phase, kind) => {
    expect(selectMoveState(move({ phase }), undefined, LATE).kind).toBe(kind)
  })

  it("reads a replayed burn's wait from its own start time", () => {
    const replayed = (over: Partial<Move>) =>
      move({ startTime: MINED, replayedFrom: "0x0b", ...over })
    expect(selectMoveState(replayed({}), undefined, LATE - 1).kind).toBe("pending")
    expect(selectMoveState(replayed({}), undefined, LATE)).toEqual({
      kind: "delayed",
      reason: "relayerDropped",
      dropped: true,
    })
  })

  it("reads the move's own phases over its burn", () => {
    expect(selectMoveState(move({ phase: "claimed" }), burn("done"), MINED).kind).toBe("done")
    const proven = burn("finalizing_l1")
    expect(selectMoveState(move({ phase: "depositSeen" }), proven, LATE).kind).toBe("pending")
    const failure = { code: "withdrawal.interrupted" } as const
    expect(selectMoveState(move({ phase: "failed", failure }), burn("submitting"), MINED)).toEqual({
      kind: "failed",
      failure,
    })
  })
})
