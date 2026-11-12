// @vitest-environment node
/**
 * Settings → Account history as the session's previous-account state reads: whether there is an
 * event, where its check stands, and what a find offers.
 */
import { describe, expect, it } from "vitest"
import type { BackupRotationPhase, BackupRotationRecord } from "@obsidion/front-core"
import {
  selectAccountHistory,
  selectHeldTotal,
  selectHistoryRow,
  selectMoveUnfinished,
} from "../../../src/features/backupPasskey/accountHistory"
import type {
  PreviousAccountState,
  PreviousHolding,
} from "../../../src/features/backupPasskey/previousAccountWatcher"

const CENT = 10n ** 16n
const PREVIOUS = `0x${"0a".repeat(32)}`
const ELSEWHERE = `0x${"0b".repeat(32)}`
const main = (amount: bigint): PreviousHolding => ({ kind: "main", amount, dust: CENT })
const savings = (amount: bigint, value?: bigint): PreviousHolding => ({
  kind: "savings",
  amount,
  dust: CENT,
  ...(value === undefined ? {} : { value }),
})
const row = (kind: "main" | "savings", over: { moved?: number; done?: boolean } = {}) => ({
  kind,
  moved: 0,
  ...over,
})
const rotation = (phase: BackupRotationPhase, source = PREVIOUS) =>
  ({
    owner: "0x01",
    phase,
    rotation: { builtOver: { l2Address: source } },
  } as unknown as BackupRotationRecord)
const parked = (
  attention: NonNullable<BackupRotationRecord["attention"]>,
  suspended: BackupRotationPhase,
) => ({ ...rotation("attention"), attention, suspended } as BackupRotationRecord)

const FOUND: PreviousAccountState = {
  address: PREVIOUS,
  holdings: [main(1234n * CENT)],
  signs: true,
  checking: false,
  moving: false,
  refusals: 0,
}
const NOTHING: PreviousAccountState = { signs: false, checking: false, moving: false, refusals: 0 }
const UNCHECKED: PreviousAccountState = { ...NOTHING, address: PREVIOUS, signs: true }
const status = (
  state: Partial<PreviousAccountState>,
  rotations: unknown = [],
  base: PreviousAccountState = FOUND,
) => {
  const history = selectAccountHistory({ ...base, ...state }, undefined, rotations as never)
  if (history.kind !== "rotation") throw new Error("expected the rotation's event")
  return history.status
}

