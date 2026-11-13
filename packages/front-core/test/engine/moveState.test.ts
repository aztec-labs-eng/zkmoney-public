// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import { RELAYER_MAX_PENDING_AGE_MS, selectMoveState } from "../../src/engine/moveState"
import type { MoveQuote } from "../../src/engine/moveTransition"

const MINED = 10_000
const LATE = MINED + RELAYER_MAX_PENDING_AGE_MS
const LIMITS = { maxDeposit: 1_000n, maxRedeem: 1_000n }

const QUOTE: MoveQuote = {
  routed: 100n,
  relayerTip: 2n,
  conversionOut: 100n,
  conversionMinOut: 99n,
  expectedOut: 100n,
  minOut: 99n,
  withdrawalFee: 0n,
}

type Move = Parameters<typeof selectMoveState>[0]
const move = (over: Partial<Move> = {}): Move => ({
  phase: "burned",
  rail: "executor",
  direction: "out",
  amount: 102n,
  quote: QUOTE,
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
    const observed = { at: MINED, ...LIMITS }
    expect(selectMoveState(move({ observed }), withdrawal, LATE).kind).toBe(kind)
  })

  it("reads a failed burn's failure, not the move's", () => {
    const failure = { code: "withdrawal.dropped" } as const
    expect(selectMoveState(move(), burn("failed", { failure }), MINED)).toEqual({
      kind: "failed",
      failure,
    })
  })

  it.each([
    ["out", "maxRedeem", 99n, { kind: "delayed", reason: "illiquidVault", dropped: false }],
    ["out", "maxRedeem", 100n, { kind: "pending" }],
    ["out", "maxRedeem", 101n, { kind: "pending" }],
    ["in", "maxDeposit", 99n, { kind: "delayed", reason: "vaultFull", dropped: false }],
    ["in", "maxDeposit", 100n, { kind: "pending" }],
  ] as const)("holds a move %s with %s %s to the routed amount", (direction, key, limit, state) => {
    const observed = { at: MINED, ...LIMITS, [key]: limit }
    expect(selectMoveState(move({ direction, observed }), burn("finalizing_l1"), MINED)).toEqual(
      state,
    )
  })

  it("bounds a move in by what its conversion delivers, in the vault's asset", () => {
    // 1,000 DAI (18 decimals) converts to 1,000 USDC (6 decimals) for a USDC vault.
    const DAI = 10n ** 18n
    const USDC = 10n ** 6n
    const quote = { ...QUOTE, routed: 1_000n * DAI, conversionOut: 1_000n * USDC }
    const into = (maxDeposit: bigint) =>
      selectMoveState(
        move({ direction: "in", quote, observed: { at: MINED, ...LIMITS, maxDeposit } }),
        burn("finalizing_l1"),
        MINED,
      )
    expect(into(1_000n * USDC)).toEqual({ kind: "pending" })
    expect(into(1_000n * USDC - 1n)).toEqual({
      kind: "delayed",
      reason: "vaultFull",
      dropped: false,
    })
  })

  it("keeps a Sky move's delays: its conversion is one to one moving in", () => {
    const sky = { ...QUOTE, routed: 100n, conversionOut: 100n }
    const at = (direction: "in" | "out", limit: bigint) =>
      selectMoveState(
        move({
          rail: "skyEscrow",
          direction,
          quote: sky,
          observed: { at: MINED, maxDeposit: limit, maxRedeem: limit },
        }),
        burn("finalizing_l1"),
        MINED,
      )
    expect(at("in", 99n)).toEqual({ kind: "delayed", reason: "vaultFull", dropped: false })
    expect(at("in", 100n)).toEqual({ kind: "pending" })
    expect(at("out", 99n)).toEqual({ kind: "delayed", reason: "illiquidVault", dropped: false })
    expect(at("out", 100n)).toEqual({ kind: "pending" })
  })

  it("marks the relayer's drop at its max pending age, delaying a move with no reason left", () => {
    const illiquid = { at: LATE, ...LIMITS, maxRedeem: 0n }
    expect(selectMoveState(move({ observed: illiquid }), burn("finalizing_l1"), LATE)).toEqual({
      kind: "delayed",
      reason: "illiquidVault",
      dropped: true,
    })
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

  it("reads a replayed burn's wait from its own start time, its amount for the quote", () => {
    const observed = { at: MINED, ...LIMITS, maxRedeem: 101n }
    const replayed = (over: Partial<Move>) =>
      move({ startTime: MINED, quote: undefined, replayedFrom: "0x0b", ...over })
    expect(selectMoveState(replayed({ observed }), undefined, MINED)).toEqual({
      kind: "delayed",
      reason: "illiquidVault",
      dropped: false,
    })
    // Moving in, the burn's amount is in the base token, not the vault's asset: no bound.
    const full = { at: MINED, ...LIMITS, maxDeposit: 0n }
    expect(
      selectMoveState(replayed({ direction: "in", observed: full }), undefined, MINED),
    ).toEqual({ kind: "pending" })
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