describe("selectAccountHistory", () => {
  it("has no event while neither this session nor an earlier one found a previous account", () => {
    expect(selectAccountHistory(NOTHING, undefined, [])).toEqual({ kind: "none" })
  })

  it("lists the saved earlier address before this session finds it, unchecked", () => {
    expect(selectAccountHistory(NOTHING, PREVIOUS, [])).toEqual({
      kind: "rotation",
      earlier: PREVIOUS,
      status: { kind: "unchecked" },
    })
  })

  it("shows a running move, then a running check, over what the last check found", () => {
    expect(status({ moving: true, checking: true })).toEqual({ kind: "moving", rows: [] })
    expect(status({ checking: true })).toEqual({ kind: "checking" })
  })

  it("lists a running move's balances, the one it is on by its phase", () => {
    const run = (phase?: "preparing" | "confirming") => ({
      rows: [{ kind: "main" as const, moved: 0, ...(phase && { phase }) }, row("savings")],
      approvals: phase ? 1 : 0,
    })
    const rows = (state: string) => [
      { kind: "main", state },
      { kind: "savings", state: "none" },
    ]
    expect(status({ moving: true, run: run() })).toEqual({ kind: "moving", rows: rows("working") })
    expect(status({ moving: true, run: run("preparing") })).toMatchObject({
      rows: rows("preparing"),
    })
    expect(status({ moving: true, run: run("confirming") })).toMatchObject({
      rows: rows("confirming"),
    })
    expect(
      status({
        moving: true,
        run: { rows: [row("main", { done: true }), row("savings")], approvals: 1 },
      }),
    ).toMatchObject({
      rows: [
        { kind: "main", state: "moved" },
        { kind: "savings", state: "working" },
      ],
    })
  })

  it("counts the approvals a running move still asks for, the one being prepared included", () => {
    const forecast = { approvals: 2, upper: false }
    const run = (approvals: number, phase?: "preparing" | "confirming") => ({
      rows: [{ kind: "main" as const, moved: 0, ...(phase && { phase }) }],
      approvals,
    })
    const left = (state: Partial<PreviousAccountState>) =>
      (status({ moving: true, forecast, ...state }) as { left?: unknown }).left
    expect(left({ run: run(0) })).toEqual({ count: 2, upper: false })
    expect(left({ run: run(1, "preparing") })).toEqual({ count: 2, upper: false })
    expect(left({ run: run(1, "confirming") })).toEqual({ count: 1, upper: false })
    expect(left({ run: run(2, "confirming") })).toBeUndefined()
    // More approvals than planned: no count, never a negative one.
    expect(left({ run: run(3, "preparing") })).toBeUndefined()
    expect(left({ run: run(0), forecast: undefined })).toBeUndefined()
    expect(left({ run: run(0), forecast: { approvals: 3, upper: true } })).toEqual({
      count: 3,
      upper: true,
    })
  })

  it("says a transfer from an earlier visit is being finished first", () => {
    const run = { rows: [row("main")], approvals: 0, earlier: true }
    // It belongs to no balance, so none works meanwhile.
    expect(status({ moving: true, run })).toEqual({
      kind: "moving",
      rows: [{ kind: "main", state: "none" }],
      earlier: true,
    })
  })

  it("offers to continue a move that stopped after moving something, with how far it got", () => {
    const stopped = { kind: "stopped" as const }
    const afterMain = { rows: [row("main", { done: true }), row("savings")], approvals: 1 }
    expect(
      status({ holdings: [savings(5n * CENT)], lastResult: stopped, run: afterMain }),
    ).toMatchObject({
      action: "continue",
      rows: [
        { kind: "main", state: "moved" },
        { kind: "savings", state: "none" },
      ],
    })
    const partWay = { rows: [row("main", { moved: 1 })], approvals: 1 }
    expect(status({ lastResult: stopped, run: partWay })).toMatchObject({
      action: "continue",
      rows: [{ kind: "main", state: "partial" }],
    })
    const untouched = { rows: [row("main")], approvals: 0 }
    expect(status({ lastResult: stopped, run: untouched })).toMatchObject({ action: "move" })
  })

  it("keeps a failed move's retry and every no-move note over continue", () => {
    const run = { rows: [row("main", { moved: 1 })], approvals: 2 }
    const failed = { kind: "failed" as const, error: new Error("x") }
    expect(status({ lastResult: failed, run })).toMatchObject({ note: "failed", action: "retry" })
    expect(status({ run, signs: false })).not.toHaveProperty("action")
    expect(status({ run }, "loading")).not.toHaveProperty("action")
    expect(status({ run }, [rotation("rerooted")])).not.toHaveProperty("action")
    expect(status({ run, refusals: 3 })).not.toHaveProperty("action")
  })

  it("passes the planned approvals with the funds found", () => {
    const forecast = { approvals: 2, upper: true }
    expect(status({ forecast })).toMatchObject({ kind: "found", forecast })
    expect(status({})).not.toHaveProperty("forecast")
  })

  it("says the funds moved once a move left nothing, and offers what a move left behind", () => {
    expect(status({ holdings: [main(0n)], moved: true })).toEqual({ kind: "moved" })
    expect(status({ moved: true })).toMatchObject({ kind: "found", action: "move" })
    // A move whose closing read fell short has no holdings to list.
    expect(status({ holdings: undefined, moved: true })).toEqual({ kind: "moved" })
    expect(status({ holdings: [main(0n)], moved: true, claimsIncomplete: true })).toEqual({
      kind: "incomplete",
    })
  })

  it("calls the address empty only once a check read it and claimed all, leaving out dust", () => {
    expect(status({ holdings: [main(CENT - 1n), savings(0n, 0n)] })).toEqual({ kind: "empty" })
    expect(status({ holdings: [], checkFailed: true })).toEqual({ kind: "incomplete" })
    expect(status({ holdings: [], claimsIncomplete: true })).toEqual({ kind: "incomplete" })
    expect(selectAccountHistory(NOTHING, PREVIOUS, [])).toMatchObject({
      status: { kind: "unchecked" },
    })
  })

  it("says funds may wait on a backup session whose check found nothing but couldn't claim", () => {
    const unclaimed = { holdings: [main(0n)], claimsIncomplete: true, signs: false }
    expect(status(unclaimed)).toEqual({ kind: "unclaimed" })
    expect(status({ ...unclaimed, checkFailed: true })).toEqual({ kind: "incomplete" })
  })

  it("keeps funds a failed or short check found, and offers to move them", () => {
    const found = { kind: "found", held: [main(1234n * CENT)], action: "move" }
    expect(status({ checkFailed: true })).toEqual(found)
    expect(status({ claimsIncomplete: true })).toEqual(found)
  })

  it("offers no move on a session signed with the backup passkey", () => {
    expect(status({ signs: false })).toMatchObject({ note: "backupSession" })
    expect(status({ signs: false })).not.toHaveProperty("action")
  })

  it("offers no check or move while this device's rotations are loading or unreadable", () => {
    expect(status({}, "loading", UNCHECKED)).toEqual({ kind: "setupUnread" })
    expect(status({}, "unreadable")).toEqual({ kind: "setupUnread" })
  })

  it("offers no check or move while a rotation of this account still moves its balance", () => {
    for (const phase of ["rerooted", "moved", "installed"] as const) {
      expect(status({}, [rotation(phase)], UNCHECKED)).toEqual({ kind: "settingUp" })
      expect(status({}, [rotation(phase)])).toEqual({ kind: "settingUp" })
    }
    expect(status({}, [parked("move", "rerooted")], UNCHECKED)).toEqual({ kind: "settingUp" })
    expect(selectAccountHistory(NOTHING, PREVIOUS, [rotation("moved")])).toMatchObject({
      status: { kind: "settingUp" },
    })
  })

  it("offers the check and the move once the rotation no longer moves the balance", () => {
    for (const record of [
      rotation("done"),
      rotation("conflict"),
      rotation("recovered"),
      parked("stranded", "done"),
      parked("stranded", "recovered"),
    ]) {
      expect(status({}, [record], UNCHECKED)).toEqual({ kind: "unchecked" })
      expect(status({}, [record])).toMatchObject({ action: "move" })
    }
  })

  it("takes over a damaged rotation's balance, since that rotation never moves on", () => {
    expect(status({}, [parked("corrupt", "rerooted")], UNCHECKED)).toEqual({ kind: "unchecked" })
    expect(status({}, [parked("corrupt", "moved")])).toMatchObject({ action: "move" })
  })

  it("waits for no rotation of another account, nor one that recorded no change", () => {
    const unsigned = { owner: "0x01", phase: "created" } as unknown as BackupRotationRecord
    expect(status({}, [rotation("rerooted", ELSEWHERE)], UNCHECKED)).toEqual({ kind: "unchecked" })
    expect(status({}, [unsigned], UNCHECKED)).toEqual({ kind: "unchecked" })
    expect(status({}, [rotation("done"), rotation("rerooted", ELSEWHERE)])).toMatchObject({
      action: "move",
    })
  })

  it("shows a running move or check over a rotation it waits for", () => {
    expect(status({ moving: true }, [rotation("rerooted")])).toMatchObject({ kind: "moving" })
    expect(status({ checking: true }, "loading")).toEqual({ kind: "checking" })
  })

  it("stops offering a move after three spend refusals, or once the cap leaves no chunk", () => {
    expect(status({ refusals: 3 })).toMatchObject({ note: "stuck" })
    expect(status({ refusals: 1, cap: 0n })).toMatchObject({ note: "stuck" })
  })

  it("offers to try again after a refused or failed move, and to move again after a stop", () => {
    const spend = { kind: "refused" as const, reason: "spend" as const, amount: CENT }
    const destination = { ...spend, reason: "destination" as const }
    expect(status({ lastResult: spend, refusals: 1 })).toMatchObject({
      note: "refused",
      action: "retry",
    })
    expect(status({ lastResult: destination })).toMatchObject({ note: "failed", action: "retry" })
    expect(status({ lastResult: { kind: "failed", error: new Error("x") } })).toMatchObject({
      note: "failed",
    })
    expect(status({ lastResult: { kind: "stopped" } })).toMatchObject({ action: "move" })
  })
})

describe("selectMoveUnfinished", () => {
  const unfinished = (state: Partial<PreviousAccountState>, rotations: unknown = []) =>
    selectMoveUnfinished(
      selectAccountHistory({ ...FOUND, ...state }, undefined, rotations as never),
    )
  const run = { rows: [row("main", { moved: 1 })], approvals: 1 }

  it("holds once a move ended early with funds left that the session can move", () => {
    expect(unfinished({ run, lastResult: { kind: "stopped" } })).toBe(true)
    expect(unfinished({ run, lastResult: { kind: "failed", error: new Error("x") } })).toBe(true)
  })

  it("does not hold for funds no move touched, a running or finished move, or a move the session can't make", () => {
    expect(unfinished({})).toBe(false)
    expect(unfinished({ run, moving: true })).toBe(false)
    expect(unfinished({ holdings: [main(0n)], moved: true })).toBe(false)
    expect(unfinished({ run, signs: false })).toBe(false)
    expect(selectMoveUnfinished(selectAccountHistory(NOTHING, undefined, []))).toBe(false)
  })
})

describe("selectHistoryRow", () => {
  it("names no event, one, or one whose check found funds", () => {
    expect(selectHistoryRow(selectAccountHistory(NOTHING, undefined, []))).toBe("none")
    expect(selectHistoryRow(selectAccountHistory(NOTHING, PREVIOUS, []))).toBe("one")
    expect(selectHistoryRow(selectAccountHistory(FOUND, undefined, []))).toBe("found")
    expect(selectHistoryRow(selectAccountHistory(FOUND, undefined, [rotation("moved")]))).toBe(
      "one",
    )
  })
})

describe("selectHeldTotal", () => {
  it("adds Main's amount to Savings' value, and has none while the shares have no price", () => {
    expect(selectHeldTotal([main(2n * CENT), savings(5n, 3n * CENT)])).toBe(5n * CENT)
    expect(selectHeldTotal([main(2n * CENT), savings(5n)])).toBeUndefined()
  })
})
